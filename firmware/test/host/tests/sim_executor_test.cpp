// The fleet kit's executor (design m2-c2 D6, D15): virtual time is deterministic (one seed, one trace; ties in
// insertion order); wall time runs late events in timestamp order with a monotonic now() and records their lateness
// in the histogram the inconclusive rule reads (an injected 50 ms stall shows); both Waiter backends wait to the µs
// (kqueue) or ms (poll), report ready fds and wake from another thread.
#include <atomic>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

#include "sim/executor.hpp"
#include "sim/medium.hpp"
#include "sim/sim_core.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using frsim::EventId;
using frsim::Executor;
using frsim::LagHistogram;
using frsim::TimeMode;
using frsim::Waiter;

void busy_sleep_us(TimeUs us)
{
    std::this_thread::sleep_for(std::chrono::microseconds(us));
}

/** A radio that logs what the medium tells it. */
class LogPort final : public frsim::RadioPort
{
public:
    LogPort(Executor &e, std::string &log, char name) : exec_(e), log_(log), name_(name) {}
    void received(std::span<const uint8_t> frame, const fr::net::RxMeta &) override
    {
        log_ += std::string(1, name_) + "<" + std::to_string(frame[0]) + "@" + std::to_string(exec_.now()) + " ";
    }
    void transmitted(bool ok) override { log_ += std::string(1, name_) + (ok ? "+" : "-") + std::to_string(exec_.now()) + " "; }
    uint32_t generation() const override { return 0; }

private:
    Executor &exec_;
    std::string &log_;
    char name_;
};

/** Four radios in one room sending at the same instants: the backoffs, collisions and deliveries for `seed`. */
std::string medium_trace(uint64_t seed)
{
    Executor exec(TimeMode::virtual_time);
    frsim::Medium m(exec, {.seed = seed, .collisions = true, .capture_db = 10, .send_cb_us = 50});
    std::string log;
    std::vector<std::unique_ptr<LogPort>> ports;
    std::vector<frsim::RadioId> ids;
    for (uint8_t i = 0; i < 4; ++i) {
        ports.push_back(std::make_unique<LogPort>(exec, log, static_cast<char>('a' + i)));
        ids.push_back(m.add_radio(*ports.back(), {2, 0, 0, 0, 0, i}, 6));
    }
    for (frsim::RadioId a : ids) {
        for (frsim::RadioId b : ids) {
            if (a != b) {
                m.set_pair(a, b, {.reach = true, .loss = 0.1, .rssi_dbm = static_cast<int8_t>(-50 - 5 * a), .rssi_sigma_db = 2});
            }
        }
    }
    for (int round = 0; round < 20; ++round) {
        for (frsim::RadioId a : ids) {
            const auto byte = static_cast<uint8_t>(round);
            exec.at(1'100'000 + round * 20'000, [&m, a, byte] { m.transmit(a, fr::net::kBroadcastMac, {&byte, 1}, frsim::Rate::r1m); });
        }
    }
    exec.run_until(2'000'000);
    return log;
}

/** Waits on `w` for `fd` with a timeout; the ready calls and the elapsed µs. */
struct WaitResult {
    std::vector<std::pair<int, uint32_t>> ready;
    TimeUs elapsed_us = 0;
    bool ok = false;
};

WaitResult wait_once(Waiter &w, TimeUs timeout_us)
{
    WaitResult r;
    const auto t0 = std::chrono::steady_clock::now();
    r.ok = w.wait(timeout_us, [&r](int fd, uint32_t ev) { r.ready.emplace_back(fd, ev); });
    r.elapsed_us = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - t0).count();
    return r;
}

void check_waiter(Waiter &w, bool us_precision)
{
    int p[2];
    REQUIRE(::pipe(p) == 0);
    REQUIRE(w.add(p[0], Waiter::kRead));
    // Nothing ready: the timeout passes (at least that long; poll() rounds 2.3 ms up to 3).
    WaitResult r = wait_once(w, 2'300);
    CHECK(r.ok);
    CHECK(r.ready.empty());
    CHECK(r.elapsed_us >= (us_precision ? 2'300 : 3'000));
    // A readable fd is reported, and stays so until read.
    const char c = 'x';
    REQUIRE(::write(p[1], &c, 1) == 1);
    r = wait_once(w, 1'000'000);
    REQUIRE_EQ(r.ready.size(), 1u);
    CHECK_EQ(r.ready[0].first, p[0]);
    CHECK((r.ready[0].second & Waiter::kRead) != 0);
    CHECK(r.elapsed_us < 500'000);
    char buf[4];
    CHECK(::read(p[0], buf, sizeof(buf)) == 1);
    // A wake() from another thread ends a long wait early; one made before the wait is not lost either.
    std::thread waker([&w] {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        w.wake();
    });
    r = wait_once(w, 5'000'000);
    waker.join();
    CHECK(r.ok);
    CHECK(r.ready.empty());
    CHECK(r.elapsed_us < 2'000'000);
    w.wake();
    r = wait_once(w, 5'000'000);
    CHECK(r.elapsed_us < 1'000'000);
    // Removed, the fd is no longer reported.
    w.remove(p[0]);
    REQUIRE(::write(p[1], &c, 1) == 1);
    r = wait_once(w, 5'000);
    CHECK(r.ready.empty());
    ::close(p[0]);
    ::close(p[1]);
}

}  // namespace

TEST(sim_executor_virtual_order_and_cancel)
{
    Executor exec(TimeMode::virtual_time);
    CHECK_EQ(exec.now(), 1'000'000);
    std::string log;
    exec.at(1'000'300, [&] { log += "c" + std::to_string(exec.now()) + " "; });
    exec.at(1'000'100, [&] { log += "a" + std::to_string(exec.now()) + " "; });
    exec.at(1'000'100, [&] { log += "b" + std::to_string(exec.now()) + " "; });  // a tie: insertion order
    const EventId gone = exec.at(1'000'200, [&] { log += "x "; });
    CHECK(exec.cancel(gone));
    CHECK(!exec.cancel(gone));
    exec.at(1'000'100, [&] {
        // Added while running: one already past runs next, at the current time.
        exec.at(5, [&] { log += "p" + std::to_string(exec.now()) + " "; });
    });
    exec.run_until(1'000'250);
    CHECK_EQ(log, "a1000100 b1000100 p1000100 ");
    CHECK_EQ(exec.now(), 1'000'250);  // run_until leaves the clock at its end
    exec.run_for(100);
    CHECK_EQ(log, "a1000100 b1000100 p1000100 c1000300 ");
    // Virtual events are never late.
    CHECK_EQ(exec.lag().late, 0u);
    CHECK_EQ(exec.lag().all.max_us, 0);
    CHECK_EQ(exec.lag().all.count, exec.events_run());
}

TEST(sim_executor_one_seed_one_trace)
{
    const std::string a = medium_trace(11);
    CHECK(a.size() > 400u);
    CHECK_EQ(medium_trace(11), a);
    CHECK(medium_trace(12) != a);
}

TEST(sim_executor_wall_late_events_in_order_with_monotonic_now)
{
    Executor exec(TimeMode::wall);
    const TimeUs t0 = exec.now();
    CHECK(t0 >= 1'000'000);
    std::vector<std::pair<int, TimeUs>> ran;
    for (int i : {3, 1, 2}) {
        exec.at(t0 + i * 1'000, [&ran, &exec, i] { ran.emplace_back(i, exec.now()); });
    }
    busy_sleep_us(30'000);  // the loop was away: all three are about 27-29 ms late
    exec.run_until(t0 + 40'000);
    REQUIRE_EQ(ran.size(), 3u);
    CHECK_EQ(ran[0].first, 1);
    CHECK_EQ(ran[1].first, 2);
    CHECK_EQ(ran[2].first, 3);
    for (size_t i = 0; i < ran.size(); ++i) {
        CHECK(ran[i].second >= t0 + 30'000);  // each saw the time it actually ran
        if (i > 0) {
            CHECK(ran[i].second >= ran[i - 1].second);
        }
    }
    CHECK(exec.now() >= t0 + 40'000);
    CHECK_EQ(exec.lag().late, 3u);
    CHECK(exec.lag().all.max_us >= 27'000);
    CHECK_EQ(exec.lag().all.count, 3u);
}

TEST(sim_executor_wall_lag_histogram_sees_a_50ms_stall)
{
    Executor exec(TimeMode::wall);
    const TimeUs t0 = exec.now();
    // An event that stalls the loop 60 ms; the one due 1 ms after it waits for it.
    exec.at(t0 + 1'000, [] { busy_sleep_us(60'000); });
    exec.at(t0 + 2'000, [] {});
    // Ticks every 5 ms afterwards, on time.
    for (int i = 0; i < 20; ++i) {
        exec.at(t0 + 100'000 + i * 5'000, [] {});
    }
    exec.run_until(t0 + 250'000);
    const frsim::LagStats &lag = exec.lag();
    CHECK_EQ(lag.all.count, 22u);
    CHECK(lag.all.max_us >= 50'000);
    CHECK(lag.all.buckets[8] + lag.all.buckets[9] >= 1u);  // [50, 100) or [100, 200) ms
    CHECK(lag.all.quantile(1.0) >= lag.all.max_us);  // the bound of the bucket holding the max
    CHECK(lag.all.quantile(0.5) <= 50'000);  // the ticks ran on time (within a loaded host's own jitter)
    CHECK(lag.late >= 1u);
}

TEST(sim_executor_lag_histogram_quantiles)
{
    LagHistogram h;
    CHECK_EQ(h.quantile(0.99), 0);
    for (int i = 0; i < 98; ++i) {
        h.add(100);  // bucket < 250 µs
    }
    h.add(30'000);   // < 50 ms
    h.add(-5);       // counts as 0
    CHECK_EQ(h.count, 100u);
    CHECK_EQ(h.quantile(0.5), 250);
    CHECK_EQ(h.quantile(0.99), 250);  // rank 99 of 100: still the first bucket
    CHECK_EQ(h.quantile(1.0), 50'000);
    h.add(9'000'000);  // beyond 8 s: the last bucket reports the max
    CHECK_EQ(h.quantile(1.0), 9'000'000);
    CHECK_EQ(h.max_us, 9'000'000);
    CHECK_EQ(h.sum_us, 98 * 100 + 30'000 + 9'000'000);
}

TEST(sim_executor_waiter_backends)
{
    auto poll = frsim::make_poll_waiter();
    REQUIRE(poll != nullptr);
    check_waiter(*poll, false);
#if defined(__APPLE__)
    auto kq = frsim::make_kqueue_waiter();
    REQUIRE(kq != nullptr);
    check_waiter(*kq, true);
#else
    CHECK(frsim::make_kqueue_waiter() == nullptr);
#endif
    CHECK(frsim::make_waiter() != nullptr);
}

TEST(sim_executor_wall_watch_and_wake)
{
    Executor exec(TimeMode::wall);
    int p[2];
    REQUIRE(::pipe(p) == 0);
    std::vector<TimeUs> reads;
    CHECK(exec.watch(p[0], Waiter::kRead, [&](uint32_t) {
        char buf[8];
        if (::read(p[0], buf, sizeof(buf)) > 0) {
            reads.push_back(exec.now());
        }
    }));
    const TimeUs t0 = exec.now();
    exec.at(t0 + 10'000, [&] {
        const char c = 1;
        CHECK(::write(p[1], &c, 1) == 1);
    });
    // A post from another thread wakes the loop at once, not at the next event.
    frsim::SimCore core(exec, "sim-01");
    std::atomic<TimeUs> posted_at{0};
    TimeUs ran_at = 0;
    std::thread poster([&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        posted_at = exec.now();
        CHECK(core.post([&] { ran_at = exec.now(); }));
    });
    exec.run_until(t0 + 200'000);
    poster.join();
    REQUIRE_EQ(reads.size(), 1u);
    CHECK(reads[0] >= t0 + 10'000 && reads[0] < t0 + 150'000);
    CHECK(ran_at != 0);
    CHECK(ran_at - posted_at.load() < 100'000);  // woken at once, not at the run's end (+200 ms)
    exec.unwatch(p[0]);
    ::close(p[0]);
    ::close(p[1]);
    // Virtual time watches nothing.
    Executor v(TimeMode::virtual_time);
    CHECK(!v.watch(0, Waiter::kRead, [](uint32_t) {}));
}
