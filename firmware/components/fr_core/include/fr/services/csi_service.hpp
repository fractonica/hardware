// L2 CSI service (spec 07 §7.7-7.8; design csi-c1 D7, D8, D10, D11, §12): fr.csi over any hal::CsiSource, its raw
// records streamed to the hub over their own HTTP connection. Host-buildable.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <expected>

#include "csi.hpp"  // generated fr::cap::Csi
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/csi/csi.hpp"
#include "fr/hal/csi.hpp"
#include "fr/stream/stream.hpp"

#if defined(ESP_PLATFORM)
#include "sdkconfig.h"
#endif

namespace fr::ota {
class HttpPost;
}

namespace fr {

/**
 * Three contexts, as fr.audio_in's (they meet only in atomics, published with release, read with acquire, and the
 * record ring):
 *   - the Wi-Fi task: on_csi copies each record the source keeps into the ring (csi::RecordRing; full, the newest is
 *     dropped and counted) and returns;
 *   - fr_stream (the Engine's stream task: Engine::add_stream, start_stream): takes the records out, computes the
 *     features (csi::Motion; `rssi` the window's mean, `rate` the records of the last second) for each 1/features_hz
 *     window, and while a stream runs puts each record into the block being filled and POSTs the blocks. Its socket
 *     never holds a pass longer than kSendSliceMs, the connect and the hub's answer at the end included (HttpPost's
 *     begin_start and pump_answer): the ring drains and the windows close on time whatever the hub does, and the
 *     stream takes its records through its own two blocks;
 *   - the core task: the commands and one timer (every window, at most 50 ms apart while a stream runs), which reports
 *     `motion` when it moved more than kMotionDeadband since the last report (at once) or less (at most once every
 *     kSlowUs), never an unchanged value again; `rssi` and `rate` when they changed (at most once every kSlowUs); and
 *     collects a stream's end.
 * The core task never touches a record.
 *
 * Capture: init hands the source this sink and asks for the config's capture (source, rate_hz, peer_mac, format;
 * none for source peer without a 6-byte peer_mac: the properties then stay 0 until a stream names a peer). It runs
 * from the station's IP until reboot (the driver re-applies it at every reconnect). stream_start may name its own
 * source and peer_mac (design §12, for that stream only): the capture switches to them when they differ, the motion
 * baseline restarts, and both return to the config's at the stream's end.
 *
 * stream_start: INVALID_ARGS for a peer_mac that is not 6 bytes, or source peer without one (here or in the config);
 * BUSY while a stream runs; FAILED before init. It takes the hub endpoint from the runtime (stream::StreamHost) and
 * hands the job to fr_stream, which connects (`POST /v1/stream/in/<stream_id>`, headers X-Fr-Device, X-Fr-Kind csi,
 * X-Fr-Format csi1), and from then on takes every record offered (the ring's sequence numbers from the stream's base:
 * the record's index, dropped ones counted) into blocks of whole records behind the 8-byte head (seq, first_index),
 * closed every csi::kBlockMs or before they would pass kBlockBytes (at most csi::kBlockMaxBytes); two block buffers, from
 * the heap for the stream (none: it ends `error`): one in flight, one filling (a record with no buffer free is dropped,
 * a gap in the index). The connect, each block and the end go in slices of kSendSliceMs; a connect or a block not
 * gone in kStallMs ends the stream net_lost, as an early answer (the hub's 404) or a refused connect does. At
 * `seconds` (done) or stream_stop (stopped) the records offered until then are sent, the zero-length chunk ends it and
 * the hub's `200 {"records":N}` is read. stream_ended {stream_id, reason, records (the index the stream reached),
 * dropped (of those, the ones never sent)}; after net_lost both count up to the last block sent (0 when it never
 * connected). overflow is not used: drops are counted, never filled, and the stream goes on.
 *
 * baseline_reset: the baseline is re-seeded from the next record (fr_stream).
 */
class CsiService final : public cap::Csi, private hal::CsiSink, private stream::Worker
{
public:
#if defined(ESP_PLATFORM)
    /** The record ring (internal RAM: the C5 has no PSRAM), allocated at init: FR_CSI_RING_BYTES, 8 KB (about 60 LLTF
     * or 16 HE20 records, 0.15-0.6 s at 100 Hz), or the memory class's. */
    static constexpr size_t kRingBytes = CONFIG_FR_CSI_RING_BYTES;
    /** Each of the two block buffers, allocated while a stream runs: FR_CSI_BLOCK_BYTES, or the memory class's. */
    static constexpr size_t kBlockBytes = CONFIG_FR_CSI_BLOCK_BYTES;
#else
    // The host suite: memory class small's ring (the tightest), the largest blocks.
    static constexpr size_t kRingBytes = 4096;
    static constexpr size_t kBlockBytes = csi::kBlockMaxBytes;
#endif
    static_assert((kRingBytes & (kRingBytes - 1)) == 0 && kRingBytes >= 2048,
                  "FR_CSI_RING_BYTES must be a power of two (csi::RecordRing masks its free-running counters)");
    static_assert(kBlockBytes <= csi::kBlockMaxBytes &&
                  kBlockBytes >= csi::kBlockHeadBytes + csi::kRecordHeadBytes + hal::kCsiDataMax);
    /** `motion` moves more than this (1 % of csi::Motion::kUnit, 100 %) to be reported at once. */
    static constexpr uint16_t kMotionDeadband = csi::Motion::kUnit / 100;
    /** A smaller change of `motion`, and any of `rssi` and `rate`, goes out at most this often (the default
     * heartbeat interval). */
    static constexpr TimeUs kSlowUs = 1'000'000;
    /** fr_stream sends a block for at most this long per pass, then serves the other streams. */
    static constexpr uint32_t kSendSliceMs = 20;
    /** A connect or a block send that cannot go on this long, or an answer that takes it, ends the stream net_lost. */
    static constexpr uint32_t kStallMs = 3000;
    /** The core timer's longest period while a stream runs. */
    static constexpr uint32_t kStreamPollUs = 50'000;
    /** Records fr_stream takes out of the ring per pass. */
    static constexpr size_t kPerPass = 32;

    CsiService(hal::CsiSource &src, const cap::CsiConfig &cfg);
    ~CsiService();
    CsiService(const CsiService &) = delete;
    CsiService &operator=(const CsiService &) = delete;

    /** Initialises the source, allocates the ring, starts the config's capture and joins fr_stream. */
    Status init(Core &core);
    hal::Selftest selftest();

    Status stream_start(const cap::CsiStreamStartArgs &args) override;
    Status stream_stop(const cap::CsiStreamStopArgs &args) override;
    Status baseline_reset() override;
    uint16_t motion() const override { return motion_; }
    int8_t rssi() const override { return rssi_; }
    uint16_t rate() const override { return rate_; }

    /** The capture asked of the source now (the config's, or a stream's). */
    const hal::CsiCapture &capture() const { return cur_; }
    /** Records the ring dropped since init (full), and the newest stream's hub answer (0: none) and its records. */
    uint32_t ring_dropped() const { return ring_.dropped(); }
    int last_status() const { return last_status_.load(std::memory_order_relaxed); }
    uint32_t last_hub_records() const { return hub_records_.load(std::memory_order_relaxed); }
    /** Feature windows fr_stream closed since init (one every 1/features_hz s). */
    uint32_t windows() const { return win_seq_.load(std::memory_order_acquire); }

private:
    enum class StreamState : uint8_t { idle, connecting, streaming };
    enum class Slot : uint8_t { free, filling, closed, sending };
    struct Block {
        uint8_t *mem = nullptr;
        Slot slot = Slot::free;
        size_t len = 0;        // bytes, the head included
        uint32_t first = 0;    // first_index
        uint32_t end = 0;      // the index after its last record
        uint32_t count = 0;    // records in it
        uint32_t order = 0;    // closed blocks go out oldest first
        TimeUs opened = 0;
    };

    // hal::CsiSink (Wi-Fi task)
    void on_csi(const hal::CsiRecord &r) override;
    // stream::Worker (fr_stream)
    bool stream_pass() override;

    // core task
    void on_timer();
    void arm();
    /** The config's capture; false when it names none (peer without peer_mac). */
    bool config_capture(hal::CsiCapture &out) const;
    Status apply(const hal::CsiCapture &c);

    // fr_stream
    void consume(const csi::RecordRing::View &v, TimeUs now);
    bool close_window(TimeUs now);
    void begin_stream(uint32_t gen, TimeUs now);
    bool connect_step();
    bool stream_step(TimeUs now);
    bool answer_step();
    void append(const csi::RecordRing::View &v, TimeUs now);
    Block *slot(Slot s);
    void close_block(Block &b);
    void finish(cap::CsiStreamEndReason why);
    void abort_stream(cap::CsiStreamEndReason why, bool connected);
    bool alloc_blocks();
    void free_blocks();
    void publish_end(cap::CsiStreamEndReason why, uint32_t records, uint32_t dropped);

    hal::CsiSource &src_;
    cap::CsiConfig cfg_;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    bool ready_ = false;
    uint8_t *mem_ = nullptr;
    TimeUs window_us_ = 100'000;

    // ---- core task ----
    hal::CsiCapture cur_{};
    bool capturing_ = false;
    bool overridden_ = false;  // cur_ is a stream's
    bool streaming_ = false;
    uint32_t stream_id_ = 0;
    uint32_t gen_ = 0;
    uint16_t motion_ = 0;
    uint16_t motion_sent_ = 0;  // the last `motion` reported
    bool motion_reported_ = false;
    TimeUs motion_at_ = 0;      // ... and when
    int8_t rssi_ = 0;
    uint16_t rate_ = 0;
    uint32_t win_seen_ = 0;
    TimeUs last_slow_ = -kSlowUs;  // when rssi and rate last went out
    char device_[13] = {};

    // ---- core -> fr_stream: the job, published by req_gen_ (release) ----
    std::atomic<uint32_t> req_id_{0};
    std::atomic<uint32_t> req_seconds_{0};
    std::atomic<uint32_t> req_ip_{0};  // 0: no endpoint
    std::atomic<uint32_t> req_port_{0};
    std::atomic<uint32_t> req_gen_{0};
    std::atomic<uint32_t> stop_gen_{0};
    std::atomic<uint32_t> reset_req_{0};

    // ---- Wi-Fi task -> fr_stream ----
    csi::RecordRing ring_;

    // ---- fr_stream -> core: published by end_gen_ / win_seq_ (release) ----
    std::atomic<uint8_t> end_reason_{0};
    std::atomic<uint32_t> end_records_{0};
    std::atomic<uint32_t> end_dropped_{0};
    std::atomic<uint32_t> end_gen_{0};
    std::atomic<uint16_t> win_motion_{0};
    std::atomic<int8_t> win_rssi_{0};
    std::atomic<uint16_t> win_rate_{0};
    std::atomic<uint32_t> win_seq_{0};
    std::atomic<int> last_status_{0};
    std::atomic<uint32_t> hub_records_{0};

    // ---- fr_stream only ----
    csi::Motion motion_calc_;
    uint32_t reset_seen_ = 0;
    TimeUs win_start_ = 0;
    uint32_t win_count_ = 0;
    int32_t win_rssi_sum_ = 0;
    int8_t last_rssi_ = 0;
    std::array<uint16_t, 20> rate_hist_{};  // records per window, the last features_hz windows (one second)
    size_t rate_at_ = 0;
    uint32_t rate_now_ = 0;  // their sum
    StreamState st_ = StreamState::idle;
    uint32_t st_gen_ = 0;
    uint32_t base_ = 0;       // the ring's sequence number of the stream's index 0
    uint32_t seq_ = 0;        // chunks sent
    uint32_t sent_end_ = 0;   // the index after the last block sent
    uint32_t sent_records_ = 0;
    uint32_t order_ = 0;
    TimeUs deadline_ = 0;     // 0: until stream_stop
    bool finishing_ = false;
    bool answering_ = false;  // the last chunk begun: the hub's answer comes in slices
    cap::CsiStreamEndReason finish_reason_ = cap::CsiStreamEndReason::stopped;
    uint32_t end_index_ = 0;  // finishing: records offered before the end
    std::array<Block, 2> blocks_{};
    uint8_t *block_mem_ = nullptr;  // both blocks, while a stream runs
    // fr_ota's HttpPost, built in here by the constructor (fr_core requires fr_ota privately; see AudioInService).
    alignas(8) unsigned char post_store_[1024];
    ota::HttpPost &post();
};

}  // namespace fr
