// The fleet kit's clock and event loop (design m2-c2 D6, D15): one executor for every node of a process, in one
// of two time domains. Virtual time (the host suite, T2-SCALE): now() jumps to the next event, which runs, then
// every core it touched runs its ready work; ties go by insertion order, so one seed gives one trace. Wall time
// (fr_fleet, the T2-*-30 gates against a real hub): now() is the steady clock in µs plus 1 s (HostCore's origin),
// waited on through a Waiter (kevent with a µs timeout and EVFILT_USER on macOS, poll() and a self-pipe elsewhere);
// late events still run in timestamp order, but now() stays monotonic, so a late event sees the time it actually
// runs, and its lateness goes into the lag histogram the inconclusive rule reads (D15).
//
// Contract by the foundation (design m2-c2 §3 item 5), implemented in executor.cpp (stream S1). Test code: it may
// allocate.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <utility>

#include "fr/base.hpp"

namespace frsim {

using fr::TimeUs;

class SimCore;

/** Which clock the executor runs. */
enum class TimeMode : uint8_t {
    virtual_time,  // the host suite: deterministic, as fast as the events allow
    wall,          // fr_fleet: real time, against a real hub
};

/** An event's handle, for cancel(); 0 is never one. */
using EventId = uint64_t;

/**
 * How late events ran (actual run time - scheduled time), cumulative: log buckets from 0.25 ms to 8 s whose edges
 * include the 20 ms preflight, the 100 ms inconclusive threshold and the 1 s stall rule (D15), plus count, sum and
 * max. The runner reads it before and after each run and takes the difference.
 */
struct LagHistogram {
    /** Upper bounds (µs, exclusive) of every bucket but the last, which holds the rest. */
    static constexpr std::array<TimeUs, 15> kBoundsUs{250,     500,     1'000,     2'000,     5'000,     10'000,    20'000,   50'000,
                                                      100'000, 200'000, 500'000, 1'000'000, 2'000'000, 5'000'000, 8'000'000};
    static constexpr size_t kBuckets = kBoundsUs.size() + 1;

    std::array<uint64_t, kBuckets> buckets{};
    uint64_t count = 0;
    TimeUs sum_us = 0;
    TimeUs max_us = 0;

    /** One event's lateness (a negative one counts as 0). */
    void add(TimeUs late_us);
    /** The upper bound of the bucket that holds quantile `q` (0..1), or max_us when that is the last bucket; 0 with no
     * samples. */
    TimeUs quantile(double q) const;
};

/** The executor's lag (D6, D15): `fleet stats` prints it, and at exit. */
struct LagStats {
    /** Every event since the executor started. */
    LagHistogram all;
    /** The last whole 1 s window of wall time. */
    struct Window {
        TimeUs start = 0;  // executor clock
        uint64_t events = 0;
        TimeUs p50_us = 0;
        TimeUs p99_us = 0;
        TimeUs max_us = 0;
    } last_window;
    /** Events that ran more than kLateUs after their time (wall mode; 0 in virtual time). */
    uint64_t late = 0;
    /** Every wall event runs a few µs late; only this much counts as `late`. */
    static constexpr TimeUs kLateUs = 1'000;
};

/** What the wall-mode loop blocks in. Only the executor's thread calls it, except wake(). */
class Waiter
{
public:
    static constexpr uint32_t kRead = 1u << 0;
    static constexpr uint32_t kWrite = 1u << 1;

    virtual ~Waiter() = default;
    /** Watches `fd` for `events` (kRead, kWrite), replacing what it watched for before; false when the backend refuses. */
    virtual bool add(int fd, uint32_t events) = 0;
    virtual void remove(int fd) = 0;
    /**
     * Blocks until a watched fd is ready, wake() is called, or `timeout_us` passes (µs, not rounded to ms; < 0:
     * no limit), then calls `ready(fd, events)` for each ready fd. False on an error other than EINTR.
     */
    virtual bool wait(TimeUs timeout_us, const std::function<void(int fd, uint32_t events)> &ready) = 0;
    /** Any thread: the current or the next wait() returns at once. */
    virtual void wake() = 0;
};

/** kqueue with an EVFILT_USER wake-up on macOS, poll() with a self-pipe elsewhere (so the suite still builds on Linux). */
std::unique_ptr<Waiter> make_waiter();
/** The poll() backend, on every platform (its timeout is rounded up to whole ms). */
std::unique_ptr<Waiter> make_poll_waiter();
/** The kqueue backend; null where there is no kqueue. */
std::unique_ptr<Waiter> make_kqueue_waiter();

class Executor
{
public:
    using Fn = std::function<void()>;
    using FdFn = std::function<void(uint32_t events)>;

    /** `waiter`: wall mode's (make_waiter() when null); virtual time has none. */
    explicit Executor(TimeMode mode, std::unique_ptr<Waiter> waiter = nullptr);
    ~Executor();
    Executor(const Executor &) = delete;
    Executor &operator=(const Executor &) = delete;

    TimeMode mode() const;
    /** Virtual: the running event's time. Wall: the steady clock in µs + 1 s, never going back. */
    TimeUs now() const;
    /**
     * The time the work running now stands for (model time): what the medium decides on, so a loaded loop's lag
     * changes no airtime, carrier-sense or collision outcome. Virtual: now(). Wall: the scheduled time of the heap
     * entry being run, kept for the core work it touched; for work from a watched fd or a worker's wake-up, the
     * clock's reading but never past the earliest entry still waiting (so no event still to run is older); outside
     * run_until the same. Never goes back. Loop thread only.
     */
    TimeUs event_time() const;

    /** `fn` at `t`; a time already past runs next. Events at one time run in the order they were added. */
    EventId at(TimeUs t, Fn fn);
    EventId after(TimeUs delay_us, Fn fn) { return at(now() + delay_us, std::move(fn)); }
    /** False when `id` already ran or was cancelled. */
    bool cancel(EventId id);
    /** Runs every event up to `t`; then now() is `t` (virtual) or the clock has reached it (wall). */
    void run_until(TimeUs t);
    void run_for(TimeUs d) { run_until(now() + d); }

    /** Wall mode: `fn(events)` on the loop whenever `fd` is ready for `events` (Waiter bits); false in virtual time. */
    bool watch(int fd, uint32_t events, FdFn fn);
    void unwatch(int fd);
    /** Any thread: wakes the wall loop, so a post from a worker strand (SimCore::post) runs without waiting. */
    void wake();

    /**
     * `core` has a timer due at `t` under its generation `gen`: an entry in the executor's heap. Each core pushes its
     * earliest deadline when it changes; an entry whose generation or deadline is stale by the time it comes up is
     * dropped unrun (lazy invalidation, instead of FakeCore's scan of every timer).
     */
    void schedule(SimCore &core, TimeUs t, uint32_t gen);
    /** `core` has work now (a post, an input, a network post): its ready work runs after the current event. Any
     * thread (a worker strand's post wakes the wall loop). */
    void touch(SimCore &core);

    const LagStats &lag() const;
    /** Events run so far (timer entries of the cores included, stale ones not). */
    uint64_t events_run() const;

private:
    friend class SimCore;

    /** SimCore's constructor and destructor: an entry for a core that is gone (or another core at its address) is
     * dropped unrun. attach_core() returns the core's incarnation, which its entries carry. */
    uint64_t attach_core(SimCore &core);
    void detach_core(SimCore &core);

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace frsim
