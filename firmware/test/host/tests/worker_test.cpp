// The fr_worker contract (spec 03 §3.4) as FakeWorker keeps it for host tests: FIFO, one job at a time,
// a bounded queue whose overflow is refused (post() false) rather than blocking the poster.
#include <vector>

#include "tests/fake_worker.hpp"
#include "tests/test.hpp"

TEST(worker_runs_jobs_in_order_only_when_run)
{
    frt::FakeWorker w;
    std::vector<int> order;
    CHECK(w.post([&order] { order.push_back(1); }));
    CHECK(w.post([&order] { order.push_back(2); }));
    CHECK(order.empty());
    CHECK_EQ(w.pending(), 2u);
    CHECK(w.run_one());
    CHECK_EQ(order.size(), 1u);
    CHECK_EQ(w.run_all(), 1u);
    REQUIRE_EQ(order.size(), 2u);
    CHECK_EQ(order[0], 1);
    CHECK_EQ(order[1], 2);
    CHECK(!w.run_one());
}

TEST(worker_queue_is_bounded)
{
    frt::FakeWorker w;
    int runs = 0;
    for (size_t i = 0; i < fr::worker::kQueueDepth; ++i) {
        CHECK(w.post([&runs] { ++runs; }));
    }
    CHECK(!w.post([&runs] { ++runs; }));
    CHECK_EQ(w.dropped, 1u);
    CHECK_EQ(w.run_all(), fr::worker::kQueueDepth);
    CHECK_EQ(runs, static_cast<int>(fr::worker::kQueueDepth));
    // A job may post the next step of its own work (a download chunk after chunk).
    fr::Worker &iface = w;
    int chunks = 0;
    struct Step {
        fr::Worker *w;
        int *chunks;
        void operator()() const
        {
            if (++*chunks < 3) {
                w->post(*this);
            }
        }
    };
    CHECK(iface.post(Step{&iface, &chunks}));
    CHECK_EQ(w.run_all(), 3u);
    CHECK_EQ(chunks, 3);
}

TEST(worker_contract_constants)
{
    // spec 03 §3.4: fr_worker at priority 5, below fr_serial (9), fr_core (10) and fr_net (11); 6 KB stack.
    CHECK_EQ(fr::worker::kPriority, 5u);
    CHECK_EQ(fr::worker::kStackBytes, 6144u);
}
