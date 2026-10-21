// fr_worker (spec 03 §3.4, design c4 §3): the task for slow work that must never run on the core task,
// such as flash and NVS writes and the OTA download (HTTP). One task, one bounded FIFO of jobs, run one at
// a time. A job that needs core-task state posts its result back with Core::post. Code that posts takes a
// Worker&, so host tests run it on FakeWorker (firmware/test/host/tests/fake_worker.hpp); the target's
// instance is fr::worker::get().
#pragma once

#include <cstddef>
#include <cstdint>

#include "fr/base.hpp"

namespace fr {

class Worker
{
public:
    /** Any task -> fr_worker. False when the queue is full (the caller decides whether to retry or count it). */
    virtual bool post(Callback<void(), 32> job) = 0;

protected:
    ~Worker() = default;
};

namespace worker {

/** Jobs queued at once: the OTA download is one long job, NVS and flash writes are short ones. */
inline constexpr size_t kQueueDepth = 8;
/** Below fr_serial (9), fr_core (10) and fr_net (11): slow work yields to everything realtime. */
inline constexpr uint32_t kPriority = 5;
/** Bytes: the image GET (fr_ota HttpGet on lwIP sockets) and esp_ota_write run on it. */
inline constexpr uint32_t kStackBytes = 6 * 1024;

// Target only (fr_core/src/esp_worker.cpp); fr::core::start() starts the task before anything can post.
/** The node's fr_worker. Jobs posted before the task runs wait in its queue. */
Worker &get();
/** get().post(job): false when the queue is full. Any task. */
bool post(Callback<void(), 32> job);

}  // namespace worker
}  // namespace fr
