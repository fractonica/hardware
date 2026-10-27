// The fleet kit's contracts (design m2-c2 §3 item 5): every header builds in the suite, and the numbers the design
// fixes hold. Behaviour is tested by streams S1 and S2 against their implementations.
#include <algorithm>

#include "sim/executor.hpp"
#include "sim/medium.hpp"
#include "sim/node.hpp"
#include "sim/sim_air.hpp"
#include "sim/sim_core.hpp"
#include "tests/test.hpp"

namespace {

using frsim::LagHistogram;

constexpr bool has_edge(fr::TimeUs us)
{
    return std::find(LagHistogram::kBoundsUs.begin(), LagHistogram::kBoundsUs.end(), us) != LagHistogram::kBoundsUs.end();
}

// D15: the preflight's 20 ms, the inconclusive rule's 100 ms and the 1 s stall are bucket edges, from 0.25 ms to 8 s.
static_assert(has_edge(20'000) && has_edge(100'000) && has_edge(1'000'000));
static_assert(LagHistogram::kBoundsUs.front() == 250 && LagHistogram::kBoundsUs.back() == 8'000'000);
static_assert(std::is_sorted(LagHistogram::kBoundsUs.begin(), LagHistogram::kBoundsUs.end()));
// D6: EspCore's pools and queues (esp_core.hpp).
static_assert(frsim::SimCore::kTimers == 28 && frsim::SimCore::kSlots == 8 && frsim::SimCore::kPosts == 16 &&
              frsim::SimCore::kNetPosts == 32);
// D4, D5: the driver's receive ring and service batch (05 §5.3, espnow.cpp) over the real Scheduler's queue.
static_assert(frsim::SimAir::kRxRing == 16 && frsim::SimAir::kServiceBatch == 4 && fr::net::air::kQueueFrames == 16);

}  // namespace

TEST(sim_contract_node_spec_defaults_are_fr_net_nodes)
{
    // A NodeSpec left at its defaults is the node fr_net_node starts without options (D2).
    const frsim::NodeSpec s;
    CHECK_EQ(s.addr, fr::proto::kAddrUnassigned);
    CHECK_EQ(s.epoch, 1);
    CHECK_EQ(s.hb_ms, 1000u);
    CHECK_EQ(s.profile, "c6-pad");
    CHECK_EQ(s.board, "esp32c6-supermini");
    CHECK_EQ(s.chip, 13);
    CHECK_EQ(s.radio.channel, 6);
    CHECK(s.radio.bcast_rate == frsim::Rate::r1m && s.radio.ucast_rate == frsim::Rate::r1m);
    CHECK(s.udp == frsim::NodeSpec::Udp::shared);
    CHECK(!s.usb && s.ota && !s.spare);
}
