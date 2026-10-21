// FakeWorker: fr::Worker for host tests (spec 03 §3.4, design c4 §3). Jobs queue in FIFO order, bounded
// like fr_worker's (fr::worker::kQueueDepth), and run only when the test says so, so a test controls
// exactly when "the other task" does its work relative to the core task (FakeCore::run_ready).
#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <utility>

#include "fr/base.hpp"
#include "fr/core/worker.hpp"

namespace frt {

class FakeWorker final : public fr::Worker
{
public:
    bool post(fr::Callback<void(), 32> job) override
    {
        if (jobs_.size() >= fr::worker::kQueueDepth) {
            ++dropped;
            return false;
        }
        jobs_.push_back(std::move(job));
        ++posted;
        return true;
    }

    /** Runs the oldest job; false when none is queued. */
    bool run_one()
    {
        if (jobs_.empty()) {
            return false;
        }
        fr::Callback<void(), 32> job = std::move(jobs_.front());
        jobs_.pop_front();
        job();
        ++ran;
        return true;
    }

    /** Runs jobs until the queue is empty, those the jobs post included; returns how many ran. */
    size_t run_all()
    {
        size_t n = 0;
        while (run_one()) {
            ++n;
        }
        return n;
    }

    size_t pending() const { return jobs_.size(); }

    uint32_t posted = 0;
    uint32_t ran = 0;
    uint32_t dropped = 0;

private:
    std::deque<fr::Callback<void(), 32>> jobs_;
};

}  // namespace frt
