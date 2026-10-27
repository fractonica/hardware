// One node's core task in the fleet kit (design m2-c2 D6): fr::Core with EspCore's pools, queues and per-round
// order (esp_core.hpp, esp_core.cpp), on the shared Executor's clock. 28 timers, 8 input slots, 16 posts and a
// separate 32-deep network queue (post_net: received hub-link envelopes and the ESP-NOW service), so a burst of air
// deliveries is never refused where the target would take it; a refused post is counted, as the target drops it
// too. A failed timer() or input_slot() aborts the process with the node named: a Net without its timer is silently
// dead. post() is thread-safe for the wall mode's worker strands (D1); everything else is core-task only. The
// generation, bumped by crash(), lets every event bound to this node (executor, medium, posts) be dropped unrun once
// the node it was made for is gone (D8).
//
// Contract by the foundation (design m2-c2 §3 item 5), implemented in sim_core.cpp (stream S1); stream S2's worker
// strands and sockets use post() and post_net(). Test code: it may allocate.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string_view>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "sim/executor.hpp"

namespace frsim {

class SimCore final : public fr::Core
{
public:
    // EspCore's (esp_core.hpp).
    static constexpr size_t kTimers = 28;
    static constexpr size_t kSlots = 8;
    static constexpr size_t kPosts = 16;
    static constexpr size_t kNetPosts = 32;

    /** Posts refused because their queue was full (the target drops them too), and the timer pool's use. */
    struct Stats {
        uint32_t posts_refused = 0;
        uint32_t net_posts_refused = 0;
        uint32_t timers = 0;  // timers handed out this boot (of kTimers)
    };

    /** `name` (the node's alias) is what an abort names. */
    SimCore(Executor &exec, std::string_view name);
    ~SimCore();
    SimCore(const SimCore &) = delete;
    SimCore &operator=(const SimCore &) = delete;

    // fr::Core
    /** The executor's clock + offset, with the skew applied (both 0 by default: TIME, PONG and exec_at as today). */
    fr::TimeUs now() const override;
    /** From the pool of kTimers; aborts naming the node when it is empty. */
    fr::Timer *timer(fr::Callback<void(), 24> on_fire) override;
    /** From the pool of kSlots; aborts naming the node when it is empty. */
    fr::InputSlot *input_slot(fr::Callback<void(const fr::InputSample &), 24> on_change) override;
    /** Any thread: queued under a mutex, then the executor's waiter is woken; false (counted) when kPosts are queued. */
    bool post(fr::Callback<void(), 32> fn) override;

    /** EspCore::post_net: the network queue, kNetPosts deep, serviced after one post per round. Core task only. */
    bool post_net(fr::Callback<void(), 32> fn);

    /**
     * EspCore's round, repeated until nothing is ready: inputs, then due timers (earliest deadline first, ties in
     * start order), then one post, then one network post. The executor calls it; it re-schedules the core's
     * earliest deadline (Executor::schedule) when that changed.
     */
    void run_ready();
    /** The earliest armed timer's deadline, INT64_MAX when none. */
    fr::TimeUs next_deadline() const;

    /** The node's generation: events made under an older one are dropped unrun. */
    uint32_t generation() const;
    /**
     * A power cut or a crash (D8): every timer stops, the queues are emptied, the pools are handed out afresh to
     * the node rebuilt in place, and the generation goes up. The caller first waits for the node's in-flight worker
     * job and discards its queued ones.
     */
    void crash();

    /** C8's knobs: the clock's offset from the executor's (µs) and its skew (ppm). 0 and 0 in C2. */
    void set_clock(fr::TimeUs offset_us, int32_t skew_ppm);

    std::string_view name() const;
    Stats stats() const;
    /** The executor this core runs on (SimAir arms its timer there). */
    Executor &executor() const;

private:
    friend class Executor;

    // The executor's side (executor.cpp): which SimCore this is (a new one at a freed address is another), the
    // touched flag that keeps one core once in the executor's list, and the lazy check of a heap entry: true when
    // (t, gen) is the entry this core last pushed, which then counts as taken.
    uint64_t incarnation() const;
    bool claim_touch();
    void clear_touch();
    bool take_entry(fr::TimeUs t, uint32_t gen);

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace frsim
