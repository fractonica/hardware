// fr.audio_in (design audio-a1 D1, D3-D5, §11): the core-task commands and timer, the fr_audio capture and the
// fr_stream POST. Who touches what is in the header's sections; the tasks and the core task meet only in atomics
// (published with release, read with acquire) and the record ring.
#include "fr/services/audio_in_service.hpp"

#include <algorithm>
#include <charconv>
#include <cstdio>
#include <cstring>
#include <new>
#include <string_view>

#include "fr/audio/rt.hpp"
#include "fr/ota/http_post.hpp"

namespace fr {
namespace {

using Reason = cap::AudioInStreamEndReason;
using MonReason = cap::AudioInMonitorEndReason;

/** The longest stall diag `audio stall` takes. */
constexpr uint32_t kStallMaxMs = 60'000;

void put_u32le(uint8_t *p, uint32_t v)
{
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
    p[2] = static_cast<uint8_t>(v >> 16);
    p[3] = static_cast<uint8_t>(v >> 24);
}

/** N of the hub's `{"samples":N}`; 0 when it is not there. */
uint32_t hub_samples(std::string_view body)
{
    const size_t key = body.find("\"samples\"");
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

AudioInService::AudioInService(hal::AudioSource &src, const cap::AudioInConfig &cfg) : src_(src), cfg_(cfg)
{
    static_assert(sizeof(ota::HttpPost) <= sizeof(post_store_) && alignof(ota::HttpPost) <= 8);
    new (post_store_) ota::HttpPost(kStallMs);
}

AudioInService::~AudioInService()
{
    audio::engine().remove(*this);
    post().~HttpPost();
    if (ring_mem_ != nullptr) {
        audio::Rt::release(ring_mem_);
    }
}

ota::HttpPost &AudioInService::post()
{
    return *std::launder(reinterpret_cast<ota::HttpPost *>(post_store_));
}

Status AudioInService::init(Core &core)
{
    core_ = &core;
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (auto st = src_.init(core); !st) {
        return st;
    }
    const size_t bytes = audio::Rt::psram() ? audio::kRecordRingBytesPsram : audio::kRecordRingBytesInternal;
    void *mutex = audio::Rt::mutex_create();
    ring_mem_ = static_cast<int16_t *>(audio::Rt::alloc(bytes));
    if (ring_mem_ == nullptr || mutex == nullptr) {
        return std::unexpected(Err::failed);
    }
    ring_.bind(ring_mem_, bytes, mutex);
    test_req_.store(1, std::memory_order_relaxed);  // fr_audio's first self-test, so selftest() has a result to give
    if (!audio::engine().add(*this) || !audio::engine().start()) {
        return std::unexpected(Err::failed);
    }
    ready_ = true;
    return {};
}

hal::Selftest AudioInService::selftest()
{
    // The source is fr_audio's (fr/hal/audio.hpp): the core task never starts or reads it, and never waits for it.
    if (!ready_) {
        return {false, "audio_in: not initialised"};
    }
    if (streaming_ || running_.load(std::memory_order_acquire)) {
        return {true, "audio_in: running (fr_audio has the source)"};
    }
    test_req_.fetch_add(1, std::memory_order_release);
    audio::engine().wake_audio();
    switch (static_cast<TestResult>(test_result_.load(std::memory_order_acquire))) {
    case TestResult::ok:
        return {true, "audio_in: the source starts and its DMA delivers (fr_audio)"};
    case TestResult::no_start:
        return {false, "audio_in: the source does not start"};
    case TestResult::no_frames:
        return {false, "audio_in: no frames from the source's DMA"};
    case TestResult::read_failed:
        return {false, "audio_in: the source's read failed"};
    case TestResult::none:
    default:
        return {false, "audio_in: self-test pending on fr_audio (ask again)"};
    }
}

cap::AudioInTraits AudioInService::traits() const
{
    return {.max_sample_hz = src_.max_sample_hz(), .bits = src_.bits()};
}

// ---- core task ----

std::expected<cap::AudioInStreamStartResult, Err> AudioInService::stream_start(const cap::AudioInStreamStartArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (streaming_) {
        return std::unexpected(Err::busy);
    }
    const uint32_t rate = args.has_sample_hz ? args.sample_hz : cfg_.sample_hz;
    if (!hal::is_audio_rate(rate) || rate > src_.max_sample_hz()) {
        return std::unexpected(Err::invalid_args);
    }
    if (monitoring_ && rate != cfg_.sample_hz) {
        return std::unexpected(Err::busy);  // the source runs the monitor's rate
    }
    audio::Endpoint ep{};
    audio::StreamHost *host = audio::stream_host();
    const bool has_ep = host != nullptr && host->endpoint(ep) && ep.ipv4 != 0 && ep.port != 0;
    if (host != nullptr) {
        std::snprintf(device_, sizeof(device_), "%s", host->device_id());
    }
    req_id_.store(args.stream_id, std::memory_order_relaxed);
    req_rate_.store(rate, std::memory_order_relaxed);
    req_max_.store(static_cast<uint32_t>(args.seconds) * rate, std::memory_order_relaxed);
    req_ip_.store(has_ep ? ep.ipv4 : 0, std::memory_order_relaxed);
    req_port_.store(ep.port, std::memory_order_relaxed);
    gen_ = gen_ + 1 == 0 ? 1 : gen_ + 1;
    req_gen_.store(gen_, std::memory_order_release);
    streaming_ = true;
    stream_rate_ = rate;
    stream_id_ = args.stream_id;
    report_streaming(true);
    arm();
    audio::engine().wake_stream();
    audio::engine().wake_audio();
    return cap::AudioInStreamStartResult{.sample_hz = rate};
}

Status AudioInService::stream_stop(const cap::AudioInStreamStopArgs &args)
{
    if (!streaming_ || args.stream_id != stream_id_) {
        return std::unexpected(Err::not_found);
    }
    stop_gen_.store(gen_, std::memory_order_release);
    audio::engine().wake_audio();
    return {};
}

std::expected<cap::AudioInLevelGetResult, Err> AudioInService::level_get()
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const cap::AudioInLevelGetResult r{.dbfs_x10 = level_dbfs_.load(std::memory_order_acquire),
                                       .peak_dbfs_x10 = level_peak_.load(std::memory_order_acquire),
                                       .clipping = clipping_.load(std::memory_order_relaxed)};
    if (!streaming_ && !running_.load(std::memory_order_acquire)) {
        meter_req_.fetch_add(1, std::memory_order_release);
        audio::engine().wake_audio();
        arm();
    }
    return r;
}

Status AudioInService::monitor_start(const cap::AudioInMonitorStartArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    audio::MonitorSink *sink = audio::engine().monitor_sink(args.to_port);
    const uint32_t rate = cfg_.sample_hz;
    if (sink == nullptr || !hal::is_audio_rate(rate) || rate > src_.max_sample_hz()) {
        return std::unexpected(Err::invalid_args);
    }
    if (monitoring_ || (streaming_ && stream_rate_ != rate)) {
        return std::unexpected(Err::busy);
    }
    const auto claim = sink->monitor_claim(rate, args.volume);
    if (!claim) {
        return std::unexpected(claim.error());
    }
    mon_sink_ = sink;
    mon_claim_ = *claim;
    mon_port_ = args.to_port;
    mon_req_sink_.store(sink, std::memory_order_relaxed);
    mon_req_claim_.store(*claim, std::memory_order_relaxed);
    mon_req_max_.store(static_cast<uint32_t>(args.seconds) * rate, std::memory_order_relaxed);
    mon_gen_ = mon_gen_ + 1 == 0 ? 1 : mon_gen_ + 1;
    mon_req_gen_.store(mon_gen_, std::memory_order_release);
    monitoring_ = true;
    report_monitoring(true);
    arm();
    audio::engine().wake_audio();
    return {};
}

Status AudioInService::monitor_stop()
{
    if (monitoring_) {
        mon_stop_gen_.store(mon_gen_, std::memory_order_release);
        audio::engine().wake_audio();
    }
    return {};
}

bool AudioInService::stats(audio::WorkerStats &out) const
{
    out.name = name();
    out.input = true;
    out.rx_overflows = rx_overflows_.load(std::memory_order_relaxed);
    out.dropped_samples = ring_.dropped_total();
    out.clipping = clip_total_.load(std::memory_order_relaxed);
    return true;
}

#if FR_TEST_HOOKS
Status AudioInService::stall(uint32_t ms)
{
    if (!streaming_) {
        return std::unexpected(Err::not_found);
    }
    if (ms == 0 || ms > kStallMaxMs) {
        return std::unexpected(Err::invalid_args);
    }
    stall_ms_.store(ms, std::memory_order_relaxed);
    stall_seq_.fetch_add(1, std::memory_order_release);
    return {};
}
#endif

void AudioInService::arm()
{
    idle_ticks_ = 0;
    if (timer_ != nullptr && !timer_->running()) {
        timer_->start(kPollUs);
    }
}

void AudioInService::on_timer()
{
    const uint32_t seq = level_seq_.load(std::memory_order_acquire);
    if (seq != level_seen_) {
        level_seen_ = seq;
        level_ = level_dbfs_.load(std::memory_order_relaxed);
        if (cfg_.level_hz > 0 && !monitoring_) {
            report_level(level_);  // paused while monitoring (design audio-a2 D3)
        }
    }
    if (streaming_ && end_gen_.load(std::memory_order_acquire) == gen_) {
        streaming_ = false;
        report_streaming(false);
        emit_stream_ended({.stream_id = stream_id_,
                           .reason = static_cast<Reason>(end_reason_.load(std::memory_order_relaxed)),
                           .samples = end_samples_.load(std::memory_order_relaxed),
                           .dropped_samples = end_dropped_.load(std::memory_order_relaxed)});
    }
    if (monitoring_ && mon_end_gen_.load(std::memory_order_acquire) == mon_gen_) {
        // fr_audio writes nothing more for this monitor: the output is free again (unless it was taken from it).
        monitoring_ = false;
        mon_sink_->monitor_release(mon_claim_);
        report_monitoring(false);
        emit_monitor_ended({.reason = static_cast<MonReason>(mon_end_reason_.load(std::memory_order_relaxed)),
                            .to_port = mon_port_,
                            .samples = mon_end_samples_.load(std::memory_order_relaxed)});
    }
    // Ticking while anything runs, and half a second after: a level_get's meter run starts on fr_audio's time.
    idle_ticks_ = streaming_ || monitoring_ || running_.load(std::memory_order_acquire) ? 0 : idle_ticks_ + 1;
    if (streaming_ || monitoring_ || idle_ticks_ < 10) {
        timer_->start(kPollUs);
    }
}

// ---- fr_audio ----

void AudioInService::set_rate(uint32_t hz)
{
    if (rate_ != 0) {
        static_cast<void>(src_.stop());
        rate_ = 0;
        running_.store(false, std::memory_order_release);
    }
    if (hz == 0 || !src_.start(hz)) {
        return;
    }
    rate_ = hz;
    conv_.configure(hz, cfg_.gain_db, cfg_.hpf_hz);
    conv_.reset_clipping();
    clip_seen_ = 0;
    clipping_.store(0, std::memory_order_relaxed);
    meter_.configure(cfg_.level_hz > 0 ? hz / cfg_.level_hz : hz * kMeterRunMs / 1000);
    // The warm-up, then the blocker's glide (none without a blocker): the meter waits for both.
    warm_ = hz * kWarmupMs / 1000;
    settle_ = cfg_.hpf_hz > 0 ? hz * kSettleMs / 1000 : 0;
    conv_.settle(settle_, kSettleHz);
    overruns_seen_ = src_.overruns();
    running_.store(true, std::memory_order_release);
}

void AudioInService::test_done(TestResult r)
{
    testing_ = false;
    test_result_.store(static_cast<uint8_t>(r), std::memory_order_release);
}

bool AudioInService::audio_pass(uint32_t wait_ms)
{
    // A new stream (fr_stream reset the ring before it said go), an abort, a stop, a level_get.
    const uint32_t go = cap_go_.load(std::memory_order_acquire);
    if (go != 0 && go != cap_gen_ && go != cap_last_) {
        cap_gen_ = go;
        cap_rate_ = req_rate_.load(std::memory_order_relaxed);
        cap_max_ = req_max_.load(std::memory_order_relaxed);
        cap_samples_ = 0;
        fill_ = {};
        fill_len_ = 0;
        stall_from_ = stall_to_ = 0;
        stall_seen_ = stall_seq_.load(std::memory_order_acquire);
    }
    if (cap_gen_ != 0 && cap_abort_.load(std::memory_order_acquire) == cap_gen_) {
        end_capture(Reason::net_lost);
    } else if (cap_gen_ != 0 && stop_gen_.load(std::memory_order_acquire) == cap_gen_) {
        end_capture(Reason::stopped);
    }
    const uint32_t m = meter_req_.load(std::memory_order_acquire);
    if (m != meter_seen_) {
        meter_seen_ = m;
        // At least one whole window (level_hz 1: a second), measured after the warm-up and the glide.
        const uint32_t window = cfg_.level_hz > 0 ? cfg_.sample_hz / cfg_.level_hz : 0;
        meter_left_ = std::max<uint32_t>({cfg_.sample_hz * kMeterRunMs / 1000, window, 1});
    }
    const uint32_t t = test_req_.load(std::memory_order_acquire);
    if (t != test_seen_) {
        test_seen_ = t;
        testing_ = true;
        test_until_ = core_->now() + static_cast<TimeUs>(kTestMs) * 1000;
    }
    // A new monitor, its stop, the output taken from it.
    const uint32_t mg = mon_req_gen_.load(std::memory_order_acquire);
    if (mg != 0 && mg != mon_run_ && mg != mon_last_) {
        mon_run_ = mg;
        mon_out_ = mon_req_sink_.load(std::memory_order_relaxed);
        mon_out_claim_ = mon_req_claim_.load(std::memory_order_relaxed);
        mon_max_ = mon_req_max_.load(std::memory_order_relaxed);
        mon_samples_ = 0;
    }
    if (mon_run_ != 0 && mon_stop_gen_.load(std::memory_order_acquire) == mon_run_) {
        end_monitor(MonReason::stopped);
    } else if (mon_run_ != 0) {
        switch (mon_out_->monitor_preempted(mon_out_claim_)) {
        case audio::MonitorEnd::none:
            break;
        case audio::MonitorEnd::stopped:
            end_monitor(MonReason::stopped);
            break;
        case audio::MonitorEnd::error:
            end_monitor(MonReason::error);
            break;
        case audio::MonitorEnd::busy:
        default:
            end_monitor(MonReason::busy);
            break;
        }
    }

    // A stream sets the rate (a monitor beside it runs at config sample_hz, which the commands made it); else a
    // monitor, the meter or the self-test run config sample_hz.
    const uint32_t want =
        cap_gen_ != 0 ? cap_rate_ : mon_run_ != 0 || meter_left_ > 0 || testing_ ? cfg_.sample_hz : 0;
    if (want != rate_) {
        set_rate(want);
        if (want != 0 && rate_ == 0) {
            // The source did not start.
            meter_left_ = 0;
            if (testing_) {
                test_done(TestResult::no_start);
            }
            if (cap_gen_ != 0) {
                end_capture(Reason::error);
            }
            if (mon_run_ != 0) {
                end_monitor(MonReason::error);
            }
            return true;
        }
    }
    if (rate_ == 0) {
        return false;
    }

    const auto got = src_.read(frames_, wait_ms);
    if (!got) {
        meter_left_ = 0;
        if (testing_) {
            test_done(TestResult::read_failed);
        }
        if (cap_gen_ != 0) {
            end_capture(Reason::error);
        }
        if (mon_run_ != 0) {
            end_monitor(MonReason::error);
        }
        set_rate(0);
        return true;
    }
    if (testing_) {
        // The self-test: frames came (whatever they hold), or none within kTestMs.
        if (*got > 0) {
            test_done(TestResult::ok);
        } else if (core_->now() >= test_until_) {
            test_done(TestResult::no_frames);
        }
    }
    // DMA buffers the driver lost come back as zeros: the stream keeps its time (design D4).
    const uint32_t ov = src_.overruns();
    if (ov != overruns_seen_) {
        rx_overflows_.fetch_add(ov - overruns_seen_, std::memory_order_relaxed);
        uint32_t lost = (ov - overruns_seen_) * static_cast<uint32_t>(kReadFrames);
        overruns_seen_ = ov;
        dma_lost_.fetch_add(lost, std::memory_order_relaxed);
        if (cap_gen_ != 0 && warm_ == 0) {
            std::fill(std::begin(pcm_), std::end(pcm_), int16_t{0});
            while (lost > 0 && cap_gen_ != 0) {
                const uint32_t k = std::min<uint32_t>(lost, kReadFrames);
                capture({pcm_, k});
                lost -= k;
            }
        }
    }
    // The warm-up's frames go nowhere: not to the stream, the meter or the clipping count.
    const size_t n = *got;
    const size_t skip = std::min<size_t>(n, warm_);
    warm_ -= static_cast<uint32_t>(skip);
    const size_t k = n - skip;
    if (k > 0) {
        const std::span<int16_t> pcm(pcm_, k);
        conv_.convert({frames_ + skip, k}, pcm);
        const uint32_t clipped = conv_.clipping();
        clipping_.store(clipped, std::memory_order_relaxed);
        clip_total_.fetch_add(clipped - clip_seen_, std::memory_order_relaxed);
        clip_seen_ = clipped;
        // The glide's samples are streamed (the stream's sample 0 is the first kept one) but not metered.
        const size_t gliding = std::min<size_t>(k, settle_);
        settle_ -= static_cast<uint32_t>(gliding);
        const std::span<const int16_t> metered = pcm.subspan(gliding);
        if (meter_.add(metered)) {
            const audio::Level l = meter_.level();
            level_dbfs_.store(l.dbfs_x10, std::memory_order_relaxed);
            level_peak_.store(l.peak_dbfs_x10, std::memory_order_relaxed);
            level_seq_.fetch_add(1, std::memory_order_release);
        }
        if (cap_gen_ != 0) {
            capture(pcm);
        }
        if (mon_run_ != 0) {
            route(pcm);
        }
        meter_left_ -= std::min<uint32_t>(meter_left_, static_cast<uint32_t>(metered.size()));
    }
    if (cap_gen_ != 0 && cap_max_ != 0 && cap_samples_ >= cap_max_) {
        end_capture(Reason::done);
    }
    return true;
}

void AudioInService::route(std::span<const int16_t> pcm)
{
    // What the output had no room for (above its latency cap) is dropped there: a monitor never waits.
    size_t k = pcm.size();
    if (mon_max_ != 0) {
        k = std::min<size_t>(k, mon_max_ - mon_samples_);
    }
    mon_out_->monitor_write(mon_out_claim_, pcm.first(k));
    mon_samples_ += static_cast<uint32_t>(k);
    if (mon_max_ != 0 && mon_samples_ >= mon_max_) {
        end_monitor(MonReason::done);
    }
}

void AudioInService::end_monitor(MonReason why)
{
    mon_out_->monitor_finish(mon_out_claim_);  // nothing when the output was taken from the monitor already
    mon_end_reason_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    mon_end_samples_.store(mon_samples_, std::memory_order_relaxed);
    mon_end_gen_.store(mon_run_, std::memory_order_release);
    mon_last_ = mon_run_;
    mon_run_ = 0;
}

void AudioInService::capture(std::span<const int16_t> pcm)
{
    while (!pcm.empty() && (cap_max_ == 0 || cap_samples_ < cap_max_)) {
        if (fill_.empty()) {
            fill_ = ring_.acquire();
            if (fill_.empty()) {
                end_capture(Reason::error);  // no ring: cannot happen once reset() took the stream
                return;
            }
            fill_len_ = 0;
            fill_first_ = cap_samples_;
        }
        size_t take = std::min<size_t>(pcm.size(), fill_.size() - fill_len_);
        if (cap_max_ != 0) {
            take = std::min<size_t>(take, cap_max_ - cap_samples_);
        }
        std::memcpy(fill_.data() + fill_len_, pcm.data(), take * sizeof(int16_t));
        fill_len_ += static_cast<uint32_t>(take);
        cap_samples_ += static_cast<uint32_t>(take);
        pcm = pcm.subspan(take);
        if (fill_len_ == fill_.size()) {
            publish_fill();
        }
    }
}

void AudioInService::publish_fill()
{
    if (fill_.empty() || fill_len_ == 0) {
        return;
    }
#if FR_TEST_HOOKS
    // diag `audio stall <ms>`: from the block after the one filling when it came, whole blocks covering `ms` are
    // dropped as an overflow drops them, and nothing is sent for them.
    const uint32_t sq = stall_seq_.load(std::memory_order_acquire);
    if (sq != stall_seen_) {
        stall_seen_ = sq;
        const uint32_t block = ring_.block();
        const uint64_t want = static_cast<uint64_t>(stall_ms_.load(std::memory_order_relaxed)) * cap_rate_ / 1000;
        const uint64_t blocks = block > 0 ? (want + block - 1) / block : 0;
        stall_from_ = fill_first_ + block;
        stall_to_ = static_cast<uint32_t>(std::min<uint64_t>(stall_from_ + blocks * block, UINT32_MAX));
    }
    if (fill_first_ >= stall_from_ && fill_first_ < stall_to_) {
        ring_.discard(fill_len_);
        fill_len_ = 0;
        fill_first_ = cap_samples_;
        return;
    }
#endif
    ring_.publish(fill_len_, fill_first_);
    fill_ = {};
    fill_len_ = 0;
    audio::engine().wake_stream();
}

void AudioInService::end_capture(Reason why)
{
    if (why != Reason::net_lost && why != Reason::error) {
        publish_fill();  // the last block, possibly shorter
    }
    fill_ = {};
    fill_len_ = 0;
    cap_reason_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    cap_total_.store(cap_samples_, std::memory_order_relaxed);
    cap_done_.store(cap_gen_, std::memory_order_release);
    cap_last_ = cap_gen_;
    cap_gen_ = 0;
    audio::engine().wake_stream();
}

// ---- fr_stream ----

void AudioInService::begin_stream(uint32_t gen)
{
    st_gen_ = gen;
    seq_ = 0;
    sent_samples_ = 0;
    sending_ = false;
    const uint32_t rate = req_rate_.load(std::memory_order_relaxed);
    if (!ring_.reset(audio::block_samples(rate))) {
        publish_end(Reason::error, 0, 0);  // nothing was captured: fr_audio never got go
        return;
    }
    cap_go_.store(gen, std::memory_order_release);
    audio::engine().wake_audio();
    const uint32_t ip = req_ip_.load(std::memory_order_relaxed);
    if (ip == 0) {
        abort_stream(Reason::net_lost, false);
        return;
    }
    char host[16];
    audio::format_ipv4(ip, host, sizeof(host));
    char path[32];
    std::snprintf(path, sizeof(path), "/v1/audio/in/%u", static_cast<unsigned>(req_id_.load(std::memory_order_relaxed)));
    char headers[96];
    std::snprintf(headers, sizeof(headers), "X-Fr-Device: %s\r\nX-Fr-Format: s16le;rate=%u;ch=1\r\n", device_,
                  static_cast<unsigned>(rate));
    if (!post().start(host, static_cast<uint16_t>(req_port_.load(std::memory_order_relaxed)), path, headers)) {
        abort_stream(Reason::net_lost, false);
        return;
    }
    st_ = StreamState::streaming;
}

void AudioInService::abort_stream(Reason why, bool connected)
{
    post().close();
    if (sending_) {
        sending_ = false;
        ring_.release();  // the block in flight is abandoned
    }
    abort_reason_ = why;
    // What the stream covered: up to the last block sent (nothing when it never connected).
    abort_dropped_ = connected ? std::min(ring_.dropped_samples(), sent_samples_) : 0;
    sent_samples_ = connected ? sent_samples_ : 0;
    cap_abort_.store(st_gen_, std::memory_order_release);
    audio::engine().wake_audio();
    st_ = StreamState::aborting;
}

void AudioInService::publish_end(Reason why, uint32_t samples, uint32_t dropped)
{
    end_reason_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    end_samples_.store(samples, std::memory_order_relaxed);
    end_dropped_.store(dropped, std::memory_order_relaxed);
    end_gen_.store(st_gen_, std::memory_order_release);
    st_ = StreamState::idle;
}

bool AudioInService::stream_pass()
{
    switch (st_) {
    case StreamState::idle: {
        const uint32_t g = req_gen_.load(std::memory_order_acquire);
        if (g == st_gen_) {
            return false;
        }
        begin_stream(g);
        return true;
    }
    case StreamState::streaming: {
        if (sending_) {
            // The block in flight, a slice at a time: the play GET on this task is read between slices. A block that
            // has not gone in kStallMs in all (a trickling connection too) fails here.
            const auto done = post().pump(kSendSliceMs);
            if (!done) {
                abort_stream(Reason::net_lost, true);
                return true;
            }
            if (!*done) {
                return true;
            }
            sending_ = false;
            ring_.release();
            audio::engine().wake_audio();
            ++seq_;
            sent_samples_ = sending_end_;
            return true;
        }
        if (post().answered()) {
            last_status_.store(post().status(), std::memory_order_relaxed);
            abort_stream(Reason::net_lost, true);  // the hub refused (or went away) before the end
            return true;
        }
        audio::RecordRing::Block b;
        if (ring_.take(b)) {
            // The block stays in the ring (in flight) until it has gone: HttpPost sends it from there.
            put_u32le(head_, seq_);
            put_u32le(head_ + 4, b.first_sample);
            if (!post().begin_chunk(head_, {reinterpret_cast<const uint8_t *>(b.pcm), b.len * sizeof(int16_t)})) {
                ring_.release();
                abort_stream(Reason::net_lost, true);
                return true;
            }
            sending_ = true;
            sending_end_ = b.first_sample + b.len;
            return true;
        }
        if (cap_done_.load(std::memory_order_acquire) != st_gen_) {
            return false;  // waiting for the next block
        }
        if (ring_.queued() > 0) {
            return true;  // published after the take above looked
        }
        const Status st = post().finish();
        last_status_.store(post().status(), std::memory_order_relaxed);
        hub_samples_.store(hub_samples(post().body()), std::memory_order_relaxed);
        const auto why = st && post().status() == 200 ? static_cast<Reason>(cap_reason_.load(std::memory_order_relaxed))
                                                      : Reason::net_lost;
        // fr_audio stored what it captured (dropped ones included) before cap_done_.
        publish_end(why, cap_total_.load(std::memory_order_relaxed), ring_.dropped_samples());
        return true;
    }
    case StreamState::aborting: {
        if (cap_done_.load(std::memory_order_acquire) != st_gen_) {
            return false;  // fr_audio has not stopped capturing yet
        }
        audio::RecordRing::Block b;
        while (ring_.take(b)) {
            ring_.release();
        }
        publish_end(abort_reason_, sent_samples_, abort_dropped_);
        return true;
    }
    }
    return false;
}

}  // namespace fr
