// The core task contract (design c2 §5, spec 03 §3.4). Services, drivers and the runtime see only this
// interface: EspCore implements it on target, FakeCore (fake clock) in host tests. Everything handed
// out here runs its callbacks on the core task, which owns all capability, service and driver state.
#pragma once

#include <cstdint>

#include "fr/base.hpp"

namespace fr {

/** What an input slot hands its consumer: the newest level, when it was sampled, and how many edges
 * the ISR saw since the previous sample was consumed (> 1 when edges coalesced). */
struct InputSample {
    bool level;
    TimeUs at;
    uint32_t edges;
};

/** One-shot timer; fires on the core task. */
class Timer
{
public:
    virtual void start(uint32_t delay_us) = 0;  // restarts if running
    virtual void stop() = 0;
    virtual bool running() const = 0;

protected:
    ~Timer() = default;
};

/** Written by an ISR, consumed on the core task. A slot holds only the newest sample, so it cannot
 * overflow; at worst edges coalesce and InputSample::edges says so. */
class InputSlot
{
public:
    virtual void update_from_isr(bool level, TimeUs at) = 0;  // IRAM-safe on target

protected:
    ~InputSlot() = default;
};

class Core
{
public:
    virtual TimeUs now() const = 0;
    /** From a static pool; nullptr when exhausted. Allocate in init(), never on the realtime path. */
    virtual Timer *timer(Callback<void(), 24> on_fire) = 0;
    virtual InputSlot *input_slot(Callback<void(const InputSample &), 24> on_change) = 0;
    /** Any task -> core task. False when the queue is full (the caller decides whether to count it). */
    virtual bool post(Callback<void(), 32> fn) = 0;

protected:
    ~Core() = default;
};

}  // namespace fr
