// The fleet's fr_worker (design m2-c2 D1, D8): a pool of threads and one serial strand per node on it; see node.hpp.
#include "sim/node.hpp"

namespace frsim {

// ---- WorkerPool ----

WorkerPool::WorkerPool(size_t threads)
{
    for (size_t i = 0; i < threads; ++i) {
        threads_.emplace_back([this] {
            for (;;) {
                std::function<void()> fn;
                {
                    std::unique_lock lock(mu_);
                    cv_.wait(lock, [this] { return stop_ || !jobs_.empty(); });
                    if (jobs_.empty()) {
                        return;  // stopping, and nothing left
                    }
                    fn = std::move(jobs_.front());
                    jobs_.pop_front();
                }
                fn();
            }
        });
    }
}

WorkerPool::~WorkerPool()
{
    {
        const std::lock_guard lock(mu_);
        stop_ = true;
    }
    cv_.notify_all();
    for (std::thread &t : threads_) {
        t.join();
    }
}

void WorkerPool::submit(std::function<void()> fn)
{
    {
        const std::lock_guard lock(mu_);
        jobs_.push_back(std::move(fn));
    }
    cv_.notify_one();
}

// ---- Strand ----

Strand::Strand(Executor &exec, WorkerPool *pool) : exec_(exec), pool_(pool) {}

Strand::~Strand()
{
    quiesce();
    exec_.cancel(event_);
}

bool Strand::post(fr::Callback<void(), 32> job)
{
    {
        const std::lock_guard lock(mu_);
        if (dropping_) {
            ++stats_.dropped;  // the node is off: taken, never run (a job that re-posts itself ends)
            return true;
        }
        if (jobs_.size() >= fr::worker::kQueueDepth) {
            ++stats_.refused;
            return false;
        }
        jobs_.push_back(std::move(job));
    }
    kick();
    return true;
}

void Strand::kick()
{
    if (pool_ == nullptr) {
        // Virtual time: the next job is an event on the loop, never run inside post().
        const std::lock_guard lock(mu_);
        if (event_ == 0 && !jobs_.empty()) {
            event_ = exec_.after(0, [this] {
                {
                    const std::lock_guard lock(mu_);
                    event_ = 0;
                }
                run_next();
                kick();
            });
        }
        return;
    }
    {
        const std::lock_guard lock(mu_);
        if (running_ || jobs_.empty()) {
            return;
        }
        running_ = true;
    }
    pool_->submit([this] {
        // One pool run takes the strand's jobs in order until none is left: never two at once.
        for (;;) {
            run_next();
            const std::lock_guard lock(mu_);
            if (jobs_.empty()) {
                running_ = false;
                cv_.notify_all();
                return;
            }
        }
    });
}

void Strand::run_next()
{
    fr::Callback<void(), 32> job;
    {
        const std::lock_guard lock(mu_);
        if (jobs_.empty()) {
            return;
        }
        job = std::move(jobs_.front());
        jobs_.pop_front();
        if (pool_ == nullptr) {
            running_ = true;
        }
    }
    job();
    const std::lock_guard lock(mu_);
    ++stats_.run;
    if (pool_ == nullptr) {
        running_ = false;
    }
}

void Strand::quiesce()
{
    std::unique_lock lock(mu_);
    dropping_ = true;
    stats_.dropped += static_cast<uint32_t>(jobs_.size());
    jobs_.clear();
    if (pool_ != nullptr) {
        cv_.wait(lock, [this] { return !running_; });
    }
    if (event_ != 0) {
        exec_.cancel(event_);
        event_ = 0;
    }
}

void Strand::resume()
{
    const std::lock_guard lock(mu_);
    dropping_ = false;
}

bool Strand::idle() const
{
    const std::lock_guard lock(mu_);
    return jobs_.empty() && !running_;
}

Strand::Stats Strand::stats() const
{
    const std::lock_guard lock(mu_);
    return stats_;
}

}  // namespace frsim
