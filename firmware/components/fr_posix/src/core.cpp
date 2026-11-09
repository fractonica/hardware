#include "fr/posix/core.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <utility>

namespace fr::posix {

PosixCore::PosixCore() : start_(std::chrono::steady_clock::now())
{
    if (::pipe(wake_) == 0) {
        for (const int fd : wake_) {
            ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
            ::fcntl(fd, F_SETFD, FD_CLOEXEC);
        }
    }
}

PosixCore::~PosixCore()
{
    for (const int fd : wake_) {
        if (fd >= 0) {
            ::close(fd);
        }
    }
}

TimeUs PosixCore::now() const
{
    // Not 0 at start, like esp_timer after boot.
    return 1'000'000 +
           std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - start_).count();
}

Timer *PosixCore::timer(Callback<void(), 24> on_fire)
{
    if (timers_used_ == timers_.size()) {
        return nullptr;
    }
    PosixTimer &t = timers_[timers_used_++];
    t.core = this;
    t.on_fire = on_fire;
    return &t;
}

InputSlot *PosixCore::input_slot(Callback<void(const InputSample &), 24> on_change)
{
    if (slots_used_ == slots_.size()) {
        return nullptr;
    }
    PosixSlot &s = slots_[slots_used_++];
    s.on_change = on_change;
    return &s;
}

bool PosixCore::post(Callback<void(), 32> fn)
{
    {
        const std::lock_guard lock(post_mu_);
        if (posts_.size() >= kPostQueue) {
            return false;
        }
        posts_.push_back(fn);
    }
    if (wake_[1] >= 0) {
        const char b = 1;
        if (::write(wake_[1], &b, 1) < 0) {
            // EAGAIN: the pipe is full, which already wakes the Runner.
        }
    }
    return true;
}

void PosixCore::drain_wake()
{
    char buf[64];
    while (wake_[0] >= 0 && ::read(wake_[0], buf, sizeof(buf)) > 0) {
    }
}

void PosixCore::PosixTimer::start(uint32_t delay_us)
{
    armed = true;
    deadline = core->now() + delay_us;
    order = ++core->order_;
}

void PosixCore::PosixSlot::update_from_isr(bool level, TimeUs at)
{
    const std::lock_guard lock(mu);
    sample.level = level;
    sample.at = at;
    ++sample.edges;
    pending = true;
}

PosixCore::PosixTimer *PosixCore::earliest()
{
    PosixTimer *best = nullptr;
    for (size_t i = 0; i < timers_used_; ++i) {
        PosixTimer &t = timers_[i];
        if (t.armed &&
            (best == nullptr || t.deadline < best->deadline || (t.deadline == best->deadline && t.order < best->order))) {
            best = &t;
        }
    }
    return best;
}

TimeUs PosixCore::next_deadline() const
{
    const PosixTimer *t = const_cast<PosixCore *>(this)->earliest();
    return t != nullptr ? t->deadline : kNever;
}

void PosixCore::run_ready()
{
    for (;;) {
        bool any = false;
        for (size_t i = 0; i < slots_used_; ++i) {
            PosixSlot &s = slots_[i];
            InputSample sample{};
            bool fire = false;
            {
                const std::lock_guard lock(s.mu);
                if (s.pending) {
                    sample = s.sample;
                    s.sample.edges = 0;
                    s.pending = false;
                    fire = true;
                }
            }
            if (fire) {
                s.on_change(sample);
                any = true;
            }
        }
        if (PosixTimer *t = earliest(); t != nullptr && t->deadline <= now()) {
            t->armed = false;
            t->on_fire();
            any = true;
        }
        Callback<void(), 32> fn;
        bool have = false;
        {
            const std::lock_guard lock(post_mu_);
            if (!posts_.empty()) {
                fn = posts_.front();
                posts_.pop_front();
                have = true;
            }
        }
        if (have) {
            fn();
            any = true;
        }
        if (!any) {
            return;
        }
    }
}

}  // namespace fr::posix
