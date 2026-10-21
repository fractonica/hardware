// FakeCore's own core-task ordering and pool bounds (spec 03 §3.4), which every service and fr_net test
// relies on: inputs, then due timers, then posted functions; bounded pools.
#include <vector>

#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;

}  // namespace

TEST(fake_core_runs_inputs_then_timers_then_posts)
{
    FakeCore core;
    std::vector<int> order;
    fr::Timer *t = core.timer([&] { order.push_back(2); });
    fr::InputSlot *s = core.input_slot([&](const fr::InputSample &smp) { order.push_back(smp.edges == 2 ? 1 : -1); });
    REQUIRE(t != nullptr && s != nullptr);
    CHECK(core.post([&] { order.push_back(3); }));
    t->start(0);
    s->update_from_isr(true, core.now());
    s->update_from_isr(false, core.now());
    core.run_ready();
    CHECK(order == std::vector<int>({1, 2, 3}));
    CHECK(!t->running());
}

TEST(fake_core_timers_fire_in_deadline_order_at_their_time)
{
    FakeCore core;
    std::vector<fr::TimeUs> fired;
    fr::Timer *a = core.timer([&] { fired.push_back(core.now()); });
    fr::Timer *b = core.timer([&] { fired.push_back(-core.now()); });
    fr::TimeUs t0 = core.now();
    a->start(3000);
    b->start(1000);
    a->start(2000);  // restart replaces the first deadline
    core.advance_ms(10);
    CHECK(fired == std::vector<fr::TimeUs>({-(t0 + 1000), t0 + 2000}));
    b->start(500);
    b->stop();
    core.advance_ms(10);
    CHECK_EQ(fired.size(), 2u);
}

TEST(fake_core_pools_are_bounded)
{
    FakeCore core;
    for (size_t i = 0; i < FakeCore::kPosts; ++i) {
        CHECK(core.post([] {}));
    }
    CHECK(!core.post([] {}));
    for (size_t i = 0; i < FakeCore::kSlots; ++i) {
        CHECK(core.input_slot([](const fr::InputSample &) {}) != nullptr);
    }
    CHECK(core.input_slot([](const fr::InputSample &) {}) == nullptr);
}
