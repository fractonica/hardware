// One node's core in the fleet kit (design m2-c2 D6): EspCore's pools and queues (28 timers, 8 slots, 16 posts, 32
// network posts), its round (inputs, then due timers, then one post, then one network post), a refused post counted,
// a failed timer() aborting with the node named, the clock's offset and skew (0 by default), post() hammered from 16
// threads losing nothing, and a crash (a bumped generation) dropping the node's queued work unrun.
#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include <csignal>
#include <sys/wait.h>
#include <unistd.h>

#include "sim/executor.hpp"
#include "sim/sim_core.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using frsim::Executor;
using frsim::SimCore;
using frsim::TimeMode;

/** Runs `fn` in a child process; true when it died of SIGABRT with `needle` on its stderr. */
template <class Fn>
bool aborts_saying(Fn fn, const std::string &needle)
{
    int p[2];
    if (::pipe(p) != 0) {
        return false;
    }
    std::fflush(stdout);  // the child must not print the parent's buffered lines again
    std::fflush(stderr);
    const pid_t pid = ::fork();
    if (pid == 0) {
        ::dup2(p[1], 2);
        ::close(p[0]);
        fn();
        ::_exit(0);
    }
    ::close(p[1]);
    std::string err;
    char buf[256];
    for (ssize_t n; (n = ::read(p[0], buf, sizeof(buf))) > 0;) {
        err.append(buf, static_cast<size_t>(n));
    }
    ::close(p[0]);
    int status = 0;
    ::waitpid(pid, &status, 0);
    return WIFSIGNALED(status) && WTERMSIG(status) == SIGABRT && err.find(needle) != std::string::npos;
}

}  // namespace

TEST(sim_core_round_order_inputs_timers_one_post_one_net_post)
{
    Executor exec(TimeMode::virtual_time);
    SimCore core(exec, "sim-01");
    std::string log;
    fr::InputSlot *slot = core.input_slot([&](const fr::InputSample &s) { log += "in" + std::to_string(s.edges) + " "; });
    fr::Timer *t1 = core.timer([&] { log += "t1 "; });
    fr::Timer *t2 = core.timer([&] { log += "t2 "; });
    REQUIRE(slot != nullptr && t1 != nullptr && t2 != nullptr);
    t2->start(0);
    t1->start(0);  // same deadline, started later: after t2
    for (int i = 1; i <= 3; ++i) {
        CHECK(core.post([&log, i] { log += "p" + std::to_string(i) + " "; }));
        CHECK(core.post_net([&log, i] { log += "n" + std::to_string(i) + " "; }));
    }
    slot->update_from_isr(true, exec.now());
    slot->update_from_isr(false, exec.now());  // coalesced: one sample, two edges
    exec.run_for(0);
    CHECK_EQ(log, "in2 t2 t1 p1 n1 p2 n2 p3 n3 ");
}

TEST(sim_core_timers_in_deadline_order_and_restart_at_zero_waits_a_round)
{
    Executor exec(TimeMode::virtual_time);
    SimCore core(exec, "sim-01");
    struct Ctx {
        Executor &exec;
        std::string log{};
        fr::Timer *a = nullptr;
        int spins = 0;
        void note(const char *what) { log += std::string(what) + "@" + std::to_string(exec.now() - 1'000'000) + " "; }
    } ctx{exec};
    ctx.a = core.timer([&ctx] {
        ctx.note("a");
        if (++ctx.spins < 3) {
            ctx.a->start(0);  // started inside the pass: it waits for the next round, after the post
        }
    });
    fr::Timer *b = core.timer([&ctx] { ctx.note("b"); });
    fr::Timer *c = core.timer([&ctx] { ctx.note("c"); });
    ctx.a->start(2'000);
    b->start(1'000);
    c->start(1'500);
    c->stop();
    CHECK(!c->running());
    CHECK(core.post([&ctx] { ctx.log += "post "; }));
    exec.run_for(5'000);
    CHECK_EQ(ctx.log, "post b@1000 a@2000 a@2000 a@2000 ");
    CHECK_EQ(core.next_deadline(), INT64_MAX);
    // A timer restarted earlier than the pending entry still fires at its own time (the late entry is stale).
    ctx.log.clear();
    ctx.a->start(10'000);
    exec.run_for(1'000);
    ctx.a->start(500);
    exec.run_for(20'000);
    CHECK_EQ(ctx.log, "a@6500 ");
}

TEST(sim_core_queues_refuse_and_count)
{
    Executor exec(TimeMode::virtual_time);
    SimCore core(exec, "sim-01");
    int ran = 0;
    for (size_t i = 0; i < SimCore::kPosts; ++i) {
        CHECK(core.post([&] { ++ran; }));
    }
    CHECK(!core.post([&] { ++ran; }));
    for (size_t i = 0; i < SimCore::kNetPosts; ++i) {
        CHECK(core.post_net([&] { ++ran; }));
    }
    CHECK(!core.post_net([&] { ++ran; }));
    CHECK(!core.post_net([&] { ++ran; }));
    CHECK_EQ(core.stats().posts_refused, 1u);
    CHECK_EQ(core.stats().net_posts_refused, 2u);
    exec.run_for(0);
    CHECK_EQ(ran, static_cast<int>(SimCore::kPosts + SimCore::kNetPosts));
    // Room again once they ran.
    CHECK(core.post([&] { ++ran; }));
}

TEST(sim_core_pools_and_abort_naming_the_node)
{
    Executor exec(TimeMode::virtual_time);
    SimCore core(exec, "sim-07");
    for (size_t i = 0; i < SimCore::kTimers; ++i) {
        CHECK(core.timer([] {}) != nullptr);
    }
    for (size_t i = 0; i < SimCore::kSlots; ++i) {
        CHECK(core.input_slot([](const fr::InputSample &) {}) != nullptr);
    }
    // One more of either aborts the fleet, naming the node: a Net without its timer would be silently dead.
    CHECK(aborts_saying([&] { core.timer([] {}); }, "sim-07"));
    CHECK(aborts_saying([&] { core.input_slot([](const fr::InputSample &) {}); }, "sim-07"));
}

TEST(sim_core_clock_offset_and_skew)
{
    Executor exec(TimeMode::virtual_time);
    SimCore core(exec, "sim-01");
    CHECK_EQ(core.now(), exec.now());  // C2's default: the executor's clock
    std::vector<TimeUs> fired;
    fr::Timer *t = core.timer([&] { fired.push_back(exec.now()); });
    core.set_clock(5'000, 0);
    CHECK_EQ(core.now(), exec.now() + 5'000);
    t->start(1'000);
    exec.run_for(2'000);
    REQUIRE_EQ(fired.size(), 1u);
    CHECK_EQ(fired[0], 1'001'000);  // 1 ms of the executor's time: the offset does not stretch delays
    // +100 ppm: the node's clock gains 1 ms in 10 s, and its timers fire that much earlier on the executor's clock.
    core.set_clock(0, 100);
    const TimeUs e0 = exec.now();
    const TimeUs c0 = core.now();
    exec.run_for(10'000'000);
    CHECK_EQ(core.now() - c0, 10'001'000);
    t->start(10'000'000);
    const TimeUs started = exec.now();
    exec.run_for(11'000'000);
    REQUIRE_EQ(fired.size(), 2u);
    const TimeUs took = fired[1] - started;
    CHECK(took >= 9'998'900 && took <= 9'999'100);
    static_cast<void>(e0);
}

TEST(sim_core_post_from_16_threads_loses_nothing)
{
    Executor exec(TimeMode::wall);
    SimCore core(exec, "sim-01");
    constexpr int kThreads = 16;
    constexpr int kEach = 1000;
    std::atomic<int> refused{0};
    int ran = 0;  // core task only
    std::vector<std::thread> threads;
    for (int i = 0; i < kThreads; ++i) {
        threads.emplace_back([&] {
            for (int k = 0; k < kEach; ++k) {
                while (!core.post([&ran] { ++ran; })) {
                    ++refused;
                    std::this_thread::yield();
                }
            }
        });
    }
    const TimeUs deadline = exec.now() + 20'000'000;
    while (ran < kThreads * kEach && exec.now() < deadline) {
        exec.run_for(5'000);
    }
    for (std::thread &t : threads) {
        t.join();
    }
    exec.run_for(5'000);
    CHECK_EQ(ran, kThreads * kEach);
    CHECK_EQ(static_cast<int>(core.stats().posts_refused), refused.load());
}

TEST(sim_core_crash_drops_queued_work_unrun)
{
    Executor exec(TimeMode::virtual_time);
    SimCore core(exec, "sim-01");
    int ran = 0;
    fr::Timer *t = core.timer([&] { ++ran; });
    t->start(1'000);
    CHECK(core.post([&] { ++ran; }));
    CHECK(core.post_net([&] { ++ran; }));
    const uint32_t gen = core.generation();
    core.crash();
    CHECK_EQ(core.generation(), gen + 1);
    exec.run_for(5'000);
    CHECK_EQ(ran, 0);
    // The rebuilt node gets the pools afresh: all 28 timers again, and they run.
    fr::Timer *fresh = nullptr;
    for (size_t i = 0; i < SimCore::kTimers; ++i) {
        fresh = core.timer([&] { ++ran; });
        REQUIRE(fresh != nullptr);
    }
    fresh->start(100);
    exec.run_for(1'000);
    CHECK_EQ(ran, 1);
    // An executor entry pushed under the old generation is dropped, not run against the new node.
    fresh->start(2'000);
    core.crash();
    fr::Timer *after = core.timer([&] { ran += 10; });
    after->start(5'000);
    exec.run_for(10'000);
    CHECK_EQ(ran, 11);
}

TEST(sim_core_destroyed_core_entries_are_dropped)
{
    Executor exec(TimeMode::virtual_time);
    int ran = 0;
    {
        SimCore gone(exec, "sim-02");
        gone.timer([&] { ++ran; })->start(1'000);
        CHECK(gone.post([&] { ++ran; }));
    }
    SimCore other(exec, "sim-03");  // may take the same address
    exec.run_for(5'000);
    CHECK_EQ(ran, 0);
}
