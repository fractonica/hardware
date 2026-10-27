// A fleet node (design m2-c2 D1, D2, D8; sim/node.hpp): NodeOut's tags and captures; the spec file; a power cycle in
// virtual time (epoch + 1 from the state directory, the stored bindings kept, nothing of the old boot left running);
// a delivery in flight on the medium when a node loses power dropped, never handed to its next boot; the worker
// strand (post order, one job at a time, on the pool); and the power cut's other half: a GET blocked in a read shut
// down and its strand quiesced at once, its queued and later jobs dropped (under ASan in the suite). From the M2-C2
// review: a unicast to a powered-off node fails over ESP-NOW (fleet-3); power-on is a fresh boot for Net's TCP hold,
// `wifi_down` and `tcp 0` (fleet-1); a power off in a reboot's gap keeps the node off (fleet-2); `net wifi_down` is
// applied 300 ms after its RESULT, as fr_net's WifiSta does (fleet-5). M2-C4 (design m2-c4-gateway D18): the spec's
// role, and a gateway node's bridge behind `stats gw` (and nobody else's).
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "sim/node.hpp"
#include "tests/net_fakes.hpp"
#include "tests/sim_node_rig.hpp"
#include "tests/test.hpp"
#include "tools/ota_fake.hpp"

namespace {

using frt::FleetRig;
using frt::LineLog;

/** An Out that keeps its lines. */
class KeepOut final : public frsim::Out
{
public:
    void line(std::string_view text) override
    {
        const std::lock_guard lock(mu_);
        lines.emplace_back(text);
    }
    std::mutex mu_;
    std::vector<std::string> lines;
};

/** pad.boot.down -> node 2 status.blink {count: 1}, as net_bind_test's T-NN binding. */
std::string binding_hex()
{
    static const std::vector<uint8_t> kMac{0x02, 0xf2, 0x00, 0x00, 0x00, 0x02};
    static const std::vector<uint8_t> kArgs = frt::from_hex("08 01");
    const fr::proto::Binding b{.slot = 3,
                               .on_port = 1,
                               .on_cls = fr::wire::kClsEvent,
                               .on_kind = 2,
                               .to_mac = kMac,
                               .to_addr = 2,
                               .to_port = 2,
                               .to_cls = fr::wire::kClsCmd,
                               .to_kind = 3,
                               .payload = kArgs,
                               .reliable = false};
    return frsim::hex(frt::HubSim::body_of(b));
}

/** A member of an answer's text: what follows `"key":` up to the next `,` or `}`. */
std::string member(const std::string &json, const std::string &key)
{
    const size_t at = json.find("\"" + key + "\":");
    if (at == std::string::npos) {
        return {};
    }
    const size_t from = at + key.size() + 3;
    const size_t end = json.find_first_of(",}", from);
    return json.substr(from, end - from);
}

}  // namespace

TEST(sim_node_out_tags_its_lines_and_captures_an_answer)
{
    LineLog sink;
    std::atomic<int> verbosity{1};
    frsim::NodeOut out("sim-07", sink, verbosity);
    CHECK_EQ(out.tagged(R"({"ev":"x","n":1})"), R"({"node":"sim-07","ev":"x","n":1})");
    CHECK_EQ(out.tagged("{}"), R"({"node":"sim-07"})");
    out.emit(R"({"ev":"a"})");
    out.begin_capture();
    out.emit(R"({"ev":"b"})");
    std::thread t([&out] { out.emit(R"({"ev":"from_a_worker"})"); });  // not the answer's
    t.join();
    const std::vector<std::string> got = out.end_capture();
    REQUIRE_EQ(got.size(), 1u);
    CHECK_EQ(got[0], R"({"ev":"b"})");
    std::vector<std::string> lines = sink.lines();
    REQUIRE_EQ(lines.size(), 2u);
    CHECK_EQ(lines[0], R"({"node":"sim-07","ev":"a"})");
    CHECK_EQ(lines[1], R"({"node":"sim-07","ev":"from_a_worker"})");
    // Verbosity 0: answers and the 1 s counters only (D8); per-frame lines from 2.
    CHECK(!out.frames());
    verbosity = 0;
    out.emit(R"({"ev":"quiet"})");
    CHECK_EQ(sink.lines().size(), 2u);
    verbosity = 2;
    CHECK(out.frames());
}

TEST(sim_node_spec_file_parses_with_the_schemas_defaults)
{
    const std::string json = R"({"schema":"fractonica/fleet-spec@1","seed":5,"pace":0.5,"verbosity":0,"state_dir":"/tmp/x",
        "medium":{"topology":"two_rooms","rssi_dbm":[-80,-50],"loss":[0,0.01],"collisions":false,"cross_reach":0.25,
                  "rate":{"broadcast":"6M","unicast":"1M"}},
        "ap":{"channel":11,"udp_loss":0.05,"gaps":{"every_s":10,"len_ms":800},"assoc_ms":[500,900]},
        "nodes":[{"alias":"sim-01","mac":"02f200000001","addr":1,"net":42,"epoch":3,"alias_rev":1,"rng_seed":77,
                  "hb_ms":500,"health_ms":10000,"usb":true,"udp":"own","ota":false,"radio":{"channel":11},"profile":"c6-pad","spare":false},
                 {"alias":"sim-02","mac":"02f200000002","addr":2,"net":42,"epoch":1,"alias_rev":1,"rng_seed":78,"spare":true}]})";
    frsim::FleetSpec s;
    std::string error;
    REQUIRE(frsim::parse_fleet_spec(json, s, error));
    CHECK_EQ(s.seed, 5u);
    CHECK_EQ(s.pace, 0.5);
    CHECK(s.medium.topology == frsim::Topology::two_rooms);
    CHECK(!s.medium.collisions);
    CHECK(s.medium.bcast_rate == frsim::Rate::r6m);
    CHECK_EQ(s.medium.cross_reach.value_or(-1), 0.25);
    CHECK_EQ(s.medium.capture_db, 10.0);  // the default
    CHECK_EQ(s.ap.channel, 11);
    REQUIRE(s.ap.gaps.has_value());
    CHECK_EQ(s.ap.gaps->second, 800u);
    CHECK_EQ(s.ap.assoc_min_ms, 500u);
    REQUIRE_EQ(s.nodes.size(), 2u);
    const frsim::NodeSpec &a = s.nodes[0];
    CHECK_EQ(a.alias, "sim-01");
    CHECK_EQ(a.mac[5], 1);
    CHECK_EQ(a.epoch, 3);
    CHECK_EQ(a.hb_ms, 500u);
    CHECK_EQ(a.health_ms, 10000u);
    CHECK(a.usb && !a.ota && a.udp == frsim::NodeSpec::Udp::own && a.net_log && a.ip);
    CHECK_EQ(a.radio.channel, 11);
    CHECK(s.nodes[1].spare);
    CHECK_EQ(s.nodes[1].hb_ms, 1000u);  // the default

    frsim::FleetSpec bad;
    CHECK(!frsim::parse_fleet_spec(R"({"schema":"fractonica/fleet-spec@2","seed":1,"state_dir":"/x","nodes":[]})", bad, error));
    CHECK(error.find("schema") != std::string::npos);
    CHECK(!frsim::parse_fleet_spec(R"({"schema":"fractonica/fleet-spec@1","seed":1,"nodes":[{"alias":"a","mac":"02f200000001","addr":1}]})",
                                   bad, error));
    CHECK(error.find("state_dir") != std::string::npos);
    frsim::FleetSpec twice;
    CHECK(!frsim::parse_fleet_spec(
        R"({"schema":"fractonica/fleet-spec@1","seed":1,"state_dir":"/x","nodes":[{"alias":"a","mac":"02f200000001","addr":1},{"alias":"a","mac":"02f200000002","addr":2}]})",
        twice, error));
    CHECK(error.find("repeats") != std::string::npos);
}

TEST(sim_node_spec_file_parses_a_gateway_role)
{
    const auto spec = [](std::string_view node) {
        return std::string(R"({"schema":"fractonica/fleet-spec@1","seed":1,"state_dir":"/x","nodes":[)") + std::string(node) + "]}";
    };
    frsim::FleetSpec s;
    std::string error;
    REQUIRE(frsim::parse_fleet_spec(spec(R"({"alias":"gw","mac":"02f200000001","addr":1,"role":"gateway","usb":true},
                                         {"alias":"a","mac":"02f200000002","addr":2})"),
                                    s, error));
    REQUIRE_EQ(s.nodes.size(), 2u);
    CHECK(s.nodes[0].role == fr::proto::Role::gateway);
    CHECK(s.nodes[1].role == fr::proto::Role::node);  // the default
    frsim::FleetSpec bad;
    CHECK(!frsim::parse_fleet_spec(spec(R"({"alias":"gw","mac":"02f200000001","addr":1,"role":"gateway"})"), bad, error));
    CHECK(error.find("usb") != std::string::npos);
    frsim::FleetSpec other;
    CHECK(!frsim::parse_fleet_spec(spec(R"({"alias":"gw","mac":"02f200000001","addr":1,"role":"relay","usb":true})"), other, error));
    CHECK(error.find("role") != std::string::npos);
}

TEST(sim_node_gateway_runs_a_bridge_behind_stats_gw)
{
    FleetRig r(2, false, "c6-pad", 1);
    frsim::FleetNode &gw = r.node(1);
    frsim::FleetNode &pad = r.node(2);
    gw.power_on();
    pad.power_on();
    r.run_ms(2000);
    const std::string on = frt::answer_text(gw.command("diag stats gw"));
    CHECK(on.find(R"("gw":{"on":true,"tx":0,)") != std::string::npos);
    CHECK(on.find(R"("pings":0)") != std::string::npos);  // no hub here: no LINK_PING
    CHECK(frt::answer_text(pad.command("diag stats gw")).find(R"("gw":{"on":false})") != std::string::npos);
    // A full `stats` has gw on the gateway only, as fr_diag does (there it is the last section, so the first one
    // left out when the answer does not fit, and named in `omitted`).
    const std::string full = frt::answer_text(gw.command("diag stats"));
    CHECK(full.find(R"("gw":{"on":true)") != std::string::npos || full.find(R"("gw"])") != std::string::npos);
    const std::string pad_full = frt::answer_text(pad.command("diag stats"));
    CHECK(pad_full.find(R"("gw":)") == std::string::npos && pad_full.find(R"("gw"])") == std::string::npos);
    // Its HELLO says gateway; it never opens a TCP session.
    CHECK(!gw.tcp_session());
}

TEST(sim_node_power_cycle_bumps_the_epoch_and_keeps_its_blobs)
{
    FleetRig r(1);
    frsim::FleetNode &n = r.node(1);
    n.power_on();
    r.run_ms(500);
    CHECK(n.powered());
    CHECK_EQ(n.spec().epoch, 1);
    const std::string hex = binding_hex();
    CHECK(n.command("bind " + hex).ok);
    r.run_ms(500);  // the store's write runs on the node's strand
    const std::string before = frt::answer_text(n.command("bindings"));
    CHECK(before.find(hex) != std::string::npos);

    CHECK(n.command("power off").ok);
    CHECK(!n.powered());
    const frsim::FleetNode::Answer off = n.command("state");
    CHECK(!off.ok);
    CHECK(off.fields.find("powered off") != std::string::npos);
    r.run_ms(2000);  // nothing of the old boot runs meanwhile (ASan would see it)
    CHECK(n.command("power on").ok);
    r.run_ms(500);
    CHECK_EQ(n.spec().epoch, 2);  // fr_boot: every boot a new epoch, from the state directory
    CHECK_EQ(n.boots(), 2u);
    const std::string after = frt::answer_text(n.command("bindings"));
    CHECK(after.find(hex) != std::string::npos);  // nvs:fr_bind kept
    // A started line per boot, with its epoch.
    size_t started = 0;
    for (const std::string &l : r.events.lines()) {
        started += l.find(R"("ev":"started")") != std::string::npos ? 1 : 0;
    }
    CHECK_EQ(started, 2u);
}

TEST(sim_node_power_cut_drops_a_delivery_in_flight)
{
    FleetRig r(2);
    r.node(1).power_on();
    r.node(2).power_on();
    r.run_ms(1000);
    auto msgs = [&r](size_t i, const std::string &topic) {
        const std::string s = frt::answer_text(r.node(i).command("state"));
        const std::string v = member(s, topic);
        return v.empty() ? 0 : std::atoi(v.c_str());
    };
    // A node broadcast over ESP-NOW (no hub here) reaches the other node.
    CHECK(r.node(1).command("msg broadcast t1 hello").ok);
    r.run_ms(500);
    CHECK_EQ(msgs(2, "t1"), 1);

    // The next one has been received by node 2's radio (the medium decides at the frame's end) but not yet handed to
    // its core (the pair's latency, 50-200 µs) when node 2 loses power and comes back: that delivery belongs to the
    // old boot's generation and is dropped, never handed to the new Net.
    bool cut = false;
    r.medium.observe([&](const frsim::OnAir &f) {
        const auto h = fr::wire::unpack_header(f.frame);
        if (!cut && f.tx == r.node(1).air().radio() && h && h->cls == fr::wire::kClsMsg) {
            cut = true;
            r.exec.at(f.end + 10, [&r] {
                r.node(2).power_off();
                r.node(2).power_on();
            });
        }
    });
    CHECK(r.node(1).command("msg broadcast t2 hello").ok);
    r.run_ms(500);
    r.medium.observe(nullptr);
    CHECK(cut);
    CHECK_EQ(msgs(2, "t2"), 0);
    CHECK_EQ(r.node(2).spec().epoch, 2);
    // The rebuilt node hears the air again.
    r.run_ms(200);
    CHECK(r.node(1).command("msg broadcast t3 hello").ok);
    r.run_ms(500);
    CHECK_EQ(msgs(2, "t3"), 1);
}

TEST(sim_node_strand_runs_its_jobs_in_post_order_one_at_a_time)
{
    frsim::Executor exec(frsim::TimeMode::wall);
    frsim::WorkerPool pool(4);
    frsim::Strand s(exec, &pool);
    frsim::Strand other(exec, &pool);
    struct Seen {
        std::mutex mu;
        std::vector<int> order;
        std::atomic<int> running{0};
        std::atomic<int> overlap{0};
    } seen;
    std::atomic<bool> other_ran{false};
    for (int i = 0; i < 8; ++i) {
        Seen *p = &seen;
        CHECK(s.post([p, i] {
            if (p->running.fetch_add(1) != 0) {
                ++p->overlap;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
            {
                const std::lock_guard lock(p->mu);
                p->order.push_back(i);
            }
            p->running.fetch_sub(1);
        }));
    }
    CHECK(!s.post([] {}));  // fr::worker::kQueueDepth (8) queued: refused, as fr_worker's queue
    CHECK(other.post([&] { other_ran = true; }));  // another node's strand is not held up behind it
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!s.idle() && std::chrono::steady_clock::now() < end) {
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    CHECK(s.idle());
    CHECK(other_ran.load());
    CHECK((seen.order == std::vector<int>{0, 1, 2, 3, 4, 5, 6, 7}));
    CHECK_EQ(seen.overlap.load(), 0);
    CHECK_EQ(s.stats().run, 8u);
    CHECK_EQ(s.stats().refused, 1u);
}

TEST(sim_node_power_cut_returns_a_blocked_get_at_once)
{
    // A hub's node HTTP port that answers the GET's head, sends a little of the body and then stalls.
    const int lfd = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t len = sizeof(a);
    REQUIRE(::bind(lfd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0);
    ::listen(lfd, 4);
    ::getsockname(lfd, reinterpret_cast<sockaddr *>(&a), &len);
    const uint16_t port = ntohs(a.sin_port);
    std::atomic<bool> stop{false};
    std::thread server([lfd, &stop] {
        const int c = ::accept(lfd, nullptr, nullptr);
        char req[1024];
        static_cast<void>(::recv(c, req, sizeof(req), 0));
        const std::string head = "HTTP/1.1 200 OK\r\nContent-Length: 500000\r\nConnection: close\r\n\r\n";
        static_cast<void>(::send(c, head.data(), head.size(), 0));
        static_cast<void>(::send(c, std::string(1000, 'x').data(), 1000, 0));
        while (!stop.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        ::close(c);
    });

    frsim::Executor exec(frsim::TimeMode::wall);
    frsim::WorkerPool pool(2);
    frsim::Strand strand(exec, &pool);
    KeepOut out;
    auto fetch = std::make_unique<ota_fake::HttpFetch>(out, true);
    struct Job {
        ota_fake::HttpFetch *f;
        std::string url;
        std::atomic<bool> reading{false};
        std::atomic<bool> returned{false};
        std::atomic<bool> read_failed{false};
    } job{.f = fetch.get(), .url = "http://127.0.0.1:" + std::to_string(port) + "/ota/x.bin"};
    std::atomic<bool> &reading = job.reading;
    std::atomic<bool> &returned = job.returned;
    std::atomic<bool> &read_failed = job.read_failed;
    std::atomic<int> later{0};
    ota_fake::HttpFetch *f = fetch.get();
    Job *jp = &job;
    CHECK(strand.post([jp] {
        if (jp->f->start(jp->url.c_str(), 0)) {
            uint8_t buf[4096];
            jp->reading = true;
            for (;;) {
                auto n = jp->f->read(buf);  // the 1000 bytes, then blocked: the server stalls
                if (!n || *n == 0) {
                    jp->read_failed = !n;
                    break;
                }
            }
        }
        jp->returned = true;
    }));
    for (int i = 0; i < 3; ++i) {
        CHECK(strand.post([&later] { ++later; }));  // queued behind it: a power cut drops them
    }
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!reading.load() && std::chrono::steady_clock::now() < until) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    REQUIRE(reading.load());
    std::this_thread::sleep_for(std::chrono::milliseconds(50));  // blocked in the read by now
    CHECK(!returned.load());

    // The power cut (FleetNode::power_off's order): the GET shut down, then the strand quiesced.
    const auto t0 = std::chrono::steady_clock::now();
    f->abort();
    strand.quiesce();
    const auto took = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    CHECK(returned.load());
    CHECK(read_failed.load());
    CHECK(took < 1000);  // not HttpGet's 5 s read timeout
    CHECK_EQ(later.load(), 0);
    // A job posted by the dead node afterwards (Ota::step re-posting itself) is taken and never run.
    CHECK(strand.post([&later] { ++later; }));
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    CHECK_EQ(later.load(), 0);
    CHECK_EQ(strand.stats().dropped, 4u);
    fetch.reset();  // the boot goes: nothing still uses it (ASan would see it)
    // The next boot's jobs run again.
    strand.resume();
    std::atomic<bool> ran{false};
    CHECK(strand.post([&ran] { ran = true; }));
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (!ran.load() && std::chrono::steady_clock::now() < end) {
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    CHECK(ran.load());
    stop = true;
    server.join();
    ::close(lfd);
}

namespace {

/** A loopback listener nobody accepts on: a node's TCP connects to it (the attempt is what a test counts). */
struct Listener {
    Listener()
    {
        fd = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t len = sizeof(a);
        ok = ::bind(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0 && ::listen(fd, 16) == 0 &&
             ::getsockname(fd, reinterpret_cast<sockaddr *>(&a), &len) == 0;
        port = ntohs(a.sin_port);
    }
    ~Listener() { ::close(fd); }
    int fd = -1;
    bool ok = false;
    uint16_t port = 0;
};

/** A diag answer's member (`diag stats espnow` -> the espnow object's `tx_fail`), as a number. */
long diag_number(frsim::FleetNode &n, const std::string &line, const std::string &key)
{
    const std::string v = member(frt::answer_text(n.command("diag " + line)), key);
    return v.empty() ? -1 : std::atol(v.c_str());
}

/** fr.node.reboot (port 0, kind 3) on node 2, fired by node 1's boot button: a BYE reboot without a hub. */
std::string reboot_binding_hex()
{
    static const std::vector<uint8_t> kMac{0x02, 0xf2, 0x00, 0x00, 0x00, 0x02};
    const fr::proto::Binding b{.slot = 4,
                               .on_port = 1,
                               .on_cls = fr::wire::kClsEvent,
                               .on_kind = fr::cap::Button::kEventDown,
                               .to_mac = kMac,
                               .to_addr = 2,
                               .to_port = 0,
                               .to_cls = fr::wire::kClsCmd,
                               .to_kind = fr::cap::Node::kCmdReboot,
                               .payload = {},
                               .reliable = true};
    return frsim::hex(frt::HubSim::body_of(b));
}

}  // namespace

TEST(sim_node_a_unicast_to_a_powered_off_node_fails_over_esp_now)
{
    // Review fleet-3: node 3 powered off keeps its radio on the medium (D8) but ACKs nothing, so node 1's unicast to it
    // fails after the driver's retries; Net counts no ESP-NOW delivery and routes it another way (here, with no hub,
    // a flooded unicast). Before, the medium ACKed for the dead radio: via_espnow + 1, tx_fail 0.
    FleetRig r(3);
    for (size_t i = 1; i <= 3; ++i) {
        r.node(i).power_on();
    }
    r.run_ms(12'000);  // heartbeats: node 1 knows node 3 as a neighbour
    const long rx3 = static_cast<long>(r.medium.stats().radios[r.node(3).air().radio()].rx);
    CHECK(r.node(3).command("power off").ok);
    const long fail0 = diag_number(r.node(1), "stats espnow", "tx_fail");
    REQUIRE(fail0 >= 0);
    CHECK(r.node(1).command("msg 3 rv-off hello").ok);
    r.run_ms(2'000);
    CHECK(diag_number(r.node(1), "stats espnow", "tx_fail") > fail0);
    CHECK_EQ(diag_number(r.node(1), "stats nodes", "via_espnow"), 0);
    CHECK_EQ(static_cast<long>(r.medium.stats().radios[r.node(3).air().radio()].rx), rx3);  // nothing decoded there
}

TEST(sim_node_power_on_is_a_fresh_boot_for_tcp_holds_and_wifi_hooks)
{
    // Review fleet-1: Net's TCP hold (drop_hub_link, ip_block), `wifi_down` and `tcp 0` are RAM on a board, gone at the
    // reset. A node power-cycled while one is armed tries TCP again right after power-on, instead of staying off IP
    // until the old hook's timer (or forever: the rebuilt Net never releases a hold it did not take).
    const Listener hub;
    REQUIRE(hub.ok);
    for (const std::string hook : {"diag net drop_hub_link 60", "diag net ip_block 60", "wifi_down 60", "tcp 0"}) {
        FleetRig r(1);
        frsim::FleetNode &n = r.node(1);
        n.set_hub("127.0.0.1", hub.port, 0, 0);
        n.power_on();
        r.run_ms(100);
        REQUIRE(n.tcp().fd() >= 0);  // connecting (virtual time: the connect never completes)
        CHECK(n.command(hook).ok);
        r.run_ms(500);  // a deferred hook (wifi_down over diag) is applied by now
        if (hook.starts_with("diag net")) {
            CHECK(n.tcp().held());
        } else {
            CHECK(!n.tcp().ip());  // Wi-Fi or TCP off: silent, nothing tried
            CHECK_EQ(n.tcp().fd(), -1);
        }
        CHECK(n.command("power off").ok);
        r.run_ms(1'000);
        CHECK(n.command("power on").ok);
        r.run_ms(50);
        CHECK(!n.tcp().held());
        CHECK(n.tcp().ip());
        CHECK(n.tcp().fd() >= 0);  // trying again at once, as after any power-on
    }
}

TEST(sim_node_power_off_in_the_reboot_gap_keeps_the_node_off)
{
    // Review fleet-2: a BYE reboot powers the node off and on 300 ms later; an explicit `power off` in that gap wins,
    // as pulling a board's plug does: the node stays off (still answered already:true, it was off), and `power on`
    // brings it back.
    FleetRig r(2);
    r.node(1).power_on();
    r.node(2).power_on();
    r.run_ms(12'000);  // node 1 knows node 2 (heartbeats)
    CHECK(r.node(1).command("bind " + reboot_binding_hex()).ok);
    r.run_ms(500);
    const uint32_t boots = r.node(2).boots();
    CHECK(r.node(1).command("inject press").ok);
    // Node 2's fr.node.reboot: BYE, the restart ~200 ms later at its 250 ms tick, then power-on 300 ms after that.
    bool gap = false;
    for (int i = 0; i < 400 && !gap; ++i) {
        r.run_ms(5);
        gap = !r.node(2).powered();
    }
    REQUIRE(gap);
    const frsim::FleetNode::Answer off = r.node(2).command("power off");
    CHECK(off.ok);
    CHECK(off.fields.find(R"("already":true)") != std::string::npos);
    r.run_ms(1'500);
    CHECK(!r.node(2).powered());
    CHECK_EQ(r.node(2).boots(), boots);
    CHECK(r.node(2).command("power on").ok);
    r.run_ms(100);
    CHECK(r.node(2).powered());
    CHECK_EQ(r.node(2).boots(), boots + 1);
    // Control: a reboot without a power off in its gap comes back by itself.
    CHECK(r.node(1).command("inject release").ok);
    r.run_ms(12'000);
    const uint32_t before = r.node(2).boots();
    CHECK(r.node(1).command("inject press").ok);
    r.run_ms(2'000);
    CHECK(r.node(2).powered());
    CHECK_EQ(r.node(2).boots(), before + 1);
}

TEST(sim_node_net_wifi_down_is_applied_300_ms_after_its_result)
{
    // Review fleet-5: as fr_net's WifiSta (kApplyDelayUs), `net wifi_down` over fr.diag switches Wi-Fi off 300 ms after
    // its RESULT, so that RESULT leaves over TCP first; a power cut in between drops it with the boot. The stdin
    // `wifi_down` stays immediate. The deferral costs the boot one core timer of its 28.
    FleetRig r(1);
    frsim::FleetNode &n = r.node(1);
    n.power_on();
    r.run_ms(200);
    REQUIRE(n.tcp().ip());
    const frsim::FleetNode::Answer a = n.command("diag net wifi_down 4");
    CHECK(a.fields.find(R"("hook":"wifi_down")") != std::string::npos);
    r.run_ms(250);
    CHECK(n.tcp().ip());  // not yet
    r.run_ms(100);
    CHECK(!n.tcp().ip());
    const uint32_t timers = n.core().stats().timers;
    std::printf("    [measured] a fleet node's core timers after a net wifi_down: %u of %zu\n", timers, frsim::SimCore::kTimers);
    CHECK(timers + 4 <= frsim::SimCore::kTimers);  // headroom left
    r.run_ms(4'000);
    // Wi-Fi back after 4 s (association first).
    for (int i = 0; i < 40 && !n.tcp().ip(); ++i) {
        r.run_ms(100);
    }
    CHECK(n.tcp().ip());
    // A power cut inside the 300 ms: the switch goes with the boot.
    CHECK(n.command("diag net wifi_down 30").ok);
    r.run_ms(100);
    CHECK(n.command("power off").ok);
    CHECK(n.command("power on").ok);
    r.run_ms(1'000);
    CHECK(n.tcp().ip());
    // stdin: at once.
    CHECK(n.command("wifi_down 30").ok);
    CHECK(!n.tcp().ip());
}
