// The core task on the Mac for the desktop renderer (design m2-c5-display D6): fr::Core with a virtual clock, as the
// host suite's FakeCore (firmware/test/host/tests/fake_core.hpp) but without the test framework. Nothing runs until
// run_ready() or advance_to(); then the core-task order applies: due timers (earliest first), then posted functions.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <utility>

#include "fr/base.hpp"
#include "fr/core/core.hpp"

namespace frd {

class HostCore final : public fr::Core
{
public:
    static constexpr size_t kTimers = 16;
    static constexpr size_t kPosts = 64;

    fr::TimeUs now() const override { return now_; }

    fr::Timer *timer(fr::Callback<void(), 24> on_fire) override
    {
        if (timers_used_ == kTimers) {
            return nullptr;
        }
        HostTimer &t = timers_[timers_used_++];
        t.core = this;
        t.on_fire = on_fire;
        return &t;
    }

    fr::InputSlot *input_slot(fr::Callback<void(const fr::InputSample &), 24> on_change) override
    {
        static_cast<void>(on_change);
        return nullptr;  // no inputs on a renderer
    }

    bool post(fr::Callback<void(), 32> fn) override
    {
        if (posts_len_ == kPosts) {
            return false;
        }
        posts_[(posts_head_ + posts_len_) % kPosts] = fn;
        ++posts_len_;
        return true;
    }

    /** Runs everything ready at the current time. */
    void run_ready()
    {
        for (int guard = 0; guard < 1'000'000; ++guard) {
            if (run_one_due_timer() || run_one_post()) {
                continue;
            }
            return;
        }
        std::fprintf(stderr, "HostCore: work never settles (a timer re-arming at 0?)\n");
        std::abort();
    }

    /** Moves the clock to `t`, stopping at every timer deadline on the way. */
    void advance_to(fr::TimeUs t)
    {
        run_ready();
        for (;;) {
            HostTimer *next = earliest();
            if (next == nullptr || next->deadline > t) {
                break;
            }
            if (next->deadline > now_) {
                now_ = next->deadline;
            }
            run_ready();
        }
        if (t > now_) {
            now_ = t;
        }
        run_ready();
    }

    bool timers_running() const
    {
        for (size_t i = 0; i < timers_used_; ++i) {
            if (timers_[i].is_running) {
                return true;
            }
        }
        return false;
    }

private:
    struct HostTimer final : fr::Timer {
        HostCore *core = nullptr;
        fr::Callback<void(), 24> on_fire;
        bool is_running = false;
        fr::TimeUs deadline = 0;
        uint64_t order = 0;

        void start(uint32_t delay_us) override
        {
            is_running = true;
            deadline = core->now_ + delay_us;
            order = ++core->order_;
        }
        void stop() override { is_running = false; }
        bool running() const override { return is_running; }
    };

    HostTimer *earliest()
    {
        HostTimer *best = nullptr;
        for (size_t i = 0; i < timers_used_; ++i) {
            HostTimer &t = timers_[i];
            if (t.is_running &&
                (best == nullptr || t.deadline < best->deadline || (t.deadline == best->deadline && t.order < best->order))) {
                best = &t;
            }
        }
        return best;
    }

    bool run_one_due_timer()
    {
        HostTimer *t = earliest();
        if (t == nullptr || t->deadline > now_) {
            return false;
        }
        t->is_running = false;
        t->on_fire();
        return true;
    }

    bool run_one_post()
    {
        if (posts_len_ == 0) {
            return false;
        }
        fr::Callback<void(), 32> fn = std::move(posts_[posts_head_]);
        posts_[posts_head_].reset();
        posts_head_ = (posts_head_ + 1) % kPosts;
        --posts_len_;
        fn();
        return true;
    }

    fr::TimeUs now_ = 1'000'000;
    uint64_t order_ = 0;
    std::array<HostTimer, kTimers> timers_{};
    size_t timers_used_ = 0;
    std::array<fr::Callback<void(), 32>, kPosts> posts_{};
    size_t posts_head_ = 0;
    size_t posts_len_ = 0;
};

}  // namespace frd
