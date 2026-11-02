// The audio services' two tasks (design audio-a1 D5) and what they need from the runtime. IDF-free.
//
// fr_audio (priority 5, 4 KB, core 0 on dual-core targets as fr_net) drives the converters: every AudioInService reads
// its microphone and every AudioOutService writes its amplifier from it. fr_stream (priority 3, 4 KB) owns the stream
// sockets (fr_ota's HttpPost and HttpGet). Neither touches the core task, which keeps dispatch (03 §3.4): a command
// hands its job over through the service's atomics and returns, the service's core timer collects what the tasks
// publish (level, ends) and emits it on the core task. The services register with the one Engine at init(), which
// starts the two tasks once (Rt::spawn). The host suite drives the Engine by hand instead (set_manual,
// audio_once, stream_once); fr_net_node runs the real tasks as threads.
//
// CSI-1 (design csi-c1 D11): the stream side is neutral now (fr/stream/stream.hpp: Endpoint, StreamHost, the fr_stream
// Worker), aliased here under their old names. fr_stream also runs plain stream workers (fr.csi's CsiService:
// add_stream, start_stream), which have no fr_audio half; a node without audio services runs fr_stream alone.
#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/base.hpp"
#include "fr/stream/stream.hpp"

namespace fr::audio {

using stream::Endpoint;
using stream::format_ipv4;
using stream::kHubHttpPort;
using stream::parse_ipv4;
using stream::set_stream_host;
using stream::stream_host;
using stream::StreamHost;

/**
 * A service's counters for diag `stats audio` (since init), so a bench run tells DMA loss from Wi-Fi loss and from
 * the room: an input fills the first three, an output the last two.
 */
struct WorkerStats {
    const char *name = "";  // the instance
    bool input = false;
    uint32_t rx_overflows = 0;     // DMA buffers the microphone's driver lost (I2S RX queue overflows)
    uint32_t dropped_samples = 0;  // samples the record ring dropped (the stream slower than the microphone)
    uint32_t clipping = 0;         // samples saturated in the conversion (the warm-up's not counted)
    uint32_t underruns = 0;        // DMA buffers the amplifier's driver played starved (cleared) while a sound ran
    uint32_t ring_dry = 0;         // times the play ring ran dry while its GET went on (silence written)
};

/** Why an output gave a monitor's claim back before monitor_release (design audio-a2 D3): the input's end reason. */
enum class MonitorEnd : uint8_t { none, stopped, busy, error };

/**
 * An output an input's on-board monitor plays into (design audio-a2 D3, §10): fr.audio_out's AudioOutService. The
 * input claims it on the core task, writes its converted samples into it on fr_audio (no network, no fr_stream) and
 * releases it on the core task once fr_audio has stopped writing (monitor_finish, then the core timer's release). A claim has an id (non-zero); a play or tone on the
 * output takes the output from it (MonitorEnd::busy), a stop on the output ends it (stopped), a failed write to the
 * converter ends it (error): monitor_preempted says so, and the input ends its monitor with that reason.
 */
class MonitorSink
{
public:
    /**
     * Core task: the output for a monitor at `sample_hz` (its config rate: Err::invalid_args otherwise), at `volume`
     * (0: the output's own, set_volume applies; else 1-100 for the monitor only). Err::busy while a tone or play runs
     * or another claim holds it. The claim's id.
     */
    virtual std::expected<uint32_t, Err> monitor_claim(uint32_t sample_hz, uint8_t volume) = 0;
    /**
     * fr_audio: `pcm` into the output's play ring, as much as fits under its latency cap, the rest dropped (before the
     * output has taken the claim up, all of it); how many went in. 0 for a claim that is not the output's current one.
     */
    virtual size_t monitor_write(uint32_t claim, std::span<const int16_t> pcm) = 0;
    /**
     * fr_audio: the input has written its last samples (its monitor ended there): the output plays out what its DMA
     * holds and counts no underruns while it waits for monitor_release (the core timer's, up to 50 ms later).
     */
    virtual void monitor_finish(uint32_t claim) = 0;
    /** Core task: the claim ends (the output stops; nothing when the claim was taken from it already). */
    virtual void monitor_release(uint32_t claim) = 0;
    /** Any task: MonitorEnd::none while `claim` holds the output, else why it was taken. */
    virtual MonitorEnd monitor_preempted(uint32_t claim) const = 0;

protected:
    ~MonitorSink() = default;
};

/** One audio service's halves on the two tasks (its fr_stream half: stream::Worker::stream_pass). */
class Worker : public stream::Worker
{
public:
    /** The service's capability port (Capability::port()), so an input finds an output by it; 0xFF: none. */
    virtual uint8_t worker_port() const { return 0xFF; }
    /** An output's monitor side (nullptr: it takes no monitor, as every input). */
    virtual MonitorSink *monitor_sink() { return nullptr; }
    /** An input (fr_audio passes inputs after outputs, and the inputs pace the loop: their reads block). */
    virtual bool is_input() const = 0;
    /**
     * fr_audio: one pass, waiting at most `wait_ms` on the converter (0: only what is ready). False when it had
     * nothing to do, so the task may sleep until woken.
     */
    virtual bool audio_pass(uint32_t wait_ms) = 0;
    /** Any task: the service's counters (atomics only); false when it keeps none. */
    virtual bool stats(WorkerStats &out) const
    {
        static_cast<void>(out);
        return false;
    }
#if FR_TEST_HOOKS
    /** diag `audio stall <ms>` (FR_TEST_HOOKS): Err::not_found when this service runs no stream it applies to. */
    virtual Status stall(uint32_t ms)
    {
        static_cast<void>(ms);
        return std::unexpected(Err::not_found);
    }
#endif

protected:
    ~Worker() = default;
};

class Engine
{
public:
    static constexpr uint32_t kAudioPriority = 5;
    static constexpr uint32_t kStreamPriority = 3;
    static constexpr uint32_t kStackBytes = 4096;
    /** The longest a pass waits on a converter, and the idle tasks' sleep between looks (they are woken anyway). */
    static constexpr uint32_t kWaitMs = 20;
    static constexpr uint32_t kIdleMs = 100;
    static constexpr size_t kWorkersMax = 4;

    /**
     * At a service's init(), core task; false when the table is full. The tasks may already run (the first service's
     * init started them): the slot is written before the count that makes it visible (release), and the tasks read
     * the count first (acquire), so they never see a slot half made.
     */
    bool add(Worker &w);
    /** A plain stream worker (fr.csi): fr_stream passes it, fr_audio never sees it. Core task; false when full. */
    bool add_stream(stream::Worker &w);
    /** A service going away (host only: the board's live as long as the node), with the tasks stopped or manual. */
    void remove(Worker &w);
    void remove_stream(stream::Worker &w);
    /** Starts fr_audio and fr_stream once (nothing in manual mode); false when a task cannot be made. */
    bool start();
    /** Starts fr_stream alone once (a plain stream worker's init; start() adds fr_audio later if an audio service
     * comes). */
    bool start_stream();
    /** Any task: there is work for that task (a command, a block published, room in the play ring). */
    void wake_audio();
    void wake_stream();

    // ---- host ----
    /** The host suite: no tasks; the test runs audio_once() and stream_once() itself. */
    void set_manual(bool on) { manual_ = on; }
    bool manual() const { return manual_; }
    /** One round of each task's loop: true when a worker did something. */
    bool audio_once();
    bool stream_once();
    /** Ends the tasks and waits for them (fr_net_node's exit). */
    void stop();

    /** Core task: the output worker on capability port `port` that takes monitors (nullptr: none). */
    MonitorSink *monitor_sink(uint8_t port);

    /** diag `stats audio`: each worker's counters into `out`, in the order they were added; how many. Core task. */
    size_t stats(std::span<WorkerStats> out) const;

#if FR_TEST_HOOKS
    /** diag `audio stall <ms>`: each worker's stall(); OK when one took it, else a refusal (not_found: no stream runs). */
    Status stall(uint32_t ms);
#endif

private:
    static void audio_main(void *arg);
    static void stream_main(void *arg);
    bool make_signals();

    std::array<Worker *, kWorkersMax> workers_{};
    std::atomic<size_t> count_{0};  // workers_[0, count_) are made (add() publishes, the tasks acquire)
    // fr_stream's: the audio workers and the plain ones, in the order they were added (published as workers_).
    std::array<stream::Worker *, 2 * kWorkersMax> streams_{};
    std::atomic<size_t> stream_count_{0};
    bool started_ = false;  // fr_audio
    bool stream_started_ = false;
    bool manual_ = false;
    std::atomic<bool> stopping_{false};
    void *audio_sig_ = nullptr;
    void *stream_sig_ = nullptr;
};

/** The node's one Engine. */
Engine &engine();

}  // namespace fr::audio
