// fr.audio_out (design audio-a1 D2-D5, §11): the core-task commands and timer, the fr_audio writer and the fr_stream
// GET. A job is published by its generation (req_gen_); a newer one replaces it on both tasks. The play ring changes
// hands per play: fr_stream stops writing for the old play (prod_gen_), fr_audio empties the ring (cons_gen_), then
// fr_stream fills it for the new one.
#include "fr/services/audio_out_service.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <new>

#include "fr/audio/rt.hpp"
#include "fr/ota/http_get.hpp"

namespace fr {
namespace {

using Reason = cap::AudioOutPlayEndReason;
constexpr uint32_t kNoVolume = 0xFF;
/** fr_stream reads when the ring has room for at least this many samples. */
constexpr size_t kMinRoom = 256;

}  // namespace

AudioOutService::AudioOutService(hal::AudioSink &sink, const cap::AudioOutConfig &cfg)
    : sink_(sink), cfg_(cfg), volume_(std::min<uint8_t>(cfg.volume, 100))
{
    static_assert(sizeof(ota::HttpGet) <= sizeof(get_store_) && alignof(ota::HttpGet) <= 8);
    new (get_store_) ota::HttpGet(kStallMs);
}

AudioOutService::~AudioOutService()
{
    audio::engine().remove(*this);
    http().~HttpGet();
    if (ring_mem_ != nullptr) {
        audio::Rt::release(ring_mem_);
    }
}

ota::HttpGet &AudioOutService::http()
{
    return *std::launder(reinterpret_cast<ota::HttpGet *>(get_store_));
}

Status AudioOutService::init(Core &core)
{
    core_ = &core;
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (auto st = sink_.init(core); !st) {
        return st;
    }
    const size_t bytes = audio::Rt::psram() ? audio::kPlayRingBytesPsram : audio::kPlayRingBytesInternal;
    ring_mem_ = static_cast<int16_t *>(audio::Rt::alloc(bytes));
    if (ring_mem_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    ring_.bind(ring_mem_, bytes / sizeof(int16_t));
    if (!audio::engine().add(*this) || !audio::engine().start()) {
        return std::unexpected(Err::failed);
    }
    ready_ = true;
    return {};
}

hal::Selftest AudioOutService::selftest()
{
    if (playing_) {
        return {true, "playing: fr_audio has the sink"};
    }
    return sink_.selftest();
}

cap::AudioOutTraits AudioOutService::traits() const
{
    return {.max_sample_hz = sink_.max_sample_hz(), .bits = sink_.bits()};
}

// ---- core task ----

void AudioOutService::publish(Kind kind)
{
    gen_ = gen_ + 1 == 0 ? 1 : gen_ + 1;
    req_kind_.store(static_cast<uint8_t>(kind), std::memory_order_relaxed);
    req_gen_.store(gen_, std::memory_order_release);
    audio::engine().wake_audio();
    audio::engine().wake_stream();
}

void AudioOutService::end_current()
{
    if (take_monitor(audio::MonitorEnd::busy)) {
        return;  // no play_done for a monitor: its input sends monitor_ended
    }
    if (playing_) {
        emit_play_done({.play_id = play_id_,
                        .reason = Reason::stopped,
                        .underruns = cur_underruns_.load(std::memory_order_relaxed),
                        .samples = cur_samples_.load(std::memory_order_relaxed)});
    }
}

void AudioOutService::arm()
{
    if (timer_ != nullptr && !timer_->running()) {
        timer_->start(kPollUs);
    }
}

Status AudioOutService::tone(const cap::AudioOutToneArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const uint32_t rate = cfg_.sample_hz;
    if (!hal::is_audio_rate(rate) || rate > sink_.max_sample_hz() || static_cast<uint32_t>(args.freq_hz) * 2 >= rate) {
        return std::unexpected(Err::invalid_args);
    }
    end_current();
    req_freq_.store(args.freq_hz, std::memory_order_relaxed);
    req_samples_.store(static_cast<uint32_t>(args.ms) * rate / 1000, std::memory_order_relaxed);
    req_volume_.store(args.has_volume ? args.volume : kNoVolume, std::memory_order_relaxed);
    req_rate_.store(rate, std::memory_order_relaxed);
    publish(Kind::tone);
    play_id_ = 0;
    if (!playing_) {
        playing_ = true;
        report_playing(true);
    }
    arm();
    return {};
}

Status AudioOutService::play(const cap::AudioOutPlayArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (!hal::is_audio_rate(args.sample_hz) || args.sample_hz > sink_.max_sample_hz()) {
        return std::unexpected(Err::invalid_args);
    }
    audio::Endpoint ep{};
    audio::StreamHost *host = audio::stream_host();
    const bool has_ep = host != nullptr && host->endpoint(ep) && ep.ipv4 != 0 && ep.port != 0;
    end_current();
    req_rate_.store(args.sample_hz, std::memory_order_relaxed);
    req_id_.store(args.play_id, std::memory_order_relaxed);
    req_ip_.store(has_ep ? ep.ipv4 : 0, std::memory_order_relaxed);
    req_port_.store(ep.port, std::memory_order_relaxed);
    req_volume_.store(kNoVolume, std::memory_order_relaxed);
    publish(Kind::play);
    play_id_ = args.play_id;
    if (!playing_) {
        playing_ = true;
        report_playing(true);
    }
    arm();
    return {};
}

Status AudioOutService::stop()
{
    if (!playing_) {
        return {};
    }
    if (!take_monitor(audio::MonitorEnd::stopped)) {
        end_current();
    }
    publish(Kind::none);
    playing_ = false;
    report_playing(false);
    return {};
}

Status AudioOutService::set_volume(const cap::AudioOutSetVolumeArgs &args)
{
    const uint8_t v = std::min<uint8_t>(args.volume, 100);
    if (v != volume_.exchange(v, std::memory_order_relaxed)) {
        report_volume(v);
    }
    return {};
}

bool AudioOutService::take_monitor(audio::MonitorEnd why)
{
    if (mon_core_ == 0) {
        return false;
    }
    mon_taken_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    mon_claim_.store(0, std::memory_order_release);
    mon_core_ = 0;
    return true;
}

std::expected<uint32_t, Err> AudioOutService::monitor_claim(uint32_t sample_hz, uint8_t volume)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (sample_hz != cfg_.sample_hz || !hal::is_audio_rate(sample_hz) || sample_hz > sink_.max_sample_hz()) {
        return std::unexpected(Err::invalid_args);
    }
    if (playing_) {
        return std::unexpected(Err::busy);  // a tone, a play, or another input's monitor
    }
    req_rate_.store(sample_hz, std::memory_order_relaxed);
    req_volume_.store(volume != 0 ? std::min<uint8_t>(volume, 100) : kNoVolume, std::memory_order_relaxed);
    // The claim is the job's gen, held before fr_audio can see the job (its sink failing gives it back).
    const uint32_t claim = gen_ + 1 == 0 ? 1 : gen_ + 1;
    mon_core_ = claim;
    mon_taken_.store(static_cast<uint8_t>(audio::MonitorEnd::none), std::memory_order_relaxed);
    mon_claim_.store(claim, std::memory_order_release);
    publish(Kind::monitor);  // gen_ becomes `claim`
    playing_ = true;
    report_playing(true);
    return claim;
}

void AudioOutService::monitor_release(uint32_t claim)
{
    if (claim == 0 || claim != mon_core_) {
        return;  // a tone, play or stop took the output already (it reports `playing` itself)
    }
    mon_claim_.store(0, std::memory_order_release);
    mon_core_ = 0;
    publish(Kind::none);
    playing_ = false;
    report_playing(false);
}

audio::MonitorEnd AudioOutService::monitor_preempted(uint32_t claim) const
{
    if (claim != 0 && mon_claim_.load(std::memory_order_acquire) == claim) {
        return audio::MonitorEnd::none;
    }
    const auto why = static_cast<audio::MonitorEnd>(mon_taken_.load(std::memory_order_relaxed));
    return why == audio::MonitorEnd::none ? audio::MonitorEnd::busy : why;
}

void AudioOutService::on_timer()
{
    if (playing_ && end_gen_.load(std::memory_order_acquire) == gen_) {
        playing_ = false;
        report_playing(false);
        emit_play_done({.play_id = play_id_,
                        .reason = static_cast<Reason>(end_reason_.load(std::memory_order_relaxed)),
                        .underruns = end_underruns_.load(std::memory_order_relaxed),
                        .samples = end_samples_.load(std::memory_order_relaxed)});
    }
    if (playing_) {
        timer_->start(kPollUs);
    }
}

// ---- fr_audio ----

bool AudioOutService::start_sink(uint32_t hz)
{
    if (sink_rate_ != hz) {
        if (sink_rate_ != 0) {
            static_cast<void>(sink_.stop(0));
            sink_rate_ = 0;
        }
        if (!sink_.start(hz)) {
            return false;
        }
        sink_rate_ = hz;
    }
    sink_underruns0_ = sink_.underruns();
    sink_seen_ = sink_underruns0_;
    return true;
}

void AudioOutService::count_sink()
{
    // The sink's starved DMA buffers while a sound runs (not while it drains, nor between sounds): diag `stats audio`.
    if (sink_rate_ != 0) {
        const uint32_t u = sink_.underruns();
        underruns_total_.fetch_add(u - sink_seen_, std::memory_order_relaxed);
        sink_seen_ = u;
    }
}

void AudioOutService::stop_sink(uint32_t drain_ms)
{
    if (sink_rate_ != 0) {
        static_cast<void>(sink_.stop(drain_ms));
        sink_rate_ = 0;
    }
}

bool AudioOutService::flush(uint32_t wait_ms)
{
    while (chunk_off_ < chunk_len_) {
        const auto w = sink_.write({chunk_ + chunk_off_, chunk_len_ - chunk_off_}, wait_ms);
        if (!w) {
            finish(Reason::error);
            return false;
        }
        if (*w == 0) {
            return false;  // no room yet
        }
        if (chunk_pcm_) {
            samples_ += static_cast<uint32_t>(*w);
            cur_samples_.store(samples_, std::memory_order_relaxed);
            progress();  // a sound into the sink (silence for a dry ring is not progress)
        }
        chunk_off_ += *w;
    }
    chunk_len_ = chunk_off_ = 0;
    return true;
}

void AudioOutService::finish(Reason why)
{
    if (monitoring_out()) {
        monitor_fail();  // a monitor has no play_done: its input ends with error
        return;
    }
    // The sink's own late buffers count up to the last write, not while it drains.
    if (out_ == OutState::tone || out_ == OutState::playing) {
        count_sink();
    }
    const uint32_t sink_late = sink_rate_ != 0 ? sink_.underruns() - sink_underruns0_ : 0;
    if (out_ != OutState::tone) {
        stop_get_.store(job_gen_, std::memory_order_release);  // the GET, if it still runs, is not wanted any more
        audio::engine().wake_stream();
    }
    end_reason_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    end_underruns_.store(underruns_ + sink_late, std::memory_order_relaxed);
    end_samples_.store(samples_, std::memory_order_relaxed);
    end_gen_.store(job_gen_, std::memory_order_release);
    chunk_len_ = chunk_off_ = 0;
    if (sink_rate_ != 0 && why != Reason::error) {
        // What the DMA holds plays out; audio_pass stops the sink at the deadline (a sound that follows at the same
        // rate keeps it running instead).
        out_ = OutState::draining;
        drain_until_ = core_->now() + static_cast<TimeUs>(kDrainFrames) * 1'000'000 / sink_rate_ + 1000;
    } else {
        stop_sink(0);
        out_ = OutState::idle;
    }
}

void AudioOutService::monitor_fail()
{
    mon_taken_.store(static_cast<uint8_t>(audio::MonitorEnd::error), std::memory_order_relaxed);
    uint32_t held = job_gen_;
    mon_claim_.compare_exchange_strong(held, 0, std::memory_order_acq_rel);
    chunk_len_ = chunk_off_ = 0;
    stop_sink(0);
    out_ = OutState::idle;
}

size_t AudioOutService::monitor_write(uint32_t claim, std::span<const int16_t> pcm)
{
    // fr_audio (the input's pass, before the outputs'): only into the ring of the job this claim is, once it is emptied.
    size_t n = 0;
    if (claim != 0 && claim == job_gen_ && monitoring_out()) {
        const size_t cap = std::min<size_t>(static_cast<size_t>(job_rate_) * kMonitorPrebufferMs / 1000 + 2 * kChunk,
                                            ring_.capacity());
        const size_t used = ring_.size();
        n = ring_.write(pcm.first(std::min(pcm.size(), cap > used ? cap - used : 0)));
    }
    if (n < pcm.size()) {
        mon_dropped_.fetch_add(static_cast<uint32_t>(pcm.size() - n), std::memory_order_relaxed);
    }
    return n;
}

void AudioOutService::monitor_finish(uint32_t claim)
{
    // fr_audio, the input's pass: no more samples come. The DMA plays out (draining, uncounted) until the release.
    if (claim == 0 || claim != job_gen_ || !monitoring_out()) {
        return;
    }
    if (out_ == OutState::monitor) {
        count_sink();
    }
    chunk_len_ = chunk_off_ = 0;
    if (sink_rate_ != 0) {
        out_ = OutState::draining;
        drain_until_ = core_->now() + static_cast<TimeUs>(kDrainFrames) * 1'000'000 / sink_rate_ + 1000;
    } else {
        out_ = OutState::idle;
    }
}

void AudioOutService::progress()
{
    progress_at_ = core_->now();
}

bool AudioOutService::stuck() const
{
    return core_->now() - progress_at_ >= static_cast<TimeUs>(kStuckMs) * 1000;
}

bool AudioOutService::audio_pass(uint32_t wait_ms)
{
    const uint32_t g = req_gen_.load(std::memory_order_acquire);
    if (g != job_gen_) {
        // A new job (or stop) replaces the current one, whose play_done the core task has sent.
        job_gen_ = g;
        chunk_len_ = chunk_off_ = 0;
        samples_ = 0;
        underruns_ = 0;
        dry_ = false;
        cur_samples_.store(0, std::memory_order_relaxed);
        cur_underruns_.store(0, std::memory_order_relaxed);
        job_volume_ = req_volume_.load(std::memory_order_relaxed);
        job_rate_ = req_rate_.load(std::memory_order_relaxed);
        job_monitor_ = false;
        progress();
        switch (static_cast<Kind>(req_kind_.load(std::memory_order_relaxed))) {
        case Kind::tone:
            if (!start_sink(job_rate_)) {
                out_ = OutState::tone;
                finish(Reason::error);
                return true;
            }
            tone_.start(req_freq_.load(std::memory_order_relaxed), job_rate_, req_samples_.load(std::memory_order_relaxed),
                        job_rate_ * kRampMs / 1000);
            out_ = OutState::tone;
            break;
        case Kind::play:
            stop_sink(0);  // started again once the ring holds the prebuffer
            out_ = OutState::wait_stream;
            break;
        case Kind::monitor:
            // The ring changes hands as for a play (fr_stream may still write for the play before), then fills from
            // the input's monitor_write.
            stop_sink(0);
            job_monitor_ = true;
            out_ = OutState::wait_stream;
            break;
        case Kind::none:
        default:
            stop_sink(0);
            out_ = OutState::idle;
            break;
        }
    }
    const uint32_t vol = job_volume_ != kNoVolume ? job_volume_ : volume_.load(std::memory_order_relaxed);
    if (out_ == OutState::tone || out_ == OutState::playing || out_ == OutState::monitor) {
        count_sink();
    }
    // A monitor's input owns its end (its source failing ends it with error): no backstop for it here.
    if (out_ != OutState::idle && out_ != OutState::draining && !job_monitor_ && stuck()) {
        // The backstop: nothing moved for kStuckMs (a play: net_lost; a tone whose sink takes nothing: error).
        finish(out_ == OutState::tone ? Reason::error : Reason::net_lost);
        return true;
    }
    switch (out_) {
    case OutState::idle:
        return false;
    case OutState::draining:
        if (core_->now() < drain_until_) {
            return false;
        }
        stop_sink(0);
        out_ = OutState::idle;
        return true;
    case OutState::tone:
        // Until the sink takes no more without waiting (only the first write may wait): the DMA stays full.
        for (;; wait_ms = 0) {
            if (!flush(wait_ms) || out_ != OutState::tone) {
                return true;
            }
            if (tone_.done()) {
                finish(Reason::done);
                return true;
            }
            chunk_len_ = tone_.fill(chunk_);
            audio::apply_volume({chunk_, chunk_len_}, audio::volume_q15(static_cast<uint8_t>(vol)));
            chunk_pcm_ = true;
        }
    case OutState::wait_stream:
        if (prod_gen_.load(std::memory_order_acquire) != job_gen_) {
            return false;  // fr_stream may still write for the play this one replaced
        }
        ring_.discard_all();
        cons_gen_.store(job_gen_, std::memory_order_release);
        audio::engine().wake_stream();
        out_ = job_monitor_ ? OutState::monitor_prebuffer : OutState::prebuffer;
        ring_seen_ = 0;
        progress();
        return true;
    case OutState::prebuffer: {
        // kPrebufferMs, or what the ring holds once fr_stream stops reading (it reads while kMinRoom is free), so a
        // ring smaller than kPrebufferMs (no PSRAM, 44.1 or 48 kHz) still starts; the body's end starts it anyway.
        const size_t want = std::min<size_t>(static_cast<size_t>(job_rate_) * kPrebufferMs / 1000,
                                             ring_.capacity() > kMinRoom ? ring_.capacity() - kMinRoom : 1);
        const size_t have = ring_.size();
        if (have != ring_seen_) {
            ring_seen_ = have;
            progress();
        }
        if (have < want && got_gen_.load(std::memory_order_acquire) != job_gen_) {
            return false;
        }
        if (!start_sink(job_rate_)) {
            finish(Reason::error);
            return true;
        }
        out_ = OutState::playing;
        progress();
    }
        [[fallthrough]];
    case OutState::playing:
        // Until the sink takes no more without waiting (only the first write may wait) or the ring has nothing ready.
        for (bool wrote = false;; wait_ms = 0) {
            wrote = wrote || (chunk_off_ < chunk_len_ && chunk_pcm_);
            if (!flush(wait_ms) || out_ != OutState::playing) {
                return true;
            }
            const size_t n = ring_.read(chunk_);
            if (n > 0) {
                dry_ = false;
                wrote = true;
                progress();
                audio::engine().wake_stream();
                chunk_len_ = n;
                audio::apply_volume({chunk_, chunk_len_}, audio::volume_q15(static_cast<uint8_t>(vol)));
                chunk_pcm_ = true;
                continue;
            }
            if (got_gen_.load(std::memory_order_acquire) == job_gen_ && ring_.size() == 0) {
                finish(static_cast<Reason>(got_reason_.load(std::memory_order_relaxed)));
                return true;
            }
            if (wrote) {
                return true;  // the DMA holds what this pass wrote: more may come before it needs any
            }
            // Dry since the last pass while the GET goes on: one chunk of silence keeps the DMA fed; each dry spell
            // counts once.
            if (!dry_) {
                dry_ = true;
                ++underruns_;
                cur_underruns_.store(underruns_, std::memory_order_relaxed);
                ring_dry_total_.fetch_add(1, std::memory_order_relaxed);
            }
            std::fill(std::begin(chunk_), std::end(chunk_), int16_t{0});
            chunk_len_ = kChunk;
            chunk_pcm_ = false;
            flush(wait_ms);
            return true;
        }
    case OutState::monitor_prebuffer:
        if (ring_.size() < static_cast<size_t>(job_rate_) * kMonitorPrebufferMs / 1000) {
            return false;
        }
        if (!start_sink(job_rate_)) {
            monitor_fail();
            return true;
        }
        out_ = OutState::monitor;
        dry_ = false;
        [[fallthrough]];
    case OutState::monitor:
        // As playing: until the sink takes no more without waiting or the ring has nothing. Dry with nothing pending:
        // an underrun counted, no silence written (it would stay in the DMA as latency).
        for (bool wrote = false;; wait_ms = 0) {
            wrote = wrote || chunk_off_ < chunk_len_;
            if (!flush(wait_ms) || out_ != OutState::monitor) {
                return true;
            }
            const size_t n = ring_.read(chunk_);
            if (n > 0) {
                dry_ = false;
                wrote = true;
                chunk_len_ = n;
                audio::apply_volume({chunk_, chunk_len_}, audio::volume_q15(static_cast<uint8_t>(vol)));
                chunk_pcm_ = true;
                continue;
            }
            if (!wrote && !dry_) {
                dry_ = true;
                ++underruns_;
                ring_dry_total_.fetch_add(1, std::memory_order_relaxed);
            }
            return wrote;
        }
    }
    return false;
}

bool AudioOutService::stats(audio::WorkerStats &out) const
{
    out.name = name();
    out.input = false;
    out.underruns = underruns_total_.load(std::memory_order_relaxed);
    out.ring_dry = ring_dry_total_.load(std::memory_order_relaxed);
    return true;
}

// ---- fr_stream ----

void AudioOutService::stream_done(Reason why)
{
    http().close();
    got_reason_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
    got_gen_.store(get_gen_, std::memory_order_release);
    get_ = GetState::idle;
    audio::engine().wake_audio();
}

bool AudioOutService::stream_pass()
{
    const uint32_t g = req_gen_.load(std::memory_order_acquire);
    if (g != get_gen_) {
        http().close();
        get_gen_ = g;
        carry_ = false;
        prod_gen_.store(g, std::memory_order_release);  // nothing for an older play is written from here on
        get_ = static_cast<Kind>(req_kind_.load(std::memory_order_relaxed)) == Kind::play ? GetState::wait_audio
                                                                                         : GetState::idle;
        audio::engine().wake_audio();
        return true;
    }
    switch (get_) {
    case GetState::idle:
        return false;
    case GetState::wait_audio: {
        if (cons_gen_.load(std::memory_order_acquire) != g) {
            return false;
        }
        const uint32_t ip = req_ip_.load(std::memory_order_relaxed);
        if (ip == 0) {
            stream_done(Reason::net_lost);
            return true;
        }
        char host[16];
        audio::format_ipv4(ip, host, sizeof(host));
        char url[64];
        std::snprintf(url, sizeof(url), "http://%s:%u/v1/audio/out/%u", host,
                      static_cast<unsigned>(req_port_.load(std::memory_order_relaxed)),
                      static_cast<unsigned>(req_id_.load(std::memory_order_relaxed)));
        if (!http().start(url, 0)) {
            stream_done(Reason::net_lost);
            return true;
        }
        get_ = GetState::reading;
        return true;
    }
    case GetState::reading: {
        if (stop_get_.load(std::memory_order_acquire) == g) {
            http().close();
            get_ = GetState::idle;
            return true;
        }
        // Up to kGetBudget bytes a pass while the ring has room and bytes are there: the record stream's slices come
        // between passes, and nothing here waits for the hub (HttpGet::readable; nothing for kStallMs: net_lost).
        bool any = false;
        for (size_t budget = kGetBudget; budget >= sizeof(buf_);) {
            const size_t room = ring_.room();
            if (room < kMinRoom) {
                break;  // fr_audio wakes this task as it plays the ring out
            }
            const auto ready = http().readable(0);
            if (!ready) {
                stream_done(Reason::net_lost);  // nothing came for kStallMs
                return true;
            }
            if (!*ready) {
                break;  // fr_stream looks again within Engine::kWaitMs
            }
            const size_t off = carry_ ? 1 : 0;
            if (carry_) {
                buf_[0] = carry_byte_;
            }
            const size_t want = std::min(sizeof(buf_) - off, room * sizeof(int16_t) - off);
            const auto n = http().read({buf_ + off, want});
            if (!n) {
                stream_done(Reason::net_lost);  // a stall, a reset, a body cut short
                return true;
            }
            if (*n == 0) {
                stream_done(Reason::done);
                return true;
            }
            const size_t total = off + *n;
            const size_t samples = total / sizeof(int16_t);
            std::memcpy(pcm_, buf_, samples * sizeof(int16_t));  // s16le, and the chips are little-endian
            ring_.write({pcm_, samples});
            carry_ = (total & 1) != 0;
            carry_byte_ = carry_ ? buf_[total - 1] : 0;
            budget -= std::min(budget, *n);
            any = true;
            audio::engine().wake_audio();
        }
        return any;
    }
    }
    return false;
}

}  // namespace fr
