// L2 camera service (spec 07 §7.7-7.8; design camera-c1 D7, D8, D10, §10): fr.camera over any hal::Camera, with an
// optional hal::BlockStore (the card) as its store; JPEG frames streamed to the hub over their own HTTP connection
// (mjpg1, one frame per chunk) and/or written to the card as a recording. Host-buildable.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <expected>

#include "camera.hpp"  // generated fr::cap::Camera
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/block_store.hpp"
#include "fr/hal/camera.hpp"
#include "fr/stream/stream.hpp"

namespace fr::ota {
class HttpPost;
}

namespace fr {

/**
 * Two contexts, as fr.csi's (they meet in atomics published with release, read with acquire):
 *   - fr_stream (stream::Worker::stream_pass): a stream is a worker pass per frame: grab the newest frame
 *     (hal::Camera::grab, CAMERA_GRAB_LATEST), then by `to`: hub, one mjpg1 block (the 24-byte head of design D10, then
 *     the JPEG) through HttpPost in slices of kSendSliceMs (the frame's buffer held until the chunk has gone), a block
 *     not gone in kStallMs ending the stream net_lost; sd, the frame written whole to the open recording
 *     (hal::BlockStore::write_frame; a refusal ends it overflow); both, the card first, then the hub (a hub send that
 *     fails ends it net_lost with the recording kept). interval_ms paces by the frame's start time: slot k is at
 *     start + k * interval_ms, the newest frame is taken at the first pass at or after a slot, and the slots that went
 *     by while the path was still busy with the previous frame are `dropped` (their indices skipped, so the hub sees
 *     the gap); with interval_ms 0 the newest frame is taken as soon as the path is free and nothing is dropped.
 *     `seconds` and `max_frames` end it done. A frame longer than kFrameMaxBytes is dropped and counted; a frame the
 *     hub path cannot take (HttpPost refuses the chunk) is dropped and counted too. `dropped` is frames the stream
 *     could not take; a pass whose grab brought nothing (the sensor starved: no frame in kGrabTimeoutMs) is counted
 *     apart in starved() and not in `dropped` (with interval_ms the slot it misses is dropped when the next frame
 *     comes). A stream with no frame from the sensor for kNoFrameMs ends `error` (esp32-camera queues nothing while
 *     frames overflow its buffer, design §9). The head's width, height and frame_size are the frame's own, read from
 *     its SOF0 (a frame captured before a mid-stream `set frame_size` took effect is labelled with the size it has);
 *     the applied size stands in only when the markers are missing. sd_fetch is the same pass reading frames from the
 *     card (read_frame, from from_frame until not_found) instead of the sensor, flags b0 set, quality 0 (unknown).
 *     The recording a stream writes (`to` sd or both) takes the stream id as its id and its frames are numbered as
 *     written (0, 1, ...: a dropped slot leaves no hole on the card), so the hub's index and the card's can differ by
 *     `dropped`.
 *     The store's walks run here too (hal::BlockStore: every call but init is fr_stream's): the list cache is filled
 *     at the first pass, after every recording's close and after every delete (hal::BlockStore::list paged into it,
 *     up to kListCacheMax recordings; a card with more lists the first ones by id); a delete the core asked for
 *     (sd_delete) runs at the start of a pass while no stream runs (one asked for during a stream runs right after
 *     it); sd_fetch's recording is checked with hal::BlockStore::info at the stream's begin (gone since the cache
 *     said so: the stream ends `error`).
 *   - the core task: the commands and one timer (every kFpsWindowMs, every kStreamPollMs while a stream runs), which
 *     reports `frames` and `last_bytes` when they changed, `fps_x10` over the last kFpsWindowMs when it changed,
 *     `streaming` at a stream's start (from the command) and end, `sd` and `sd_free_mb` when they changed (the first
 *     tick after init reports both; a delete's freed space shows at the tick after it completes), and collects a
 *     stream's end into stream_ended {stream_id, reason, frames (the index reached, dropped ones counted), dropped,
 *     bytes (JPEG bytes sent and/or written, a frame once, saturating at UINT32_MAX)}. It never calls the store but
 *     for state() and free_mb(): sd_list answers from the cache (under a short lock; `from` past it is empty with next
 *     0), sd_delete queues the id for fr_stream and answers OK at once, sd_fetch checks the cache for NOT_FOUND.
 *
 * The sensor is touched by the fr_stream task only, after init: `set` (and a stream's own frame_size / quality, for
 * that stream only) is kept here and published to fr_stream, which applies what differs from the sensor's state at
 * the start of its next pass, never beside a grab (hal::Camera::set's contract); idle, the pass runs within the
 * Engine's wait, so a `set` with no stream running reaches the sensor at once, and a stream started right after it
 * applies it before its first grab. At a stream's end the kept settings are applied again (the stream's own go). The
 * first pass after init applies the kept settings once (hal::Camera::set writes only what differs from the sensor's
 * state: nothing when start() honoured them all). A set the sensor refuses is made again on the next kSetRetries
 * passes (the driver keeps the refused fields as unapplied), then taken as done until the next change.
 *
 * init brings the sensor up (hal::Camera::start with the config's max_frame_size, fb_count, xclk_hz and settings; a
 * failure is the port's init failure) and mounts the card when config `sd` is true and a store is wired (state none is
 * not a failure; a host fault at the mount is logged by the driver, leaves state error and the camera runs without
 * its store). stream_start: BUSY while a stream runs; INVALID_ARGS for `to` sd or both without a mounted card, or a
 * frame_size above max_frame_size; FAILED before init. set: INVALID_ARGS past max_frame_size. sd_list, sd_fetch and
 * sd_delete answer UNSUPPORTED without a mounted card; sd_list pages through the cache (64 a page, BULK); sd_fetch is
 * BUSY while a stream runs or a delete is pending and NOT_FOUND for a recording not in the cache; sd_delete is BUSY
 * for the recording a stream writes or reads and while a delete is pending.
 */
class CameraService final : public cap::Camera, private stream::Worker
{
public:
    /** The store is the profile's `store` (design §10): nullptr on a board without a card slot. */
    CameraService(hal::Camera &cam, hal::BlockStore *store, const cap::CameraConfig &cfg);
    ~CameraService();
    CameraService(const CameraService &) = delete;
    CameraService &operator=(const CameraService &) = delete;

    Status init(Core &core);
    hal::Selftest selftest();

    /** The mjpg1 block head (design camera-c1 D10): seq, index, t_us, width, height, quality, frame_size, flags, len. */
    static constexpr size_t kHeadBytes = 24;
    /** flags b0: the frame comes from the card (sd_fetch). */
    static constexpr uint16_t kFlagFromCard = 1u << 0;
    /** A frame longer than this is dropped and counted (hal::kFrameMaxBytes). */
    static constexpr size_t kFrameMaxBytes = hal::kFrameMaxBytes;
    /** The fr_stream task never holds a pass longer than this on its socket (as fr.csi's). */
    static constexpr uint32_t kSendSliceMs = 20;
    /** A connect or a block not gone in this ends the stream net_lost (design D8). */
    static constexpr uint32_t kStallMs = 3000;
    /** grab()'s wait per pass while a stream runs: the slowest sensor frame (UXGA, about 80 ms) with room. */
    static constexpr uint32_t kGrabTimeoutMs = 500;
    /** A stream with no frame from the sensor for this long ends `error` (the sensor overflowing its buffer, or dead). */
    static constexpr uint32_t kNoFrameMs = 5000;
    /** The fps window and the core timer's period while frames come. */
    static constexpr uint32_t kFpsWindowMs = 1000;
    /** The core timer's period while a stream runs (its end is collected within this). */
    static constexpr uint32_t kStreamPollMs = 50;
    /** The head's frame_size for a frame whose size is none of FrameSize's (a fetched frame of another size). */
    static constexpr uint8_t kFrameSizeUnknown = 0xFF;
    /** The list cache: recordings sd_list can answer with (a card with more lists the first ones by id). */
    static constexpr uint32_t kListCacheMax = 128;
    /** A set the sensor refuses is made again on this many passes, then taken as done until the next change. */
    static constexpr uint8_t kSetRetries = 3;

    Status stream_start(const cap::CameraStreamStartArgs &args) override;
    Status stream_stop(const cap::CameraStreamStopArgs &args) override;
    Status set(const cap::CameraSetArgs &args) override;
    std::expected<cap::CameraSdListResult, Err> sd_list(const cap::CameraSdListArgs &args) override;
    Status sd_fetch(const cap::CameraSdFetchArgs &args) override;
    Status sd_delete(const cap::CameraSdDeleteArgs &args) override;

    uint32_t frames() const override { return frames_; }
    uint16_t fps_x10() const override { return fps_x10_; }
    uint32_t last_bytes() const override { return last_bytes_; }
    bool streaming() const override { return streaming_; }
    cap::CameraCardState sd() const override;
    uint32_t sd_free_mb() const override;
    cap::CameraTraits traits() const override;

    /** The card the profile wired (nullptr: none); tests and the glue read it. */
    hal::BlockStore *store() const { return store_; }
    /** The settings kept until reboot (the config's, then every `set`). Core task. */
    const hal::CameraSettings &settings() const { return settings_; }
    /** The newest stream's hub answer (0: none) and the frames the hub counted in it. */
    int last_status() const { return last_status_.load(std::memory_order_relaxed); }
    uint32_t last_hub_frames() const { return hub_frames_.load(std::memory_order_relaxed); }
    /** Passes of a stream whose grab brought no frame in kGrabTimeoutMs, since boot (not in `dropped`). Any task. */
    uint32_t starved() const { return starved_.load(std::memory_order_relaxed); }
    /** A delete is queued or running on fr_stream. Any task. */
    bool delete_pending() const { return del_busy_.load(std::memory_order_acquire); }

    /** The 24-byte head (design D10) into `out`. */
    static void encode_head(uint8_t *out, uint32_t seq, uint32_t index, uint32_t t_us, uint16_t width, uint16_t height,
                            uint8_t quality, uint8_t frame_size, uint16_t flags, uint32_t len);
    /** A JPEG's SOF0/SOF2 dimensions (width, height); false when the markers are not there. */
    static bool jpeg_dims(std::span<const uint8_t> jpeg, uint16_t &width, uint16_t &height);

private:
    enum class StreamState : uint8_t { idle, connecting, streaming };
    /** The job's `to`, with sd_fetch as a fourth kind. */
    enum class To : uint8_t { hub = 0, sd = 1, both = 2, fetch = 3 };

    /** The recordings sd_list answers with: fr_stream writes it whole under cache_lock_, the core copies a page. */
    struct ListCache {
        std::array<hal::Recording, kListCacheMax> recs{};
        uint32_t count = 0;
    };

    // stream::Worker (fr_stream)
    bool stream_pass() override;

    // core task
    void on_timer();
    void arm();
    void publish_settings();
    Status begin_job(To to, uint32_t stream_id, uint16_t seconds, uint32_t interval_ms, uint32_t max_frames,
                     uint8_t frame_size, uint8_t quality, uint32_t recording, uint32_t from_frame);
    /** The cache holds `id`. Core task (a short lock). */
    bool cached(uint32_t id);

    // fr_stream
    void begin_stream(uint32_t gen, TimeUs now);
    bool apply_settings();
    bool connect_step(TimeUs now);
    bool stream_step(TimeUs now);
    bool take_frame(TimeUs now);
    bool end_step();
    bool answer_step();
    void finish(cap::CameraStreamEndReason why);
    void abort_stream(cap::CameraStreamEndReason why);
    void drop_frame();
    void publish_end(cap::CameraStreamEndReason why);
    void close_card();
    void refresh_cache();
    void run_delete();
    void add_bytes(uint32_t n);
    bool needs_hub() const { return to_ != To::sd; }
    bool needs_card() const { return to_ == To::sd || to_ == To::both; }

    hal::Camera &cam_;
    hal::BlockStore *store_;
    cap::CameraConfig cfg_;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    std::atomic<bool> inited_{false};  // set at the end of init (release); fr_stream's pass reads it (acquire)

    // ---- core task ----
    uint32_t frames_ = 0;
    uint16_t fps_x10_ = 0;
    uint32_t last_bytes_ = 0;
    bool streaming_ = false;
    uint32_t stream_id_ = 0;
    uint32_t stream_recording_ = 0;  // the recording the stream writes or reads (0: none): sd_delete is BUSY for it
    uint32_t gen_ = 0;
    hal::CameraSettings settings_{};
    uint8_t sd_reported_ = 0xFF;
    uint32_t sd_free_reported_ = UINT32_MAX;
    TimeUs fps_at_ = 0;
    uint32_t fps_frames_ = 0;
    char device_[13] = {};

    // ---- core -> fr_stream: the job, published by req_gen_ (release); the kept settings, packed; a delete ----
    std::atomic<uint32_t> req_id_{0};
    std::atomic<uint32_t> req_seconds_{0};
    std::atomic<uint32_t> req_interval_ms_{0};
    std::atomic<uint32_t> req_max_frames_{0};
    std::atomic<uint8_t> req_to_{0};
    std::atomic<uint8_t> req_frame_size_{0xFF};  // 0xFF: the kept one
    std::atomic<uint8_t> req_quality_{0};        // 0: the kept one
    std::atomic<uint32_t> req_recording_{0};
    std::atomic<uint32_t> req_from_frame_{0};
    std::atomic<uint32_t> req_ip_{0};  // 0: no endpoint
    std::atomic<uint32_t> req_port_{0};
    std::atomic<uint32_t> req_gen_{0};
    std::atomic<uint32_t> stop_gen_{0};
    std::atomic<uint64_t> kept_{0};
    std::atomic<uint32_t> del_id_{0};       // the recording sd_delete queued (written before del_busy_'s release)
    std::atomic<bool> del_busy_{false};     // set by sd_delete (release), cleared by fr_stream when done (release)

    // ---- fr_stream -> core: published by end_gen_ (release), the counters relaxed ----
    std::atomic<uint8_t> end_reason_{0};
    std::atomic<uint32_t> end_frames_{0};
    std::atomic<uint32_t> end_dropped_{0};
    std::atomic<uint32_t> end_bytes_{0};
    std::atomic<uint32_t> end_gen_{0};
    std::atomic<uint32_t> frames_total_{0};  // frames the sensor delivered since boot (property `frames`)
    std::atomic<uint32_t> last_bytes_a_{0};
    std::atomic<int> last_status_{0};
    std::atomic<uint32_t> hub_frames_{0};
    std::atomic<uint32_t> starved_{0};  // grabs that brought nothing, since boot (starved())

    // ---- the list cache: fr_stream writes, the core reads, both under cache_lock_ (audio::Rt's mutex) ----
    void *cache_lock_ = nullptr;
    ListCache cache_{};

    // ---- fr_stream only ----
    StreamState st_ = StreamState::idle;
    uint32_t st_gen_ = 0;
    To to_ = To::hub;
    uint64_t applied_ = 0;  // the settings the sensor has (packed); UINT64_MAX before the first pass applies the kept ones
    uint8_t set_fails_ = 0;  // passes in a row the sensor refused the wanted settings
    uint8_t override_frame_size_ = 0xFF;
    uint8_t override_quality_ = 0;
    uint32_t seq_ = 0;       // chunks sent
    uint32_t index_ = 0;     // the next frame's index (dropped ones counted)
    uint32_t dropped_ = 0;
    uint32_t bytes_ = 0;
    uint32_t frames_sent_ = 0;
    uint32_t card_index_ = 0;  // frames written to the open recording
    uint32_t fetch_index_ = 0;
    uint32_t recording_ = 0;
    TimeUs interval_us_ = 0;
    TimeUs next_at_ = 0;   // the next slot
    bool first_slot_ = true;  // no frame taken yet: the slots run from the first one's start
    TimeUs deadline_ = 0;  // 0: until stream_stop
    TimeUs last_frame_at_ = 0;  // the stream's start (or connect), then every frame the sensor gave: kNoFrameMs runs from it
    uint32_t max_frames_ = 0;
    bool card_open_ = false;
    bool have_frame_ = false;
    bool sending_ = false;  // the frame's chunk is in flight
    bool finishing_ = false;
    bool answering_ = false;
    bool cache_fresh_ = false;  // the first pass fills the cache
    cap::CameraStreamEndReason finish_reason_ = cap::CameraStreamEndReason::stopped;
    hal::Frame frame_{};
    uint32_t frame_len_ = 0;
    uint8_t *fetch_buf_ = nullptr;  // kFrameMaxBytes while a fetch runs
    uint8_t head_[kHeadBytes] = {};
    ListCache staging_{};  // the cache being refilled (the card read without the lock, then copied under it)
    // fr_ota's HttpPost, built in here by the constructor (fr_core requires fr_ota privately; see CsiService).
    alignas(8) unsigned char post_store_[1024];
    ota::HttpPost &post();
};

}  // namespace fr
