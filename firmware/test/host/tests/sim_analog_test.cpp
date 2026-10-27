// The kit's analog support (design m2-c3-inputs §8; sim/node.hpp, sim/analog.cpp), on fleet nodes in virtual time:
// the kit profiles' port tables and the descriptor that follows them (c6-pad unchanged, c3o-analog with fr.analog_in
// on port 3, the C3's board and chip), the fleet spec refusing a profile the kit cannot play; WaveAnalog's seeded
// sine (in range, out of step between nodes) streaming `value` STATEs at report_hz, a hold going quiet, `analog
// report_hz` rebooting the node into another rate; and `inject <inst> value=<n> [hold_ms=<n>]` through NodeDiag and
// the command table, with `stats`' state_repeats_superseded beside it.
#include <string>

#include "analog_in.hpp"
#include "protocol.hpp"
#include "sim/node.hpp"
#include "tests/sim_node_rig.hpp"
#include "tests/test.hpp"

namespace {

using frt::FleetRig;

std::string run(frsim::FleetNode &n, const std::string &line, bool expect_ok = true)
{
    const frsim::FleetNode::Answer a = n.command(line);
    if (a.ok != expect_ok) {
        frt::fail(__FILE__, __LINE__, "`" + line + "` answered " + frt::answer_text(a));
    }
    return frt::answer_text(a);
}

bool has(const std::string &text, const std::string &part)
{
    if (text.find(part) == std::string::npos) {
        frt::fail(__FILE__, __LINE__, "no " + part + " in " + text);
        return false;
    }
    return true;
}

/** A number member of an answer's text (`"key":<n>`), or -1. */
long member(const std::string &json, const std::string &key)
{
    const size_t at = json.find("\"" + key + "\":");
    return at == std::string::npos ? -1 : std::strtol(json.c_str() + at + key.size() + 3, nullptr, 10);
}

/** The value 0..65535 that `mv` maps to over c3o-analog's 0..2,500 mV (the cap defaults). */
long value_of_mv(long mv)
{
    return mv * 65535 / 2500;
}

}  // namespace

TEST(sim_analog_kit_profiles_build_their_port_tables_and_descriptors)
{
    REQUIRE(frsim::kit_profile("c6-pad") != nullptr);
    const frsim::KitProfile *k = frsim::kit_profile("c3o-analog");
    REQUIRE(k != nullptr);
    CHECK(k->analog);
    CHECK_EQ(k->board, "esp32c3-oled042");
    CHECK_EQ(k->chip, 5);
    CHECK(frsim::kit_profile("c3o-pad") == nullptr);
    CHECK_EQ(frsim::kit_profile_names(), "c6-pad, c3o-analog");

    FleetRig pads(1);
    FleetRig analog(1, false, "c3o-analog");
    pads.node(1).power_on();
    analog.node(1).power_on();
    analog.run_ms(500);
    // c6-pad: boot and status, as before (schema/vectors Descriptor.c6_pad's table).
    const auto d6 = fr::proto::decode_descriptor(pads.node(1).descriptor());
    REQUIRE(d6.has_value());
    CHECK_EQ(d6->profile, "c6-pad");
    CHECK_EQ(d6->board, "esp32c6-supermini");
    REQUIRE_EQ(d6->caps.size(), 2u);
    // c3o-analog: the same two, then fr.analog_in 1.0 on port 3 with the C3's traits; board and chip follow.
    const frsim::NodeSpec &spec = analog.node(1).spec();
    CHECK_EQ(spec.board, "esp32c3-oled042");
    CHECK_EQ(spec.chip, 5);
    const auto d3 = fr::proto::decode_descriptor(analog.node(1).descriptor());
    REQUIRE(d3.has_value());
    CHECK_EQ(d3->profile, "c3o-analog");
    CHECK_EQ(d3->board, "esp32c3-oled042");
    REQUIRE_EQ(d3->caps.size(), 3u);
    CHECK_EQ(d3->caps[0].port, 1);
    CHECK_EQ(d3->caps[0].name, "boot");
    CHECK_EQ(d3->caps[1].port, 2);
    CHECK_EQ(d3->caps[1].name, "status");
    CHECK_EQ(d3->caps[2].port, 3);
    CHECK_EQ(d3->caps[2].name, "analog");
    CHECK_EQ(d3->caps[2].cap_id, 0x0005);
    CHECK_EQ(d3->caps[2].version, 0x0100);
    const auto traits = fr::cap::decode_analog_in_traits(d3->caps[2].traits);
    REQUIRE(traits.has_value());
    CHECK_EQ(traits->resolution_bits, 12);
    CHECK_EQ(traits->full_scale_mv, 2500);
    // A c6-pad node has no analog input.
    has(run(pads.node(1), "analog", false), R"("ok":false)");
    has(run(pads.node(1), "analog report_hz 50", false), R"("error":"no analog input")");
}

TEST(sim_analog_the_fleet_spec_takes_the_kit_profiles_only)
{
    const auto spec = [](const std::string &profile) {
        return R"({"schema":"fractonica/fleet-spec@1","seed":1,"state_dir":"/tmp/x","nodes":[{"alias":"sim-01","mac":"02f200000001",)"
               R"("addr":1,"net":42,"epoch":1,"alias_rev":1,"rng_seed":7,"profile":")" +
               profile + R"("}]})";
    };
    frsim::FleetSpec s;
    std::string error;
    REQUIRE(frsim::parse_fleet_spec(spec("c3o-analog"), s, error));
    CHECK_EQ(s.nodes[0].profile, "c3o-analog");
    CHECK_EQ(s.nodes[0].analog_report_hz, 20);
    frsim::FleetSpec bad;
    CHECK(!frsim::parse_fleet_spec(spec("s3l-pad"), bad, error));
    CHECK_EQ(error, "nodes[0].profile: the kit plays c6-pad, c3o-analog, not s3l-pad");
}

TEST(sim_analog_a_seeded_sine_streams_value_states_at_report_hz)
{
    FleetRig r(2, false, "c3o-analog");
    frsim::FleetNode &n = r.node(1);
    n.power_on();
    r.node(2).power_on();
    r.run_ms(1000);
    // At power-on the input holds 0 mV: the first sample's report, then nothing.
    const std::string idle = run(n, "analog");
    has(idle, R"("analog":{"ev":"analog","mode":"hold","period_ms":0,"lo_mv":0,"hi_mv":0,)");
    has(idle, R"("value":0,"injected":false,"reports":1,"report_hz":20,)");

    // A 1 s sine over 300..2200 mV, 5 s of it: the service reports at its 20 Hz (the trailing report keeps the rate
    // from dropping below it on a fast slope), never above.
    has(run(n, "analog wave 1000 300 2200"), R"("mode":"wave","period_ms":1000,"lo_mv":300,"hi_mv":2200,)");
    run(r.node(2), "analog wave 1000 300 2200");
    const long before = member(run(n, "analog"), "reports");
    long lo = 9999;
    long hi = 0;
    for (int i = 0; i < 100; ++i) {
        r.run_ms(50);
        const long mv = member(run(n, "analog"), "mv");
        lo = std::min(lo, mv);
        hi = std::max(hi, mv);
    }
    const long reports = member(run(n, "analog"), "reports") - before;
    CHECK(reports >= 90 && reports <= 101);
    CHECK(lo >= 300 && lo < 320);
    CHECK(hi <= 2200 && hi > 2180);
    // Each node's phase is its own (drawn from its seed), so the two are not in step.
    const std::string a = run(n, "analog");
    const std::string b = run(r.node(2), "analog");
    CHECK(member(a, "mv") != member(b, "mv"));

    // A hold goes quiet: one trailing report to the held value, then none.
    run(n, "analog hold 1250");
    r.run_ms(500);
    const std::string held = run(n, "analog");
    CHECK(std::abs(member(held, "value") - value_of_mv(1250)) < 512);
    const long settled = member(held, "reports");
    r.run_ms(3000);
    CHECK_EQ(member(run(n, "analog"), "reports"), settled);

    // Bad lines change nothing.
    has(run(n, "analog wave 5 0 100", false), R"("mode":"hold")");
    run(n, "analog wave 1000 900 100", false);
    run(n, "analog hold 4000", false);
    run(n, "analog spin", false);
}

TEST(sim_analog_report_hz_reboots_the_node_into_the_new_rate)
{
    FleetRig r(1, false, "c3o-analog");
    frsim::FleetNode &n = r.node(1);
    n.power_on();
    r.run_ms(500);
    has(run(n, "analog report_hz 20"), R"("report_hz":20,"reboot":false)");
    has(run(n, "analog report_hz 50"), R"("report_hz":50,"reboot":true)");
    run(n, "analog report_hz 0", false);
    run(n, "analog report_hz 201", false);
    r.run_ms(1500);  // the BYE, the restart at the next tick, 300 ms to the next boot
    CHECK_EQ(n.boots(), 2u);
    // The waveform is the world outside the board: it survived the reboot (a hold at 0 mV here).
    has(run(n, "analog"), R"("report_hz":50,)");
    run(n, "analog wave 1000 300 2200");
    const long before = member(run(n, "analog"), "reports");
    r.run_ms(4000);
    const long reports = member(run(n, "analog"), "reports") - before;
    CHECK(reports >= 180 && reports <= 201);
}

TEST(sim_analog_inject_holds_a_value_through_diag_and_the_table)
{
    FleetRig r(1, false, "c3o-analog");
    frsim::FleetNode &n = r.node(1);
    n.power_on();
    run(n, "analog hold 600");
    r.run_ms(1000);
    const long base = member(run(n, "analog"), "value");
    CHECK(std::abs(base - value_of_mv(600)) < 512);

    // fr_diag's analog form (diag.cpp cmd_inject): the instance's inject through the generated codec and dispatch.
    has(run(n, "diag inject analog value=50000 hold_ms=1000"), R"("response":{"ok":true,"status":"ok","fields":{}})");
    r.run_ms(10);
    const std::string held = run(n, "analog");
    has(held, R"("value":50000,"injected":true,)");
    r.run_ms(1100);  // the hold ends; the next real sample re-seeds the filter at 600 mV
    const std::string back = run(n, "analog");
    has(back, R"("injected":false)");
    CHECK(std::abs(member(back, "value") - base) < 512);

    // The command table's line, as fr_net_node's stdin takes it; hold_ms is optional (1,000 ms).
    has(run(n, "inject analog value=40000"), R"("inject":{"ev":"inject","ok":true})");
    r.run_ms(10);
    has(run(n, "analog"), R"("value":40000,"injected":true,)");
    has(run(n, "inject analog value=70000", false), R"("inject":{"ev":"inject","ok":false})");
    has(run(n, "diag inject analog value=70000"), R"("response":{"ok":false,"error":"invalid_args")");
    has(run(n, "diag inject analog value=1 hold_ms=60001"), R"("response":{"ok":false,"error":"invalid_args")");
    has(run(n, "diag inject analog value=1 hold=5"), R"("response":{"ok":false,"error":"invalid_args")");
    has(run(n, "diag inject nope value=1"), R"("response":{"ok":false,"error":"not_found","detail":"no instance 'nope'"})");
    // The button's inject takes a gesture, not a value; the button form still works beside the analog one.
    CHECK(run(n, "diag inject boot value=1").find(R"("status":"ok")") == std::string::npos);
    has(run(n, "diag inject boot click"), R"("response":{"ok":true,"status":"ok","fields":{}})");

    // state_repeats_superseded (design D6) where the firmware prints it: diag `stats` and the `state` line.
    has(run(n, "diag stats"), R"("delivery_failed":0,"state_repeats_superseded":0)");
    has(run(n, "state"), R"("state_repeats_superseded":0,)");
}
