// L2 audio output service (spec 07 §7.7-7.8; design audio-a1 D2-D5, §11): fr.audio_out over any hal::AudioSink: a
// tone made on the board, or PCM pulled from the hub over its own HTTP connection. Host-buildable.
#pragma once

#include <atomic>
#include <cstdint>
#include <expected>

#include "audio_out.hpp"  // generated fr::cap::AudioOut
#include "fr/audio/dsp.hpp"
#include "fr/audio/engine.hpp"
#include "fr/audio/rings.hpp"
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/audio.hpp"

namespace fr::ota {
class HttpGet;
}

namespace fr {

/**
 * One sound at a time. The commands run on the core task and only hand work over (§11):
 *   - tone: config sample_hz; INVALID_ARGS for freq_hz at or above half of it (it would alias). fr_audio makes the sine
 *     (audio::ToneGen, 5 ms fades) and writes it; play_done {play_id 0, done} at its end.
 *   - play: INVALID_ARGS for a rate not in kAudioRates or above the sink's max_sample_hz. fr_stream GETs
 *     `/v1/audio/out/<play_id>` from the hub endpoint with fr_ota's HttpGet (Content-Length, raw s16le mono at the
 *     play's rate) into the play ring (audio::PcmRing), up to kGetBudget bytes a pass and only what has come
 *     (HttpGet::readable: after its connect and head, the GET never holds up the record stream on the same task);
 *     fr_audio starts the sink at that rate, waits for kPrebufferMs (as much as the ring takes, if less: without
 *     PSRAM 48 kHz has 161 ms; or the whole body, if shorter), then writes the ring out. A ring that runs dry while the GET goes on is played as
 *     silence and counted (underruns, with the sink's own). The end of the body, once played: play_done done; a GET
 *     that fails (no endpoint, connect, a status other than 200 or 206, a stall of kStallMs, a body cut short): what
 *     came is played, then play_done net_lost (samples 0 when nothing came). A sound that makes no progress for
 *     kStuckMs (no samples into or out of the ring, none into the sink) ends too, a play net_lost and a tone error:
 *     a backstop, so `playing` cannot stay true.
 *   - Each fr_audio pass writes until the sink takes no more without waiting (its DMA is full) or the sound has none
 *     ready: the microphone's reads pace that task, 15 ms at 16 kHz, more than one kChunk at 48 kHz. At a sound's end
 *     the sink plays out what its DMA holds (kDrainFrames) before fr_audio stops it, on a deadline it looks at, never
 *     by sleeping (the microphone's DMA on the same task holds 90 ms).
 *   - A tone or play while one runs replaces it: play_done {old id, stopped} at once, then the new one.
 *   - stop: play_done stopped (OK when nothing plays). set_volume: the volume property, applied to what plays now
 *     (audio::volume_q15: (v/100)^2; 100 passes the PCM through bit-exact). A tone's own volume holds for that tone.
 * The core timer (every 50 ms while something plays) collects the end: `playing` false and play_done {play_id,
 * reason, underruns, samples played (silence not counted)}.
 *
 * The on-board monitor (design audio-a2 D3, §10; audio::MonitorSink): an fr.audio_in on the same node claims the
 * output (monitor_claim, core task: its config sample_hz only, BUSY while a sound plays or another claim holds it),
 * writes its converted samples into the play ring on fr_audio (monitor_write; no fr_stream, no network) and releases
 * it. While claimed `playing` reads true and no play_done is sent for the monitor. fr_audio empties the ring as for a
 * play, waits for kMonitorPrebufferMs, starts the sink and writes the ring out as it fills (the claim's volume, or the
 * output's own for 0); a pass that finds the ring dry with nothing pending counts an underrun (one per dry spell, as
 * for a play) but writes no silence: the DMA plays its own (auto-clear), and the monitor's latency stays put. The ring
 * holds at most kMonitorPrebufferMs + 2 x kChunk (an input buffer and a DMA buffer of slack); monitor_write drops what
 * would go above it, so a source a little faster than the sink (adc_audio's divider runs at or above the rate) never
 * builds latency up. A tone or play takes the output from the monitor (monitor_preempted: busy), stop ends it
 * (stopped), a failed sink start or write ends it (error); the input then releases its claim.
 */
class AudioOutService final : public cap::AudioOut, private audio::Worker, private audio::MonitorSink
{
public:
    static constexpr uint32_t kPrebufferMs = 200;
    static constexpr uint32_t kStallMs = 3000;
    /** A sound with no progress this long ends: past every stall of the GET's own (connect, head, read). */
    static constexpr uint32_t kStuckMs = 10'000;
    static constexpr uint32_t kRampMs = 5;
    static constexpr uint32_t kPollUs = 50'000;
    /** Samples per sink write (one DMA buffer's worth, design D5). */
    static constexpr size_t kChunk = 240;
    /** What the sink's DMA holds at most (design D5: 6 x 240 frames): played out at the end of a sound. */
    static constexpr size_t kDrainFrames = 6 * kChunk;
    /** Body bytes fr_stream reads per pass at most (the record stream's slices come between). */
    static constexpr size_t kGetBudget = 4096;
    /** A monitor's ring before the sink starts: short, so live listening feels immediate (design audio-a2 D3). */
    static constexpr uint32_t kMonitorPrebufferMs = 30;

    AudioOutService(hal::AudioSink &sink, const cap::AudioOutConfig &cfg);
    ~AudioOutService();
    AudioOutService(const AudioOutService &) = delete;
    AudioOutService &operator=(const AudioOutService &) = delete;

    /** Initialises the sink (muted), allocates the play ring (fr/audio/rings.hpp) and joins the Engine. */
    Status init(Core &core);
    hal::Selftest selftest();

    Status tone(const cap::AudioOutToneArgs &args) override;
    Status play(const cap::AudioOutPlayArgs &args) override;
    Status stop() override;
    Status set_volume(const cap::AudioOutSetVolumeArgs &args) override;
    bool playing() const override { return playing_; }
    /** Samples monitor_write dropped (above the latency cap, or before fr_audio took the claim up) since init. */
    uint32_t monitor_dropped() const { return mon_dropped_.load(std::memory_order_relaxed); }
    uint8_t volume() const override { return volume_.load(std::memory_order_relaxed); }
    cap::AudioOutTraits traits() const override;

private:
    enum class Kind : uint8_t { none, tone, play, monitor };
    enum class OutState : uint8_t { idle, tone, wait_stream, prebuffer, playing, draining, monitor_prebuffer, monitor };
    enum class GetState : uint8_t { idle, wait_audio, reading };

    // audio::Worker
    bool is_input() const override { return false; }
    bool audio_pass(uint32_t wait_ms) override;
    bool stream_pass() override;
    bool stats(audio::WorkerStats &out) const override;
    uint8_t worker_port() const override { return port(); }
    audio::MonitorSink *monitor_sink() override { return this; }

    // audio::MonitorSink
    std::expected<uint32_t, Err> monitor_claim(uint32_t sample_hz, uint8_t volume) override;
    size_t monitor_write(uint32_t claim, std::span<const int16_t> pcm) override;
    void monitor_finish(uint32_t claim) override;
    void monitor_release(uint32_t claim) override;
    audio::MonitorEnd monitor_preempted(uint32_t claim) const override;

    void on_timer();
    /** Core task: a tone, play or stop takes the output from the monitor that holds it (`why` its end). */
    bool take_monitor(audio::MonitorEnd why);
    void arm();
    /** Core task: a new job (kind none: stop), replacing what plays. */
    void publish(Kind kind);
    void end_current();

    // fr_audio
    bool start_sink(uint32_t hz);
    void stop_sink(uint32_t drain_ms);
    /** Adds the sink's starved buffers since the last look to underruns_total_ (a sound running). */
    void count_sink();
    /** Writes the pending chunk; true when all of it went. */
    bool flush(uint32_t wait_ms);
    void finish(cap::AudioOutPlayEndReason why);
    /** A monitor's sink failed: the claim is given back (MonitorEnd::error), the sink stopped. */
    void monitor_fail();
    bool monitoring_out() const { return out_ == OutState::monitor_prebuffer || out_ == OutState::monitor; }
    /** The sound moved (a state, samples into or out of the ring or into the sink): the kStuckMs backstop restarts. */
    void progress();
    bool stuck() const;
    // fr_stream
    void stream_done(cap::AudioOutPlayEndReason why);

    hal::AudioSink &sink_;
    cap::AudioOutConfig cfg_;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    bool ready_ = false;
    int16_t *ring_mem_ = nullptr;

    // ---- core task ----
    bool playing_ = false;
    uint32_t play_id_ = 0;
    uint32_t gen_ = 0;
    uint32_t mon_core_ = 0;  // the monitor claim that holds the output (its job gen; 0: none)

    // ---- core -> tasks: the job, published by req_gen_ (release) ----
    std::atomic<uint8_t> req_kind_{0};
    std::atomic<uint32_t> req_freq_{0};
    std::atomic<uint32_t> req_samples_{0};
    std::atomic<uint32_t> req_volume_{0xFF};  // a tone's own volume; 0xFF: the current one
    std::atomic<uint32_t> req_rate_{0};
    std::atomic<uint32_t> req_id_{0};
    std::atomic<uint32_t> req_ip_{0};
    std::atomic<uint32_t> req_port_{0};
    std::atomic<uint32_t> req_gen_{0};
    std::atomic<uint8_t> volume_;

    // ---- between the tasks ----
    audio::PcmRing ring_;
    std::atomic<uint32_t> prod_gen_{0};  // fr_stream: it writes nothing older than this gen any more
    std::atomic<uint32_t> cons_gen_{0};  // fr_audio: the ring is emptied for this gen, fr_stream may fill it
    std::atomic<uint32_t> got_gen_{0};   // fr_stream: this gen's GET ended (all it got is in the ring)
    std::atomic<uint8_t> got_reason_{0};
    std::atomic<uint32_t> stop_get_{0};  // fr_audio: this gen's sound ended, its GET is not wanted any more

    // ---- tasks -> core ----
    std::atomic<uint8_t> end_reason_{0};
    std::atomic<uint32_t> end_underruns_{0};
    std::atomic<uint32_t> end_samples_{0};
    std::atomic<uint32_t> end_gen_{0};
    std::atomic<uint32_t> cur_samples_{0};  // the sound playing now (for play_done stopped)
    std::atomic<uint32_t> cur_underruns_{0};
    std::atomic<uint32_t> underruns_total_{0};  // since init (diag `stats audio`): the sink's starved buffers
    std::atomic<uint32_t> ring_dry_total_{0};   // ... and the play ring's dry spells
    // The monitor claim (core task writes; fr_audio gives it back on a sink failure), and why it was taken.
    std::atomic<uint32_t> mon_claim_{0};
    std::atomic<uint8_t> mon_taken_{0};  // audio::MonitorEnd, set before mon_claim_ leaves the claim
    std::atomic<uint32_t> mon_dropped_{0};

    // ---- fr_audio only ----
    OutState out_ = OutState::idle;
    uint32_t job_gen_ = 0;
    uint32_t job_rate_ = 0;
    uint32_t job_volume_ = 0xFF;
    uint32_t sink_rate_ = 0;  // 0: stopped
    uint32_t sink_underruns0_ = 0;
    uint32_t sink_seen_ = 0;  // the sink's underruns() already in underruns_total_
    TimeUs drain_until_ = 0;  // draining: the sink stops then
    TimeUs progress_at_ = 0;
    size_t ring_seen_ = 0;    // prebuffer: the ring's size when last looked at
    uint32_t samples_ = 0;
    uint32_t underruns_ = 0;
    audio::ToneGen tone_;
    int16_t chunk_[kChunk] = {};
    size_t chunk_len_ = 0;
    size_t chunk_off_ = 0;
    bool chunk_pcm_ = false;  // the pending chunk is PCM or tone (counted as played), not silence
    bool dry_ = false;        // the ring ran dry (one underrun per dry spell)
    bool job_monitor_ = false;  // the job is a monitor (wait_stream then monitor_prebuffer)

    // ---- fr_stream only ----
    GetState get_ = GetState::idle;
    uint32_t get_gen_ = 0;
    bool carry_ = false;  // an odd byte from the last read
    uint8_t carry_byte_ = 0;
    uint8_t buf_[1024] = {};
    int16_t pcm_[512] = {};
    // fr_ota's HttpGet, built in here (as AudioInService's HttpPost: fr_ota's header stays out of this one).
    alignas(8) unsigned char get_store_[640];
    ota::HttpGet &http();
};

}  // namespace fr
