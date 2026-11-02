// fr.csi (design csi-c1 D7, D8, D10, D11, §12): the core-task commands and timer, the Wi-Fi task's copy into the
// ring, and fr_stream's features and POST. Who touches what is in the header's sections.
#include "fr/services/csi_service.hpp"

#include <algorithm>
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

using Reason = cap::CsiStreamEndReason;

/** N of the hub's `{"records":N}`; 0 when it is not there. */
uint32_t hub_records(std::string_view body)
{
    const size_t key = body.find("\"records\"");
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

hal::CsiMode mode_of(cap::CsiSourceMode m)
{
    return static_cast<hal::CsiMode>(std::to_underlying(m));
}

bool same(const hal::CsiCapture &a, const hal::CsiCapture &b)
{
    return a.mode == b.mode && a.rate_hz == b.rate_hz && a.format == b.format && a.has_peer == b.has_peer &&
           (!a.has_peer || a.peer == b.peer);
}

}  // namespace

CsiService::CsiService(hal::CsiSource &src, const cap::CsiConfig &cfg) : src_(src), cfg_(cfg)
{
    static_assert(sizeof(ota::HttpPost) <= sizeof(post_store_) && alignof(ota::HttpPost) <= 8);
    new (post_store_) ota::HttpPost(kStallMs);
}

CsiService::~CsiService()
{
    audio::engine().remove_stream(*this);
    post().~HttpPost();
    free_blocks();
    if (mem_ != nullptr) {
        audio::Rt::release(mem_);
    }
}

ota::HttpPost &CsiService::post()
{
    return *std::launder(reinterpret_cast<ota::HttpPost *>(post_store_));
}

Status CsiService::init(Core &core)
{
    core_ = &core;
    const uint8_t hz = std::clamp<uint8_t>(cfg_.features_hz, 1, 20);
    window_us_ = 1'000'000 / hz;
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    mem_ = static_cast<uint8_t *>(audio::Rt::alloc(kRingBytes));
    if (mem_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    win_start_ = core.now();
    ring_.bind(mem_, kRingBytes);  // before the source can call on_csi
    if (auto st = src_.init(core, *this); !st) {
        return st;
    }
    if (!audio::engine().add_stream(*this) || !audio::engine().start_stream()) {
        return std::unexpected(Err::failed);
    }
    hal::CsiCapture c;
    if (config_capture(c)) {
        static_cast<void>(apply(c));  // a refusal leaves the properties at 0; a stream may still name its own
    }
    ready_ = true;
    timer_->start(static_cast<uint32_t>(window_us_));
    return {};
}

hal::Selftest CsiService::selftest()
{
    if (!ready_) {
        return {false, "csi: not initialised"};
    }
    return src_.selftest();
}

// ---- core task ----

bool CsiService::config_capture(hal::CsiCapture &out) const
{
    out = {};
    out.mode = mode_of(cfg_.source);
    out.rate_hz = cfg_.rate_hz;
    out.format = static_cast<hal::CsiFormat>(std::to_underlying(cfg_.format));
    if (cfg_.peer_mac.size() == out.peer.size()) {
        std::copy(cfg_.peer_mac.begin(), cfg_.peer_mac.end(), out.peer.begin());
        out.has_peer = true;
    }
    return out.mode != hal::CsiMode::peer || out.has_peer;
}

Status CsiService::apply(const hal::CsiCapture &c)
{
    if (capturing_ && same(c, cur_)) {
        return {};
    }
    if (auto st = src_.capture(c); !st) {
        return st;
    }
    if (capturing_ && (c.mode != cur_.mode || c.peer != cur_.peer)) {
        reset_req_.fetch_add(1, std::memory_order_release);  // other paths: the baseline starts over
    }
    cur_ = c;
    capturing_ = true;
    return {};
}

Status CsiService::stream_start(const cap::CsiStreamStartArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (streaming_) {
        return std::unexpected(Err::busy);
    }
    hal::CsiCapture want;
    config_capture(want);
    if (args.has_source) {
        want.mode = mode_of(args.source);
    }
    if (args.has_peer_mac) {
        if (args.peer_mac.size() != want.peer.size()) {
            return std::unexpected(Err::invalid_args);
        }
        std::copy(args.peer_mac.begin(), args.peer_mac.end(), want.peer.begin());
        want.has_peer = true;
    }
    if (want.mode == hal::CsiMode::peer && !want.has_peer) {
        return std::unexpected(Err::invalid_args);
    }
    hal::CsiCapture base;
    const bool from_config = config_capture(base) && same(base, want);
    if (auto st = apply(want); !st) {
        return st;
    }
    overridden_ = !from_config;
    stream::Endpoint ep{};
    stream::StreamHost *host = stream::stream_host();
    const bool has_ep = host != nullptr && host->endpoint(ep) && ep.ipv4 != 0 && ep.port != 0;
    if (host != nullptr) {
        std::snprintf(device_, sizeof(device_), "%s", host->device_id());
    }
    req_id_.store(args.stream_id, std::memory_order_relaxed);
    req_seconds_.store(args.seconds, std::memory_order_relaxed);
    req_ip_.store(has_ep ? ep.ipv4 : 0, std::memory_order_relaxed);
    req_port_.store(ep.port, std::memory_order_relaxed);
    gen_ = gen_ + 1 == 0 ? 1 : gen_ + 1;
    req_gen_.store(gen_, std::memory_order_release);
    streaming_ = true;
    stream_id_ = args.stream_id;
    arm();
    audio::engine().wake_stream();
    return {};
}

Status CsiService::stream_stop(const cap::CsiStreamStopArgs &args)
{
    if (!streaming_ || args.stream_id != stream_id_) {
        return std::unexpected(Err::not_found);
    }
    stop_gen_.store(gen_, std::memory_order_release);
    audio::engine().wake_stream();
    return {};
}

Status CsiService::baseline_reset()
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    reset_req_.fetch_add(1, std::memory_order_release);
    return {};
}

void CsiService::arm()
{
    const uint32_t period = static_cast<uint32_t>(streaming_ ? std::min<TimeUs>(window_us_, kStreamPollUs) : window_us_);
    timer_->start(period);
}

void CsiService::on_timer()
{
    const uint32_t seq = win_seq_.load(std::memory_order_acquire);
    if (seq != win_seen_) {
        win_seen_ = seq;
        const TimeUs now = core_->now();
        // motion: a move past the deadband at once, a smaller one at most every kSlowUs, the same value never again.
        motion_ = win_motion_.load(std::memory_order_relaxed);
        const auto moved = static_cast<uint16_t>(motion_ > motion_sent_ ? motion_ - motion_sent_ : motion_sent_ - motion_);
        if (!motion_reported_ || moved > kMotionDeadband || (moved != 0 && now - motion_at_ >= kSlowUs)) {
            motion_reported_ = true;
            motion_sent_ = motion_;
            motion_at_ = now;
            report_motion(motion_);
        }
        const int8_t rssi = win_rssi_.load(std::memory_order_relaxed);
        const uint16_t rate = win_rate_.load(std::memory_order_relaxed);
        // rssi and rate: on change, at most every kSlowUs.
        if ((rssi != rssi_ || rate != rate_) && now - last_slow_ >= kSlowUs) {
            last_slow_ = now;
            if (rssi != rssi_) {
                rssi_ = rssi;
                report_rssi(rssi_);
            }
            if (rate != rate_) {
                rate_ = rate;
                report_rate(rate_);
            }
        }
    }
    if (streaming_ && end_gen_.load(std::memory_order_acquire) == gen_) {
        streaming_ = false;
        emit_stream_ended({.stream_id = stream_id_,
                           .reason = static_cast<Reason>(end_reason_.load(std::memory_order_relaxed)),
                           .records = end_records_.load(std::memory_order_relaxed),
                           .dropped = end_dropped_.load(std::memory_order_relaxed)});
        if (overridden_) {
            // The stream's own source ends with it (design §12): back to the config's (none: the stream's stays off).
            overridden_ = false;
            hal::CsiCapture c;
            if (config_capture(c)) {
                static_cast<void>(apply(c));
            } else if (capturing_) {
                static_cast<void>(src_.stop());
                capturing_ = false;
            }
        }
    }
    arm();
}

// ---- Wi-Fi task ----

void CsiService::on_csi(const hal::CsiRecord &r)
{
    static_cast<void>(ring_.push(r));  // full: dropped and counted, the stream sees the gap
}

// ---- fr_stream ----

bool CsiService::stream_pass()
{
    if (!ring_.bound()) {
        return false;
    }
    const TimeUs now = core_->now();
    bool did = false;
    if (st_ == StreamState::idle) {
        const uint32_t g = req_gen_.load(std::memory_order_acquire);
        if (g != st_gen_) {
            begin_stream(g, now);
            did = true;
        }
    }
    const uint32_t r = reset_req_.load(std::memory_order_acquire);
    if (r != reset_seen_) {
        reset_seen_ = r;
        motion_calc_.reset();
    }
    csi::RecordRing::View v;
    for (size_t i = 0; i < kPerPass && ring_.peek(v); ++i) {
        consume(v, now);
        ring_.pop();
        did = true;
    }
    did = close_window(now) || did;
    if (st_ == StreamState::connecting) {
        did = connect_step() || did;
    } else if (st_ == StreamState::streaming) {
        did = stream_step(now) || did;
    }
    return did;
}

void CsiService::consume(const csi::RecordRing::View &v, TimeUs now)
{
    if (v.wire.size() < csi::kRecordHeadBytes) {
        return;
    }
    const uint8_t *w = v.wire.data();
    const auto *data = reinterpret_cast<const int8_t *>(w + csi::kRecordHeadBytes);
    const size_t len = std::min<size_t>(csi::get_u16le(w), v.wire.size() - csi::kRecordHeadBytes);
    ++win_count_;
    win_rssi_sum_ += static_cast<int8_t>(w[6]);
    motion_calc_.add({data, len}, (w[10] & hal::kCsiFlagFirstWordInvalid) != 0, rate_now_);
    if (st_ == StreamState::streaming) {
        const uint32_t index = v.seq - base_;
        if (static_cast<int32_t>(index) >= 0 && (!finishing_ || index < end_index_)) {
            append(v, now);
        }
    }
}

bool CsiService::close_window(TimeUs now)
{
    if (now - win_start_ < window_us_) {
        return false;
    }
    win_start_ = now - std::min<TimeUs>(now - win_start_ - window_us_, window_us_);  // late passes do not drift
    const size_t windows = std::max<size_t>(1, static_cast<size_t>(1'000'000 / window_us_));
    rate_now_ -= rate_hist_[rate_at_];
    rate_hist_[rate_at_] = static_cast<uint16_t>(std::min<uint32_t>(win_count_, UINT16_MAX));
    rate_now_ += rate_hist_[rate_at_];
    rate_at_ = (rate_at_ + 1) % std::min(windows, rate_hist_.size());
    if (win_count_ > 0) {
        last_rssi_ = static_cast<int8_t>(win_rssi_sum_ / static_cast<int32_t>(win_count_));
    }
    win_motion_.store(motion_calc_.close(), std::memory_order_relaxed);
    win_rssi_.store(last_rssi_, std::memory_order_relaxed);
    win_rate_.store(static_cast<uint16_t>(std::min<uint32_t>(rate_now_, UINT16_MAX)), std::memory_order_relaxed);
    win_seq_.fetch_add(1, std::memory_order_release);
    win_count_ = 0;
    win_rssi_sum_ = 0;
    return true;
}

void CsiService::begin_stream(uint32_t gen, TimeUs now)
{
    st_gen_ = gen;
    seq_ = 0;
    sent_end_ = 0;
    sent_records_ = 0;
    finishing_ = false;
    answering_ = false;
    for (Block &b : blocks_) {
        b.slot = Slot::free;
        b.len = 0;
    }
    const uint32_t seconds = req_seconds_.load(std::memory_order_relaxed);
    deadline_ = seconds > 0 ? now + static_cast<TimeUs>(seconds) * 1'000'000 : 0;
    const uint32_t ip = req_ip_.load(std::memory_order_relaxed);
    if (ip == 0) {
        publish_end(Reason::net_lost, 0, 0);
        return;
    }
    if (!alloc_blocks()) {
        publish_end(Reason::error, 0, 0);  // no heap for the blocks: nothing connected
        return;
    }
    char host[16];
    stream::format_ipv4(ip, host, sizeof(host));
    char path[40];
    std::snprintf(path, sizeof(path), "/v1/stream/in/%u", static_cast<unsigned>(req_id_.load(std::memory_order_relaxed)));
    char headers[96];
    std::snprintf(headers, sizeof(headers), "X-Fr-Device: %s\r\nX-Fr-Kind: csi\r\nX-Fr-Format: csi1\r\n", device_);
    if (!post().begin_start(host, static_cast<uint16_t>(req_port_.load(std::memory_order_relaxed)), path, headers)) {
        publish_end(Reason::net_lost, 0, 0);
        return;
    }
    st_ = StreamState::connecting;  // connect_step() from the next pass on
}

bool CsiService::connect_step()
{
    // The connect and the head, a slice at a time (a hub slow to take it does not hold the features up).
    const auto up = post().pump(kSendSliceMs);
    if (!up) {
        publish_end(Reason::net_lost, 0, 0);  // refused, or not up in kStallMs: nothing connected
        return true;
    }
    if (*up) {
        // Index 0 is the first record offered once connected: the ones queued meanwhile are older.
        base_ = ring_.offered();
        st_ = StreamState::streaming;
    }
    return true;
}

CsiService::Block *CsiService::slot(Slot s)
{
    Block *best = nullptr;
    for (Block &b : blocks_) {
        if (b.slot == s && (best == nullptr || static_cast<int32_t>(b.order - best->order) < 0)) {
            best = &b;
        }
    }
    return best;
}

void CsiService::close_block(Block &b)
{
    b.slot = Slot::closed;
    b.order = ++order_;
}

void CsiService::append(const csi::RecordRing::View &v, TimeUs now)
{
    Block *b = slot(Slot::filling);
    if (b != nullptr && b->len + v.wire.size() > kBlockBytes) {
        close_block(*b);
        b = nullptr;
    }
    if (b == nullptr) {
        b = slot(Slot::free);
        if (b == nullptr) {
            return;  // both buffers taken (one in flight, one closed): a gap in the index, counted at the end
        }
        b->slot = Slot::filling;
        b->len = csi::kBlockHeadBytes;
        b->first = v.seq - base_;
        b->count = 0;
        b->opened = now;
    }
    std::memcpy(b->mem + b->len, v.wire.data(), v.wire.size());
    b->len += v.wire.size();
    ++b->count;
    b->end = v.seq - base_ + 1;
}

void CsiService::finish(Reason why)
{
    finishing_ = true;
    finish_reason_ = why;
    end_index_ = ring_.offered() - base_;  // the records offered until now belong to the stream, no later one
}

bool CsiService::stream_step(TimeUs now)
{
    if (answering_) {
        return answer_step();
    }
    if (!finishing_) {
        if (stop_gen_.load(std::memory_order_acquire) == st_gen_) {
            finish(Reason::stopped);
        } else if (deadline_ != 0 && now >= deadline_) {
            finish(Reason::done);
        }
    }
    Block *filling = slot(Slot::filling);
    if (filling != nullptr && (now - filling->opened >= static_cast<TimeUs>(csi::kBlockMs) * 1000 || finishing_)) {
        bool more = false;
        if (finishing_) {
            // Records of the stream still in the ring go in first (the next pass takes them).
            csi::RecordRing::View v;
            more = ring_.peek(v) && v.seq - base_ < end_index_;
        }
        if (!more) {
            close_block(*filling);
        }
    }
    if (Block *b = slot(Slot::sending); b != nullptr) {
        // The block in flight, a slice at a time: one that has not gone in kStallMs in all fails here.
        const auto done = post().pump(kSendSliceMs);
        if (!done) {
            abort_stream(Reason::net_lost, true);
            return true;
        }
        if (!*done) {
            return true;
        }
        b->slot = Slot::free;
        ++seq_;
        sent_end_ = b->end;
        sent_records_ += b->count;
        return true;
    }
    if (post().answered()) {
        last_status_.store(post().status(), std::memory_order_relaxed);
        abort_stream(Reason::net_lost, true);  // the hub refused (or went away) before the end
        return true;
    }
    if (Block *b = slot(Slot::closed); b != nullptr) {
        csi::encode_block_head(b->mem, seq_, b->first);
        if (!post().begin_chunk({}, {b->mem, b->len})) {
            abort_stream(Reason::net_lost, true);
            return true;
        }
        b->slot = Slot::sending;
        return true;
    }
    if (!finishing_ || slot(Slot::filling) != nullptr) {
        return false;
    }
    csi::RecordRing::View v;
    if (ring_.peek(v) && v.seq - base_ < end_index_) {
        return true;  // the next pass takes it
    }
    answering_ = true;
    if (!post().begin_finish()) {
        publish_end(Reason::net_lost, end_index_, end_index_ - std::min(sent_records_, end_index_));
        return true;
    }
    return answer_step();
}

bool CsiService::answer_step()
{
    // The zero-length chunk and the hub's answer, a slice at a time (it may take a while to close its file).
    const auto in = post().pump_answer(kSendSliceMs);
    if (in && !*in) {
        return true;
    }
    last_status_.store(post().status(), std::memory_order_relaxed);
    hub_records_.store(hub_records(post().body()), std::memory_order_relaxed);
    const Reason why = in && post().status() == 200 ? finish_reason_ : Reason::net_lost;
    publish_end(why, end_index_, end_index_ - std::min(sent_records_, end_index_));
    return true;
}

void CsiService::abort_stream(Reason why, bool connected)
{
    post().close();
    for (Block &b : blocks_) {
        b.slot = Slot::free;
    }
    const uint32_t records = connected ? sent_end_ : 0;
    publish_end(why, records, records - std::min(sent_records_, records));
}

bool CsiService::alloc_blocks()
{
    if (block_mem_ == nullptr) {
        block_mem_ = static_cast<uint8_t *>(audio::Rt::alloc(blocks_.size() * kBlockBytes));
    }
    for (size_t i = 0; i < blocks_.size(); ++i) {
        blocks_[i].mem = block_mem_ == nullptr ? nullptr : block_mem_ + i * kBlockBytes;
    }
    return block_mem_ != nullptr;
}

void CsiService::free_blocks()
{
    for (Block &b : blocks_) {
        b.mem = nullptr;
        b.slot = Slot::free;
    }
    if (block_mem_ != nullptr) {
        audio::Rt::release(block_mem_);
        block_mem_ = nullptr;
    }
}

void CsiService::publish_end(Reason why, uint32_t records, uint32_t dropped)
{
    free_blocks();  // back to the heap between streams
    end_reason_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    end_records_.store(records, std::memory_order_relaxed);
    end_dropped_.store(dropped, std::memory_order_relaxed);
    end_gen_.store(st_gen_, std::memory_order_release);
    st_ = StreamState::idle;
    finishing_ = false;
    answering_ = false;
}

}  // namespace fr
