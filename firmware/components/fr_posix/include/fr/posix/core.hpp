// The core task on a POSIX host (design uno-q-host §2.5 step 2): fr::Core on the steady clock, with pools of timers
// and input slots and a post queue, run by the Runner's single thread in EspCore's order (input slots, the earliest
// due timer, posted functions). post() may be called from any thread: it wakes the Runner through a pipe.
// Production code for Linux nodes (qonu-node on the Arduino UNO Q); the host suite keeps its own HostCore.
#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>

#include "fr/core/core.hpp"

namespace fr::posix {

inline constexpr TimeUs kNever = INT64_MAX;

class PosixCore final : public Core
{
public:
    PosixCore();
    ~PosixCore();
    PosixCore(const PosixCore &) = delete;
    PosixCore &operator=(const PosixCore &) = delete;

    TimeUs now() const override;
    Timer *timer(Callback<void(), 24> on_fire) override;
    InputSlot *input_slot(Callback<void(const InputSample &), 24> on_change) override;
    bool post(Callback<void(), 32> fn) override;

    /** Input slots, due timers (earliest first), posted functions, until nothing is ready. Runner thread only. */
    void run_ready();
    /** The earliest armed timer's deadline, or kNever. */
    TimeUs next_deadline() const;
    /** Readable when post() queued work from another thread; drain_wake() empties it. */
    int wake_fd() const { return wake_[0]; }
    void drain_wake();

    static constexpr size_t kTimers = 96;
    static constexpr size_t kSlots = 8;
    static constexpr size_t kPostQueue = 256;

private:
    struct PosixTimer final : Timer {
        PosixCore *core = nullptr;
        Callback<void(), 24> on_fire;
        bool armed = false;
        TimeUs deadline = 0;
        uint64_t order = 0;

        void start(uint32_t delay_us) override;
        void stop() override { armed = false; }
        bool running() const override { return armed; }
    };

    struct PosixSlot final : InputSlot {
        Callback<void(const InputSample &), 24> on_change;
        std::mutex mu;
        bool pending = false;
        InputSample sample{};

        void update_from_isr(bool level, TimeUs at) override;
    };

    PosixTimer *earliest();

    std::chrono::steady_clock::time_point start_;
    uint64_t order_ = 0;
    std::array<PosixTimer, kTimers> timers_{};
    size_t timers_used_ = 0;
    std::array<PosixSlot, kSlots> slots_{};
    size_t slots_used_ = 0;
    std::mutex post_mu_;
    std::deque<Callback<void(), 32>> posts_;
    int wake_[2] = {-1, -1};
};

}  // namespace fr::posix
