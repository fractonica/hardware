// The medium's airtime model (design m2-c2 §2.1): every row of the table to the µs, the C5 medium's folded formula
// beside it, and the medium's channel use in that unit (05 §5.15: 240 frames/s of 32 B unicasts is about 35 %).
#include "sim/airtime.hpp"
#include "sim/medium.hpp"
#include "tests/test.hpp"

namespace {

using frsim::Rate;
namespace airtime = frsim::airtime;

}  // namespace

TEST(sim_airtime_rows)
{
    // On air, `len` B of envelope: 192 + 8 (len + 43) at 1 Mbps; 20 + 4 ceil((22 + 8 (len + 43)) / 24) + 6 at 6 Mbps.
    CHECK_EQ(airtime::on_air_us(Rate::r1m, 32), 792u);
    CHECK_EQ(airtime::on_air_us(Rate::r6m, 32), 130u);
    CHECK_EQ(airtime::on_air_us(Rate::r1m, 1470), 12'296u);
    CHECK_EQ(airtime::on_air_us(Rate::r6m, 1470), 2'050u);
    // The unicast ACK after SIFS, and the contention (DIFS + U{0..CW} slots, its mean).
    CHECK_EQ(airtime::phy(Rate::r1m).ack_us, 314u);
    CHECK_EQ(airtime::phy(Rate::r6m).ack_us, 60u);
    CHECK_EQ(airtime::phy(Rate::r1m).difs_us, 50u);
    CHECK_EQ(airtime::phy(Rate::r1m).slot_us, 20u);
    CHECK_EQ(airtime::phy(Rate::r1m).cw, 31u);
    CHECK_EQ(airtime::phy(Rate::r6m).difs_us, 28u);
    CHECK_EQ(airtime::phy(Rate::r6m).slot_us, 9u);
    CHECK_EQ(airtime::phy(Rate::r6m).cw, 15u);
    CHECK_EQ(airtime::mean_contention_us(Rate::r1m), 360u);
    CHECK_EQ(airtime::mean_contention_us(Rate::r6m), 96u);
    // 32 B broadcast 1,152 / 226; 32 B unicast 1,466 / 286; 1470 B 12,656 / 2,146.
    CHECK_EQ(airtime::planning_us(Rate::r1m, 32, false), 1'152u);
    CHECK_EQ(airtime::planning_us(Rate::r6m, 32, false), 226u);
    CHECK_EQ(airtime::planning_us(Rate::r1m, 32, true), 1'466u);
    CHECK_EQ(airtime::planning_us(Rate::r6m, 32, true), 286u);
    CHECK_EQ(airtime::planning_us(Rate::r1m, 1470, false), 12'656u);
    CHECK_EQ(airtime::planning_us(Rate::r6m, 1470, false), 2'146u);
}

TEST(sim_airtime_c5_formula_is_the_1m_row_with_mean_contention)
{
    // The C5 medium's 900 + 8 len (net_air_medium.hpp) folds the mean contention into the 1 Mbps row: within 4 µs.
    for (size_t len : {18u, 32u, 64u, 120u, 200u, 250u}) {
        const auto c5 = static_cast<int64_t>(900 + 8 * len);
        const auto ours = static_cast<int64_t>(airtime::planning_us(Rate::r1m, len, false));
        CHECK(ours - c5 <= 4 && c5 - ours <= 4);
    }
}

TEST(sim_airtime_planning_unit_matches_05_5_15)
{
    // 240 unicasts/s of 32 B at 1 Mbps: about 35 % of the channel in the planning unit.
    const double pct = 240.0 * airtime::planning_us(Rate::r1m, 32, true) / 1e6 * 100.0;
    CHECK(pct > 34.5 && pct < 35.5);
}
