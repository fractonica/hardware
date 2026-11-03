// fr.camera (design camera-c1 D7, D8, D10, §10): the core-task commands and timer, and fr_stream's capture loop, its
// mjpg1 POST and its writes to the card. Who touches what is in the header's sections.
#include "fr/services/camera_service.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdio>
#include <cstring>
#include <new>
#include <string_view>
#include <utility>

#include "fr/audio/engine.hpp"
#include "fr/audio/rt.hpp"
#include "fr/ota/http_post.hpp"

namespace fr {
namespace {

using Reason = cap::CameraStreamEndReason;

inline void put_u16le(uint8_t *p, uint16_t v)
{
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
}

inline void put_u32le(uint8_t *p, uint32_t v)
{
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
    p[2] = static_cast<uint8_t>(v >> 16);
    p[3] = static_cast<uint8_t>(v >> 24);
}

/** The settings in one word (the core -> fr_stream atomic): frame_size, quality, flags, brightness/contrast/saturation + 2. */
uint64_t pack(const hal::CameraSettings &s)
{
    return static_cast<uint64_t>(std::to_underlying(s.frame_size)) | static_cast<uint64_t>(s.quality) << 8 |
           static_cast<uint64_t>((s.vflip ? 1 : 0) | (s.hmirror ? 2 : 0)) << 16 |
           static_cast<uint64_t>(static_cast<uint8_t>(s.brightness + 2)) << 24 |
           static_cast<uint64_t>(static_cast<uint8_t>(s.contrast + 2)) << 32 |
           static_cast<uint64_t>(static_cast<uint8_t>(s.saturation + 2)) << 40;
}

hal::CameraSettings unpack(uint64_t w)
{
    hal::CameraSettings s;
    s.frame_size = static_cast<hal::FrameSize>(w & 0xFF);
    s.quality = static_cast<uint8_t>(w >> 8);
    s.vflip = ((w >> 16) & 1) != 0;
    s.hmirror = ((w >> 16) & 2) != 0;
    s.brightness = static_cast<int8_t>(static_cast<int>((w >> 24) & 0xFF) - 2);
    s.contrast = static_cast<int8_t>(static_cast<int>((w >> 32) & 0xFF) - 2);
    s.saturation = static_cast<int8_t>(static_cast<int>((w >> 40) & 0xFF) - 2);
    return s;
}

hal::FrameSize size_of(cap::CameraFrameSize s)
{
    return static_cast<hal::FrameSize>(std::to_underlying(s));  // same values
}

/** The FrameSize of these dimensions, or kFrameSizeUnknown. */
uint8_t frame_size_of(uint16_t width, uint16_t height)
{
    for (uint8_t i = 0; i <= std::to_underlying(hal::FrameSize::uxga); ++i) {
        const hal::FrameDims d = hal::frame_dims(static_cast<hal::FrameSize>(i));
        if (d.width == width && d.height == height) {
            return i;
        }
    }
    return CameraService::kFrameSizeUnknown;
}

/** N of the hub's `{"frames":N}` (or `{"records":N}`); 0 when neither is there. */
uint32_t hub_count(std::string_view body)
{
    size_t key = body.find("\"frames\"");
    if (key == std::string_view::npos) {
        key = body.find("\"records\"");
    }
    if (key == std::string_view::npos) {
        return 0;
    }
    size_t at = body.find(':', key);
    if (at == std::string_view::npos) {
        return 0;
    }
    ++at;
    while (at < body.size() && body[at] == ' ') {
        ++at;
    }
    uint32_t v = 0;
    std::from_chars(body.data() + at, body.data() + body.size(), v);
    return v;
}

}  // namespace

CameraService::CameraService(hal::Camera &cam, hal::BlockStore *store, const cap::CameraConfig &cfg)
    : cam_(cam), store_(store), cfg_(cfg)
{
    static_assert(sizeof(ota::HttpPost) <= sizeof(post_store_) && alignof(ota::HttpPost) <= 8);
    static_assert(kHeadBytes <= ota::HttpPost::kLeadMax, "the head goes out with the chunk's size line");
    new (post_store_) ota::HttpPost(kStallMs);
    settings_.frame_size = size_of(cfg.frame_size);
    settings_.quality = cfg.quality;
    settings_.vflip = cfg.vflip;
    settings_.hmirror = cfg.hmirror;
    settings_.brightness = cfg.brightness;
    settings_.contrast = cfg.contrast;
    settings_.saturation = cfg.saturation;
    applied_ = UINT64_MAX;
}

CameraService::~CameraService()
{
    audio::engine().remove_stream(*this);
    post().~HttpPost();
    if (fetch_buf_ != nullptr) {
        audio::Rt::release(fetch_buf_);
    }
}

ota::HttpPost &CameraService::post()
{
    return *std::launder(reinterpret_cast<ota::HttpPost *>(post_store_));
}

void CameraService::encode_head(uint8_t *out, uint32_t seq, uint32_t index, uint32_t t_us, uint16_t width,
                                uint16_t height, uint8_t quality, uint8_t frame_size, uint16_t flags, uint32_t len)
{
    put_u32le(out, seq);
    put_u32le(out + 4, index);
    put_u32le(out + 8, t_us);
    put_u16le(out + 12, width);
    put_u16le(out + 14, height);
    out[16] = quality;
    out[17] = frame_size;
    put_u16le(out + 18, flags);
    put_u32le(out + 20, len);
}

bool CameraService::jpeg_dims(std::span<const uint8_t> jpeg, uint16_t &width, uint16_t &height)
{
    // Markers after SOI: FF xx, then a big-endian length covering itself; SOF0 (C0) and SOF2 (C2) carry the
    // precision, the height and the width.
    if (jpeg.size() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8) {
        return false;
    }
    size_t at = 2;
    while (at + 4 <= jpeg.size()) {
        if (jpeg[at] != 0xFF) {
            return false;
        }
        const uint8_t marker = jpeg[at + 1];
        if (marker == 0xFF) {
            ++at;  // fill byte
            continue;
        }
        if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) {
            at += 2;  // no length
            continue;
        }
        if (marker == 0xD9 || marker == 0xDA) {
            return false;  // the scan: no frame header came
        }
        const size_t len = static_cast<size_t>(jpeg[at + 2]) << 8 | jpeg[at + 3];
        if (len < 2 || at + 2 + len > jpeg.size()) {
            return false;
        }
        if (marker == 0xC0 || marker == 0xC1 || marker == 0xC2) {
            if (len < 7) {
                return false;
            }
            height = static_cast<uint16_t>(jpeg[at + 5] << 8 | jpeg[at + 6]);
            width = static_cast<uint16_t>(jpeg[at + 7] << 8 | jpeg[at + 8]);
            return true;
        }
        at += 2 + len;
    }
    return false;
}

Status CameraService::init(Core &core)
{
    core_ = &core;
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (auto st = cam_.init(core); !st) {
        return st;
    }
    if (store_ != nullptr && cfg_.sd) {
        // A host fault at the mount (Err::failed, state error) is the driver's log line: the camera runs without its
        // store (design D8: the card is optional), the `sd` property says error.
        static_cast<void>(store_->init(core));
    }
    if (cache_lock_ == nullptr) {
        cache_lock_ = audio::Rt::mutex_create();
        if (cache_lock_ == nullptr) {
            return std::unexpected(Err::failed);
        }
    }
    hal::CameraInit ci;
    ci.max_frame_size = size_of(cfg_.max_frame_size);
    ci.fb_count = cfg_.fb_count;
    ci.xclk_hz = cfg_.xclk_hz;
    ci.settings = settings_;
    if (auto st = cam_.start(ci); !st) {
        return st;
    }
    // applied_ stays UINT64_MAX: the first fr_stream pass applies the kept settings once (the driver writes only what
    // differs from the sensor's state, nothing when start() honoured them all).
    kept_.store(pack(settings_), std::memory_order_release);
    if (!audio::engine().add_stream(*this) || !audio::engine().start_stream()) {
        return std::unexpected(Err::failed);
    }
    inited_.store(true, std::memory_order_release);
    fps_at_ = core.now();
    arm();
    return {};
}

hal::Selftest CameraService::selftest()
{
    if (!inited_.load(std::memory_order_relaxed)) {
        return {false, "camera: not initialised"};
    }
    return cam_.selftest();
}

// ---- core task ----

void CameraService::arm()
{
    timer_->start((streaming_ ? kStreamPollMs : kFpsWindowMs) * 1000);
}

void CameraService::publish_settings()
{
    kept_.store(pack(settings_), std::memory_order_release);
    audio::engine().wake_stream();
}

Status CameraService::begin_job(To to, uint32_t stream_id, uint16_t seconds, uint32_t interval_ms, uint32_t max_frames,
                                uint8_t frame_size, uint8_t quality, uint32_t recording, uint32_t from_frame)
{
    stream::Endpoint ep{};
    stream::StreamHost *host = stream::stream_host();
    const bool has_ep = host != nullptr && host->endpoint(ep) && ep.ipv4 != 0 && ep.port != 0;
    if (host != nullptr) {
        std::snprintf(device_, sizeof(device_), "%s", host->device_id());
    }
    req_id_.store(stream_id, std::memory_order_relaxed);
    req_seconds_.store(seconds, std::memory_order_relaxed);
    req_interval_ms_.store(interval_ms, std::memory_order_relaxed);
    req_max_frames_.store(max_frames, std::memory_order_relaxed);
    req_to_.store(static_cast<uint8_t>(to), std::memory_order_relaxed);
    req_frame_size_.store(frame_size, std::memory_order_relaxed);
    req_quality_.store(quality, std::memory_order_relaxed);
    req_recording_.store(recording, std::memory_order_relaxed);
    req_from_frame_.store(from_frame, std::memory_order_relaxed);
    req_ip_.store(has_ep ? ep.ipv4 : 0, std::memory_order_relaxed);
    req_port_.store(ep.port, std::memory_order_relaxed);
    gen_ = gen_ + 1 == 0 ? 1 : gen_ + 1;
    req_gen_.store(gen_, std::memory_order_release);
    streaming_ = true;
    stream_id_ = stream_id;
    stream_recording_ = to == To::hub ? 0 : recording;
    report_streaming(true);
    arm();
    audio::engine().wake_stream();
    return {};
}

Status CameraService::stream_start(const cap::CameraStreamStartArgs &args)
{
    if (!inited_.load(std::memory_order_relaxed)) {
        return std::unexpected(Err::failed);
    }
    if (streaming_) {
        return std::unexpected(Err::busy);
    }
    const bool card = args.to == cap::CameraTarget::sd || args.to == cap::CameraTarget::both;
    if (card && sd() != cap::CameraCardState::mounted) {
        return std::unexpected(Err::invalid_args);
    }
    if (args.has_frame_size && std::to_underlying(args.frame_size) > std::to_underlying(cfg_.max_frame_size)) {
        return std::unexpected(Err::invalid_args);
    }
    return begin_job(static_cast<To>(std::to_underlying(args.to)), args.stream_id, args.seconds, args.interval_ms,
                     args.max_frames, args.has_frame_size ? std::to_underlying(args.frame_size) : 0xFF,
                     args.has_quality ? args.quality : 0, args.stream_id, 0);
}

Status CameraService::stream_stop(const cap::CameraStreamStopArgs &args)
{
    if (!streaming_ || args.stream_id != stream_id_) {
        return std::unexpected(Err::not_found);
    }
    stop_gen_.store(gen_, std::memory_order_release);
    audio::engine().wake_stream();
    return {};
}

Status CameraService::set(const cap::CameraSetArgs &args)
{
    if (!inited_.load(std::memory_order_relaxed)) {
        return std::unexpected(Err::failed);
    }
    if (args.has_frame_size && std::to_underlying(args.frame_size) > std::to_underlying(cfg_.max_frame_size)) {
        return std::unexpected(Err::invalid_args);
    }
    if (args.has_frame_size) {
        settings_.frame_size = size_of(args.frame_size);
    }
    if (args.has_quality) {
        settings_.quality = args.quality;
    }
    if (args.has_vflip) {
        settings_.vflip = args.vflip;
    }
    if (args.has_hmirror) {
        settings_.hmirror = args.hmirror;
    }
    if (args.has_brightness) {
        settings_.brightness = args.brightness;
    }
    if (args.has_contrast) {
        settings_.contrast = args.contrast;
    }
    if (args.has_saturation) {
        settings_.saturation = args.saturation;
    }
    publish_settings();
    return {};
}

std::expected<cap::CameraSdListResult, Err> CameraService::sd_list(const cap::CameraSdListArgs &args)
{
    if (sd() != cap::CameraCardState::mounted) {
        return std::unexpected(Err::unsupported);
    }
    // From the cache fr_stream keeps (the card is never walked here): a page from `from`, next 0 past the cache's end.
    cap::CameraSdListResult r{};
    const audio::LockGuard g(cache_lock_);
    uint32_t i = args.from;
    for (; i < cache_.count && !r.recordings.full(); ++i) {
        r.recordings.push_back({.id = cache_.recs[i].id, .frames = cache_.recs[i].frames, .bytes = cache_.recs[i].bytes});
    }
    r.next = i < cache_.count ? i : 0;
    return r;
}

bool CameraService::cached(uint32_t id)
{
    const audio::LockGuard g(cache_lock_);
    for (uint32_t i = 0; i < cache_.count; ++i) {
        if (cache_.recs[i].id == id) {
            return true;
        }
    }
    return false;
}

Status CameraService::sd_fetch(const cap::CameraSdFetchArgs &args)
{
    if (sd() != cap::CameraCardState::mounted) {
        return std::unexpected(Err::unsupported);
    }
    if (streaming_ || delete_pending()) {
        return std::unexpected(Err::busy);  // a delete may be of this very recording: it runs first
    }
    if (!cached(args.recording)) {
        return std::unexpected(Err::not_found);  // fr_stream's info() at the stream's begin is the final word
    }
    return begin_job(To::fetch, args.stream_id, 0, 0, 0, 0xFF, 0, args.recording, args.from_frame);
}

Status CameraService::sd_delete(const cap::CameraSdDeleteArgs &args)
{
    if (sd() != cap::CameraCardState::mounted) {
        return std::unexpected(Err::unsupported);
    }
    if ((streaming_ && stream_recording_ == args.recording) || delete_pending()) {
        return std::unexpected(Err::busy);
    }
    // Queued for fr_stream (a walk of the recording: seconds for a long one); OK now, the list and the free space
    // follow when it is done. Idempotent: a recording not there is removed all the same.
    del_id_.store(args.recording, std::memory_order_relaxed);
    del_busy_.store(true, std::memory_order_release);
    audio::engine().wake_stream();
    return {};
}

cap::CameraCardState CameraService::sd() const
{
    if (store_ == nullptr || !cfg_.sd) {
        return cap::CameraCardState::none;
    }
    return static_cast<cap::CameraCardState>(store_->state());  // same values (hal::StoreState)
}

uint32_t CameraService::sd_free_mb() const
{
    return store_ != nullptr && cfg_.sd ? store_->free_mb() : 0;
}

cap::CameraTraits CameraService::traits() const
{
    cap::CameraTraits t{};
    t.sensor = cam_.sensor();
    t.max_frame_size = cfg_.max_frame_size;
    return t;
}

void CameraService::on_timer()
{
    const TimeUs now = core_->now();
    const uint32_t total = frames_total_.load(std::memory_order_acquire);
    if (now - fps_at_ >= static_cast<TimeUs>(kFpsWindowMs) * 1000) {
        const auto fps = static_cast<uint16_t>(
            std::min<int64_t>(UINT16_MAX, static_cast<int64_t>(total - fps_frames_) * 10'000'000 / (now - fps_at_)));
        fps_at_ = now;
        fps_frames_ = total;
        if (fps != fps_x10_) {
            fps_x10_ = fps;
            report_fps_x10(fps_x10_);
        }
    }
    if (total != frames_) {
        frames_ = total;
        report_frames(frames_);
    }
    const uint32_t lb = last_bytes_a_.load(std::memory_order_relaxed);
    if (lb != last_bytes_) {
        last_bytes_ = lb;
        report_last_bytes(last_bytes_);
    }
    if (streaming_ && end_gen_.load(std::memory_order_acquire) == gen_) {
        streaming_ = false;
        stream_recording_ = 0;
        emit_stream_ended({.stream_id = stream_id_,
                           .reason = static_cast<Reason>(end_reason_.load(std::memory_order_relaxed)),
                           .frames = end_frames_.load(std::memory_order_relaxed),
                           .dropped = end_dropped_.load(std::memory_order_relaxed),
                           .bytes = end_bytes_.load(std::memory_order_relaxed)});
        report_streaming(false);
    }
    const auto card = static_cast<uint8_t>(sd());
    if (card != sd_reported_) {
        sd_reported_ = card;
        report_sd(sd());
    }
    const uint32_t free_mb = sd_free_mb();
    if (free_mb != sd_free_reported_) {
        sd_free_reported_ = free_mb;
        report_sd_free_mb(free_mb);
    }
    arm();
}

// ---- fr_stream ----

bool CameraService::stream_pass()
{
    if (!inited_.load(std::memory_order_acquire)) {
        return false;
    }
    const TimeUs now = core_->now();
    bool did = false;
    if (!cache_fresh_) {
        refresh_cache();  // the first pass: what the card holds from before this boot
        did = true;
    }
    if (st_ == StreamState::idle && del_busy_.load(std::memory_order_acquire)) {
        // Only between streams (a walk of seconds would starve a running one), and before a stream asked for after
        // it, in the order the commands came (the core refused a delete of a running stream's recording).
        run_delete();
        did = true;
    }
    if (st_ == StreamState::idle) {
        const uint32_t g = req_gen_.load(std::memory_order_acquire);
        if (g != st_gen_) {
            begin_stream(g, now);
            did = true;
        }
    }
    did = apply_settings() || did;
    if (st_ == StreamState::connecting) {
        did = connect_step(now) || did;
    } else if (st_ == StreamState::streaming) {
        did = stream_step(now) || did;
    }
    return did;
}

bool CameraService::apply_settings()
{
    // The kept settings, with the running stream's own frame_size / quality over them; only a change reaches the sensor.
    uint64_t want = kept_.load(std::memory_order_acquire);
    if (st_ != StreamState::idle && to_ != To::fetch) {
        if (override_frame_size_ != 0xFF) {
            want = (want & ~uint64_t{0xFF}) | override_frame_size_;
        }
        if (override_quality_ != 0) {
            want = (want & ~(uint64_t{0xFF} << 8)) | static_cast<uint64_t>(override_quality_) << 8;
        }
    }
    if (want == applied_) {
        return false;
    }
    if (cam_.set(unpack(want))) {
        applied_ = want;
        set_fails_ = 0;
        return true;
    }
    // The sensor refused a write: the driver kept the refused fields as unapplied, so the same call goes again on the
    // next passes; after kSetRetries in a row the wish is taken as applied (a sensor that will not take it is not
    // written to for ever) until the next `set` or stream changes it.
    if (++set_fails_ >= kSetRetries) {
        applied_ = want;
        set_fails_ = 0;
    }
    return true;
}

void CameraService::refresh_cache()
{
    // The card walked into staging_ (no lock: the core may be answering sd_list meanwhile), then swapped in.
    cache_fresh_ = true;
    staging_.count = 0;
    if (store_ != nullptr && cfg_.sd && store_->mounted()) {
        uint32_t from = 0;
        for (;;) {
            uint32_t count = 0;
            uint32_t next = 0;
            const std::span<hal::Recording> room(staging_.recs.data() + staging_.count, kListCacheMax - staging_.count);
            if (room.empty() || !store_->list(from, room, count, next)) {
                break;
            }
            staging_.count += count;
            if (next == 0 || count == 0) {
                break;
            }
            from = next;
        }
    }
    const audio::LockGuard g(cache_lock_);
    cache_ = staging_;
}

void CameraService::run_delete()
{
    const uint32_t id = del_id_.load(std::memory_order_relaxed);
    if (store_ != nullptr) {
        static_cast<void>(store_->remove(id));  // OK when already gone; a failure leaves what it left, listed
    }
    refresh_cache();
    del_busy_.store(false, std::memory_order_release);
}

void CameraService::add_bytes(uint32_t n)
{
    bytes_ = n > UINT32_MAX - bytes_ ? UINT32_MAX : bytes_ + n;
}

void CameraService::close_card()
{
    if (card_open_) {
        static_cast<void>(store_->close_recording());  // what the card holds stays listed (design D8)
        card_open_ = false;
        refresh_cache();  // the list names it from here
    }
}

void CameraService::begin_stream(uint32_t gen, TimeUs now)
{
    st_gen_ = gen;
    seq_ = 0;
    index_ = 0;
    dropped_ = 0;
    bytes_ = 0;
    frames_sent_ = 0;
    card_index_ = 0;
    finishing_ = false;
    answering_ = false;
    sending_ = false;
    have_frame_ = false;
    card_open_ = false;
    to_ = static_cast<To>(req_to_.load(std::memory_order_relaxed));
    recording_ = req_recording_.load(std::memory_order_relaxed);
    fetch_index_ = req_from_frame_.load(std::memory_order_relaxed);
    interval_us_ = static_cast<TimeUs>(req_interval_ms_.load(std::memory_order_relaxed)) * 1000;
    max_frames_ = req_max_frames_.load(std::memory_order_relaxed);
    override_frame_size_ = req_frame_size_.load(std::memory_order_relaxed);
    override_quality_ = req_quality_.load(std::memory_order_relaxed);
    const uint32_t seconds = req_seconds_.load(std::memory_order_relaxed);
    deadline_ = seconds > 0 ? now + static_cast<TimeUs>(seconds) * 1'000'000 : 0;
    next_at_ = now;
    last_frame_at_ = now;
    first_slot_ = true;
    st_ = StreamState::streaming;  // the card-only case; the hub cases move to connecting below
    if (to_ == To::fetch) {
        hal::Recording rec;
        if (store_ == nullptr || !store_->info(recording_, rec)) {
            publish_end(Reason::error);  // gone since the cache named it (the command's NOT_FOUND came from the cache)
            return;
        }
        if (fetch_buf_ == nullptr) {
            fetch_buf_ = static_cast<uint8_t *>(audio::Rt::alloc(kFrameMaxBytes));
        }
        if (fetch_buf_ == nullptr) {
            publish_end(Reason::error);  // no heap for a frame
            return;
        }
    }
    if (needs_card()) {
        if (store_ == nullptr || !store_->open_recording(recording_)) {
            publish_end(Reason::overflow);  // the card refused the recording
            return;
        }
        card_open_ = true;
    }
    if (needs_hub()) {
        const uint32_t ip = req_ip_.load(std::memory_order_relaxed);
        char host[16];
        stream::format_ipv4(ip, host, sizeof(host));
        char path[40];
        std::snprintf(path, sizeof(path), "/v1/stream/in/%u", static_cast<unsigned>(req_id_.load(std::memory_order_relaxed)));
        char headers[96];
        std::snprintf(headers, sizeof(headers), "X-Fr-Device: %s\r\nX-Fr-Kind: jpeg\r\nX-Fr-Format: mjpg1\r\n", device_);
        if (ip == 0 || !post().begin_start(host, static_cast<uint16_t>(req_port_.load(std::memory_order_relaxed)), path,
                                           headers)) {
            abort_stream(Reason::net_lost);  // no session, or a connect that cannot begin: nothing connected
            return;
        }
        st_ = StreamState::connecting;  // connect_step() from the next pass on
    }
}

bool CameraService::connect_step(TimeUs now)
{
    // The connect and the head, a slice at a time.
    const auto up = post().pump(kSendSliceMs);
    if (!up) {
        abort_stream(Reason::net_lost);  // refused, or not up in kStallMs
        return true;
    }
    if (*up) {
        st_ = StreamState::streaming;
        next_at_ = now;  // the first slot: once connected (re-based on the first frame's start)
        last_frame_at_ = now;
    }
    return true;
}

void CameraService::finish(Reason why)
{
    finishing_ = true;
    finish_reason_ = why;
}

bool CameraService::stream_step(TimeUs now)
{
    if (answering_) {
        return answer_step();
    }
    if (sending_) {
        // The frame's chunk, a slice at a time: one that has not gone in kStallMs in all fails here.
        const auto done = post().pump(kSendSliceMs);
        if (!done) {
            abort_stream(Reason::net_lost);
            return true;
        }
        if (!*done) {
            return true;
        }
        sending_ = false;
        ++seq_;
        ++frames_sent_;
        if (!needs_card()) {
            add_bytes(frame_len_);  // a `both` frame was counted when written
        }
        drop_frame();
        return true;
    }
    if (!finishing_) {
        if (stop_gen_.load(std::memory_order_acquire) == st_gen_) {
            finish(Reason::stopped);
        } else if (deadline_ != 0 && now >= deadline_) {
            finish(Reason::done);
        } else if (max_frames_ != 0 && index_ >= max_frames_) {
            finish(Reason::done);
        }
    }
    if (finishing_) {
        return end_step();
    }
    if (needs_hub() && post().answered()) {
        last_status_.store(post().status(), std::memory_order_relaxed);
        abort_stream(Reason::net_lost);  // the hub refused (or went away) before the end
        return true;
    }
    if (interval_us_ > 0 && now < next_at_) {
        return false;  // the next slot is not here yet
    }
    return take_frame(now);
}

bool CameraService::take_frame(TimeUs now)
{
    uint32_t head_index = index_;
    uint16_t flags = 0;
    uint8_t quality = 0;
    uint8_t frame_size = kFrameSizeUnknown;
    if (to_ == To::fetch) {
        uint32_t len = 0;
        const Status st = store_->read_frame(recording_, fetch_index_, {fetch_buf_, kFrameMaxBytes}, len);
        if (!st) {
            finish(st.error() == Err::not_found ? Reason::done : Reason::error);  // past the last frame, or the card
            return true;
        }
        frame_.jpeg = {fetch_buf_, len};
        frame_.width = 0;
        frame_.height = 0;
        if (!jpeg_dims(frame_.jpeg, frame_.width, frame_.height)) {
            frame_.width = frame_.height = 0;
        }
        frame_.t_us = static_cast<uint32_t>(now);
        frame_.handle = nullptr;
        head_index = fetch_index_++;
        flags = kFlagFromCard;
        frame_size = frame_size_of(frame_.width, frame_.height);
    } else {
        if (interval_us_ > 0) {
            if (first_slot_) {
                next_at_ = now;  // the slots run from the first frame's start (not from the connect)
                first_slot_ = false;
            }
            // The slots that went by while the path was busy with the previous frame: dropped, their indices skipped.
            uint32_t missed = static_cast<uint32_t>((now - next_at_) / interval_us_);
            if (max_frames_ != 0 && index_ + missed >= max_frames_) {
                missed = max_frames_ - index_;
                dropped_ += missed;
                index_ = max_frames_;
                finish(Reason::done);
                return true;
            }
            dropped_ += missed;
            index_ += missed;
            next_at_ += static_cast<TimeUs>(missed + 1) * interval_us_;
            head_index = index_;
        }
        const Status st = cam_.grab(frame_, kGrabTimeoutMs);
        if (!st) {
            // Nothing came in time, or the sensor failed: the next pass tries again. Starved, not dropped (with
            // interval_ms the slot it misses is dropped when the next frame comes); none for kNoFrameMs ends it.
            starved_.fetch_add(1, std::memory_order_relaxed);
            const TimeUs at = core_->now();
            if (at - last_frame_at_ >= static_cast<TimeUs>(kNoFrameMs) * 1000) {
                abort_stream(Reason::error);
            }
            return true;
        }
        last_frame_at_ = core_->now();
        frames_total_.fetch_add(1, std::memory_order_release);
        if (frame_.jpeg.size() > kFrameMaxBytes) {
            cam_.release(frame_);
            ++dropped_;
            ++index_;
            return true;
        }
        const hal::CameraSettings s = unpack(applied_);
        quality = s.quality;
        // The frame's own dimensions (its SOF0): a frame captured before a `set frame_size` took effect on the sensor
        // keeps the size it has, whatever the sensor (and the driver's Frame) reports now; the applied size stands in
        // only when the markers are not there.
        uint16_t w = 0;
        uint16_t h = 0;
        if (jpeg_dims(frame_.jpeg, w, h)) {
            frame_.width = w;
            frame_.height = h;
            frame_size = frame_size_of(w, h);
        } else {
            const hal::FrameDims d = hal::frame_dims(s.frame_size);
            frame_.width = d.width;
            frame_.height = d.height;
            frame_size = std::to_underlying(s.frame_size);
        }
    }
    have_frame_ = true;
    frame_len_ = static_cast<uint32_t>(frame_.jpeg.size());
    last_bytes_a_.store(frame_len_, std::memory_order_relaxed);
    ++index_;
    if (needs_card()) {
        if (!store_->write_frame(card_index_, frame_.jpeg)) {
            abort_stream(Reason::overflow);  // the card is full or failed
            return true;
        }
        ++card_index_;
        add_bytes(frame_len_);
    }
    if (needs_hub()) {
        encode_head(head_, seq_, head_index, frame_.t_us, frame_.width, frame_.height, quality, frame_size, flags,
                    frame_len_);
        if (!post().begin_chunk({head_, kHeadBytes}, frame_.jpeg)) {
            if (!needs_card()) {
                ++dropped_;  // taken, never sent, nowhere else (a `both` frame is on the card)
            }
            abort_stream(Reason::net_lost);
            return true;
        }
        sending_ = true;  // the frame's buffer stays until the chunk has gone
    } else {
        drop_frame();
    }
    return true;
}

bool CameraService::end_step()
{
    close_card();
    if (!needs_hub()) {
        publish_end(finish_reason_);
        return true;
    }
    answering_ = true;
    if (!post().begin_finish()) {
        publish_end(Reason::net_lost);
        return true;
    }
    return answer_step();
}

bool CameraService::answer_step()
{
    // The zero-length chunk and the hub's answer, a slice at a time (it may take a while to close its files).
    const auto in = post().pump_answer(kSendSliceMs);
    if (in && !*in) {
        return true;
    }
    last_status_.store(post().status(), std::memory_order_relaxed);
    hub_frames_.store(hub_count(post().body()), std::memory_order_relaxed);
    publish_end(in && post().status() == 200 ? finish_reason_ : Reason::net_lost);
    return true;
}

void CameraService::drop_frame()
{
    if (have_frame_ && to_ != To::fetch) {
        cam_.release(frame_);
    }
    have_frame_ = false;
    frame_ = {};
}

void CameraService::abort_stream(Reason why)
{
    post().close();
    if (have_frame_) {
        if (sending_ && !needs_card()) {
            ++dropped_;  // taken, never sent, nowhere else
        }
        drop_frame();
    }
    sending_ = false;
    close_card();
    publish_end(why);
}

void CameraService::publish_end(Reason why)
{
    if (fetch_buf_ != nullptr) {
        audio::Rt::release(fetch_buf_);  // back to the heap between fetches
        fetch_buf_ = nullptr;
    }
    override_frame_size_ = 0xFF;
    override_quality_ = 0;
    end_reason_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    end_frames_.store(index_, std::memory_order_relaxed);
    end_dropped_.store(dropped_, std::memory_order_relaxed);
    end_bytes_.store(bytes_, std::memory_order_relaxed);
    end_gen_.store(st_gen_, std::memory_order_release);
    st_ = StreamState::idle;
    finishing_ = false;
    answering_ = false;
    sending_ = false;
}

}  // namespace fr
