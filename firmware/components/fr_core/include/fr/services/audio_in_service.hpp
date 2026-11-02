// L2 audio input service (spec 07 §7.7-7.8; design audio-a1 D1, D3-D5, §11): fr.audio_in over any hal::AudioSource,
// streaming to the hub over its own HTTP connection. Host-buildable.
#pragma once

#include <atomic>
#include <cstdint>
#include <expected>

#include "audio_in.hpp"  // generated fr::cap::AudioIn
#include "fr/audio/dsp.hpp"
#include "fr/audio/engine.hpp"
#include "fr/audio/rings.hpp"
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/audio.hpp"

namespace fr::ota {
class HttpPost;
}

namespace fr {

/**
 * The commands run on the core task and only hand work over (§11: no deferred results): stream_start checks the rate
 * (INVALID_ARGS: not in kAudioRates or above the source's max_sample_hz) and that no stream runs (BUSY), takes the
 * hub endpoint from the runtime (audio::StreamHost), publishes the job and answers {sample_hz}. Everything after is
 * on the Engine's tasks:
 *   - fr_audio starts the source at the stream's rate and, after every start, warms it up: the first kWarmupMs are
 *     dropped (the part's power-up: they reach neither the stream, the meter nor the clipping count), the DC blocker
 *     is primed from the first kept sample, and for kSettleMs it glides from kSettleHz down to hpf_hz, following the
 *     part's start-up drift (audio::Converter::settle; hpf_hz 0: no blocker, the warm-up only). The stream's sample 0
 *     is the first kept one; the meter starts once the glide is over. It converts each DMA buffer (DC blocker,
 *     gain_db, saturation counted as clipping), feeds the meter and fills 100 ms blocks into the record ring
 *     (audio::RecordRing), each with the index of its first sample since the stream began. When the ring is full the
 *     oldest queued block is dropped and counted (D4). It ends the capture at
 *     `seconds` (seconds x rate samples; 0: no limit) or at stream_stop, the last block possibly shorter. DMA buffers
 *     the driver lost (hal::AudioSource::overruns) come back as zeros, so the stream keeps time; they are counted in
 *     dma_lost(), not in dropped_samples.
 *   - fr_stream POSTs the stream to the hub (wire format below) and sends each block as it is published.
 * The core timer (every 50 ms while anything runs) reports `level` for each closed meter window when level_hz > 0, and
 * collects the end: `streaming` false and stream_ended {stream_id, reason, samples, dropped_samples}, where samples is
 * what the stream covered (sent and dropped) and dropped_samples the ring's drops. Reasons: done (`seconds` reached),
 * stopped (stream_stop), net_lost (no endpoint, a connect failure, a send blocked kStallMs, a closed connection, an
 * answer other than 200: samples and dropped_samples are 0 when it never connected), error (the source failed).
 * overflow is not used.
 *
 * Wire (stream H's server implements it): `POST /v1/audio/in/<stream_id> HTTP/1.1` to the endpoint, headers Host,
 * `Transfer-Encoding: chunked`, `Connection: close`, `X-Fr-Device: <device_id>`, `X-Fr-Format: s16le;rate=<hz>;ch=1`.
 * Each HTTP chunk is one block: `seq` u32 LE (the chunks sent, 0, 1, 2... without gaps), `first_sample` u32 LE, then
 * s16le PCM, rate/10 samples, the last block possibly fewer; a drop shows only as a jump of first_sample. The
 * zero-length chunk ends it; the hub answers 200 with `{"samples":N}`, which is read before the close. A refusal the
 * hub sends early (a 404 for a stream id it did not issue) ends the stream at once. fr_stream sends a block in slices
 * of kSendSliceMs (fr_ota's HttpPost::pump), so the play GET it also serves is read between them; a block that has
 * not gone in kStallMs in all ends the stream net_lost.
 *
 * level_get answers at once with the newest closed window and the clipping count since the source started (-900 before
 * any); with the source idle it also runs it at config sample_hz for the warm-up, the glide and then kMeterRunMs (or
 * one window, if longer) of measurement, about 800 ms in all at level_hz 5, on fr_audio's time: `level` STATEs follow
 * (at level_hz) and a level_get after that reads the room, not the part's start-up. The meter's window is 1/level_hz
 * (level_hz 0: 200 ms).
 *
 * selftest never touches the source on the core task: fr_audio runs it (start at config sample_hz, frames within
 * kTestMs, stop) once at init and again after each selftest(), which answers the newest result.
 */
class AudioInService final : public cap::AudioIn, private audio::Worker
{
public:
    /**
     * The source's power-up, dropped after every start. Measured on the bench (INMP441 on the S3, 16 kHz, gain 12 dB,
     * 2026-11-02): its first 100 ms saturate (143 samples at +32767).
     */
    static constexpr uint32_t kWarmupMs = 100;
    /**
     * Then the DC blocker's glide from kSettleHz to hpf_hz. Measured on the same bench: after the warm-up the part's
     * offset drifts for about 0.6 s (100 ms means through a 20 Hz blocker -2351, -1695, -1080, -634, -368, -114, then
     * about 0), a start-up of its own that hpf_hz alone passes.
     */
    static constexpr uint32_t kSettleMs = 500;
    static constexpr uint16_t kSettleHz = 200;
    /** A level_get on an idle source measures this long (at least one window) after the warm-up and the glide. */
    static constexpr uint32_t kMeterRunMs = 200;
    /** fr_audio's self-test: frames must come within this long of the start. */
    static constexpr uint32_t kTestMs = 200;
    /** fr_stream sends a block for at most this long per pass, then serves the other streams. */
    static constexpr uint32_t kSendSliceMs = 20;
    /** A send that cannot go on this long, or a connect or answer that takes it, ends the stream net_lost (D3). */
    static constexpr uint32_t kStallMs = 3000;
    /** The core timer's period while the service is active. */
    static constexpr uint32_t kPollUs = 50'000;
    /** Frames per converter read: one DMA buffer (design D5: 6 x 240 frames). */
    static constexpr size_t kReadFrames = 240;

    AudioInService(hal::AudioSource &src, const cap::AudioInConfig &cfg);
    ~AudioInService();
    AudioInService(const AudioInService &) = delete;
    AudioInService &operator=(const AudioInService &) = delete;

    /** Initialises the source, allocates the record ring (fr/audio/rings.hpp) and joins the Engine, whose tasks start. */
    Status init(Core &core);
    /**
     * The newest self-test fr_audio ran (it starts another): the source starts and its DMA delivers. While a stream or
     * the meter runs it answers ok (fr_audio has the source). Never blocks the core task.
     */
    hal::Selftest selftest();

    std::expected<cap::AudioInStreamStartResult, Err> stream_start(const cap::AudioInStreamStartArgs &args) override;
    Status stream_stop(const cap::AudioInStreamStopArgs &args) override;
    std::expected<cap::AudioInLevelGetResult, Err> level_get() override;
    int16_t level() const override { return level_; }
    bool streaming() const override { return streaming_; }
    cap::AudioInTraits traits() const override;

    /** DMA buffers' worth of frames the driver lost (put back as zeros) since init. */
    uint32_t dma_lost() const { return dma_lost_.load(std::memory_order_relaxed); }
    /** The newest stream's hub answer status (0: none) and how many samples the hub said it got. */
    int last_status() const { return last_status_.load(std::memory_order_relaxed); }
    uint32_t last_hub_samples() const { return hub_samples_.load(std::memory_order_relaxed); }

private:
    enum class StreamState : uint8_t { idle, streaming, aborting };
    enum class TestResult : uint8_t { none, ok, no_start, no_frames, read_failed };

    // audio::Worker
    bool is_input() const override { return true; }
    bool audio_pass(uint32_t wait_ms) override;
    bool stream_pass() override;
    bool stats(audio::WorkerStats &out) const override;
#if FR_TEST_HOOKS
    Status stall(uint32_t ms) override;
#endif

    void on_timer();
    void arm();

    // fr_audio
    void set_rate(uint32_t hz);
    void test_done(TestResult r);
    void capture(std::span<const int16_t> pcm);
    void publish_fill();
    void end_capture(cap::AudioInStreamEndReason why);
    // fr_stream
    void begin_stream(uint32_t gen);
    void abort_stream(cap::AudioInStreamEndReason why, bool connected);
    void publish_end(cap::AudioInStreamEndReason why, uint32_t samples, uint32_t dropped);

    hal::AudioSource &src_;
    cap::AudioInConfig cfg_;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    bool ready_ = false;
    int16_t *ring_mem_ = nullptr;

    // ---- core task ----
    bool streaming_ = false;
    uint32_t stream_id_ = 0;
    uint32_t gen_ = 0;  // the newest stream's
    int16_t level_ = audio::kSilenceDbfsX10;
    uint32_t level_seen_ = 0;
    uint32_t idle_ticks_ = 0;
    char device_[13] = {};

    // ---- core -> tasks: the job, published by req_gen_ (release) ----
    std::atomic<uint32_t> req_id_{0};
    std::atomic<uint32_t> req_rate_{0};
    std::atomic<uint32_t> req_max_{0};  // samples; 0: until stream_stop
    std::atomic<uint32_t> req_ip_{0};   // 0: no endpoint
    std::atomic<uint32_t> req_port_{0};
    std::atomic<uint32_t> req_gen_{0};
    std::atomic<uint32_t> stop_gen_{0};
    std::atomic<uint32_t> meter_req_{0};
    std::atomic<uint32_t> test_req_{0};
    std::atomic<uint32_t> stall_ms_{0};
    std::atomic<uint32_t> stall_seq_{0};

    // ---- between the tasks ----
    audio::RecordRing ring_;
    std::atomic<uint32_t> cap_go_{0};     // fr_stream -> fr_audio: capture for this gen (the ring is reset)
    std::atomic<uint32_t> cap_abort_{0};  // fr_stream -> fr_audio: stop capturing this gen, nothing more is sent
    std::atomic<uint32_t> cap_done_{0};   // fr_audio -> fr_stream: this gen's capture ended, its last block published
    std::atomic<uint8_t> cap_reason_{0};  // how (AudioInStreamEndReason), set before cap_done_
    std::atomic<uint32_t> cap_total_{0};  // samples captured (dropped ones included), set before cap_done_

    // ---- tasks -> core: published by end_gen_ / level_seq_ (release) ----
    std::atomic<uint8_t> end_reason_{0};
    std::atomic<uint32_t> end_samples_{0};
    std::atomic<uint32_t> end_dropped_{0};
    std::atomic<uint32_t> end_gen_{0};
    std::atomic<int16_t> level_dbfs_{audio::kSilenceDbfsX10};
    std::atomic<int16_t> level_peak_{audio::kSilenceDbfsX10};
    std::atomic<uint32_t> level_seq_{0};
    std::atomic<uint32_t> clipping_{0};
    std::atomic<bool> running_{false};  // fr_audio has the source started
    std::atomic<uint32_t> dma_lost_{0};
    std::atomic<uint32_t> rx_overflows_{0};  // since init (diag `stats audio`), as clip_total_
    std::atomic<uint32_t> clip_total_{0};
    std::atomic<int> last_status_{0};
    std::atomic<uint32_t> hub_samples_{0};
    std::atomic<uint8_t> test_result_{0};  // TestResult of the newest self-test

    // ---- fr_audio only ----
    audio::Converter conv_;
    audio::Meter meter_;
    uint32_t rate_ = 0;  // the source's running rate (0: stopped)
    uint32_t warm_ = 0;    // frames of the warm-up still to drop
    uint32_t settle_ = 0;  // kept frames still in the glide (the meter skips them)
    uint32_t meter_left_ = 0;
    uint32_t meter_seen_ = 0;
    uint32_t test_seen_ = 0;
    bool testing_ = false;
    TimeUs test_until_ = 0;
    uint32_t overruns_seen_ = 0;
    uint32_t clip_seen_ = 0;  // conv_'s clipping already in clip_total_
    uint32_t cap_gen_ = 0;  // the gen being captured (0: none)
    uint32_t cap_last_ = 0;  // the newest gen whose capture ended
    uint32_t cap_rate_ = 0;
    uint32_t cap_max_ = 0;
    uint32_t cap_samples_ = 0;  // the next sample's index since the stream began
    std::span<int16_t> fill_;
    uint32_t fill_len_ = 0;
    uint32_t fill_first_ = 0;
    uint32_t stall_seen_ = 0;
    uint32_t stall_from_ = 0;
    uint32_t stall_to_ = 0;
    int32_t frames_[kReadFrames] = {};
    int16_t pcm_[kReadFrames] = {};

    // ---- fr_stream only ----
    StreamState st_ = StreamState::idle;
    uint32_t st_gen_ = 0;
    uint32_t seq_ = 0;
    uint32_t sent_samples_ = 0;  // the end of the last block sent
    bool sending_ = false;       // a block is in flight: HttpPost::pump goes on with it
    uint32_t sending_end_ = 0;   // its end (first_sample + len)
    uint8_t head_[8] = {};       // its seq and first_sample
    cap::AudioInStreamEndReason abort_reason_ = cap::AudioInStreamEndReason::net_lost;
    uint32_t abort_dropped_ = 0;
    // fr_ota's HttpPost, built in here by the constructor: fr_core requires fr_ota privately, so its header stays out
    // of this one (the generated fr_board includes it and sees fr_core only).
    alignas(8) unsigned char post_store_[1024];
    ota::HttpPost &post();
};

}  // namespace fr
