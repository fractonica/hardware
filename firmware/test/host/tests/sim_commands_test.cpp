// fr_net_node's stdin table as the kit runs it (design m2-c2 D2, D8; sim/commands.hpp), through a fleet node's
// control commands in virtual time: every command of the table is known and answers with fr_net_node's lines (as
// members named by their `ev`); `diag <line>` answers fr.diag.exec's JSON, with the kit's additions in fr_diag's
// shapes (D11): `inject <inst> <gesture>` and `neighbors [from]`; a powered-off node and an unknown command say so.
#include <string>
#include <vector>

#include "sim/commands.hpp"
#include "sim/node.hpp"
#include "tests/net_air_fakes.hpp"
#include "tests/net_fakes.hpp"
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

}  // namespace

TEST(sim_commands_every_net_node_command_runs_on_a_fleet_node)
{
    FleetRig r(2);
    frsim::FleetNode &n = r.node(1);
    n.power_on();
    r.node(2).power_on();
    r.run_ms(1000);

    has(run(n, "state"), R"("state":{"ev":"state","serial_session":false)");
    has(run(n, "state"), R"("health":)");
    // Net's own hooks.
    run(n, "udp_block 2");
    has(run(n, "state"), R"("udp_blocked":true)");
    run(n, "udp_block 0");
    run(n, "drop_hub_link 1");
    run(n, "ip_block 1");
    r.run_ms(1500);
    has(run(n, "loss 5 3 tx"), R"("loss":{"ev":"loss","ok":true,"pct":5,"s":3,"dir":"tx"})");
    has(run(n, "loss 500 3", false), R"("ok":false)");
    has(run(n, "state"), R"("loss_dir":"tx")");
    run(n, "loss 0 0");
    // The links' hooks (NodeLinks): no FIN in the fleet, so TCP goes silent and comes back.
    run(n, "tcp 0");
    run(n, "tcp 1");
    has(run(n, "wifi_down 1"), R"("wifi":{"ev":"wifi","up":false})");
    r.run_ms(1100);
    run(n, "wifi_down 0");
    run(n, "air_loss 50");
    run(n, "air_loss 0");
    run(n, "usb 1");  // not a USB node: nothing to plug
    run(n, "hub_mute 1");
    run(n, "hub_mute 0");
    // MSG, bindings, tables.
    has(run(n, "msg broadcast topic-a hi there"), R"("msg_sent":{"ev":"msg_sent","dst":65535,"topic":"topic-a","ok":true)");
    has(run(n, "msg_reliable 2 topic-b x"), R"("msg_sent":{"ev":"msg_sent","dst":2,"topic":"topic-b")");
    static const std::vector<uint8_t> kJson = frt::bytes_of("{}");
    const fr::proto::Binding b{.slot = 1,
                               .on_port = 1,
                               .on_cls = fr::wire::kClsEvent,
                               .on_kind = 2,
                               .to_addr = 1,
                               .to_cls = fr::wire::kClsMsg,
                               .to_topic = "pressed",
                               .payload = kJson};
    const std::string hex = frsim::hex(frt::HubSim::body_of(b));
    has(run(n, "bind " + hex), R"("bind":{"ev":"bind","ok":true})");
    has(run(n, "bind zz", false), R"("bind":{"ev":"bind","ok":false})");
    has(run(n, "bindings"), hex);
    has(run(n, "unbind all"), R"("unbind":{"ev":"unbind","ok":true})");
    has(run(n, "neighbors"), R"("neighbors":{"ev":"neighbors","items":[)");
    has(run(n, "directory"), R"("directory":{"ev":"directory","items":[])");
    has(run(n, "inject click"), R"("inject":{"ev":"inject","ok":true})");
    has(run(n, "inject wobble", false), R"("inject":{"ev":"inject","ok":false})");
    // D20: a line through the node's log source.
    run(n, "log I fr_test hello from the kit");
    run(n, "log Q fr_test no such level", false);
    run(n, "log_rate 20");
    r.run_ms(500);
    run(n, "log_rate 0");
    run(n, "log_rate -1", false);
    run(n, "bye");
    // Not the table's.
    has(run(n, "fly away", false), R"("error":"unknown command")");
}

TEST(sim_commands_diag_answers_as_fr_diag_inject_and_neighbors_included)
{
    FleetRig r(3);
    for (size_t i = 1; i <= 3; ++i) {
        r.node(i).power_on();
    }
    r.run_ms(12'000);  // ESP-NOW heartbeats (every 5 s +-20 %) fill the neighbour tables
    frsim::FleetNode &n = r.node(1);

    // info in fr_diag's shape (diag.cpp cmd_info): identity, epoch and uptime since this boot (bootMark), the links,
    // and the Wi-Fi association from the AP model (T-FLOOD-B --router-off waits for wifi.up).
    const std::string info = run(n, "diag info");
    has(info, R"("response":{"ok":true,"id":"02f200000001","addr":1,"state":"PROVISIONED","epoch":1,)");
    has(info, R"("uptime_ms":12000,"inject_enabled":true,"test_pin":-1,"links":{)");
    has(info, R"("wifi":{"up":true,"ch":6,"bssid":"02:f2:a0:00:00:01","rssi":)");
    r.ap.set_up(false);
    r.run_ms(100);
    has(run(n, "diag info"), R"("wifi":{"up":false,)");
    r.ap.set_up(true);
    has(run(n, "diag stats relay"), R"("response":{"ok":true,"relay":{"seeded":)");
    has(run(n, "diag stats"), R"("net_logs":{"sent":)");
    has(run(n, "diag stats espnow"), R"("espnow":{"tx":)");
    // inject <inst> <gesture>: the instance's own command, as fr_diag's run_call answers it.
    has(run(n, "diag inject boot click"), R"("response":{"ok":true,"status":"ok","fields":{}})");
    has(run(n, "diag inject boot nonsense"), R"("response":{"ok":false,"error":"invalid_args")");
    has(run(n, "diag inject nope click"), R"("response":{"ok":false,"error":"not_found","detail":"no instance 'nope'"})");
    has(run(n, "diag inject boot"), R"("response":{"ok":false,"error":"invalid_args","detail":"usage: inject <inst> <gesture>"})");
    // neighbors [from]: sorted by MAC, paged from `from`.
    const std::string all = run(n, "diag neighbors");
    has(all, R"("response":{"ok":true,"count":2,"neighbors":[{"mac":"02f200000002","addr":2,"rssi":)");
    has(all, R"({"mac":"02f200000003","addr":3,)");
    has(run(n, "diag neighbors 1"), R"("response":{"ok":true,"count":2,"neighbors":[{"mac":"02f200000003")");
    has(run(n, "diag neighbors 2"), R"("response":{"ok":true,"count":2,"neighbors":[]})");
    has(run(n, "diag neighbors 21"), R"("response":{"ok":false,"error":"invalid_args")");
    has(run(n, "diag net wifi_down 1"), R"("response":{"ok":true,"hook":"wifi_down","s":1})");
    has(run(n, "diag pin_pulse 100"), R"("response":{"ok":false,"error":"unsupported")");
    has(run(n, "diag frobnicate"), R"("response":{"ok":false,"error":"unknown_command"})");
    // The serial command channel answers the same way.
    CHECK_EQ(frsim::serial_diag_id("#12 info").value_or(""), "12");
    CHECK(!frsim::serial_diag_id("#x info").has_value());
    CHECK(!frsim::serial_diag_id("@fr1:abc").has_value());
}

TEST(sim_commands_a_powered_off_node_says_so)
{
    FleetRig r(1);
    frsim::FleetNode &n = r.node(1);
    has(run(n, "state", false), R"("error":"powered off")");
    has(run(n, "usb attach", false), R"("error":"not a USB node")");
    run(n, "power on");
    has(run(n, "power on"), R"("already":true)");
    run(n, "power off");
    has(run(n, "power off"), R"("already":true)");
}
