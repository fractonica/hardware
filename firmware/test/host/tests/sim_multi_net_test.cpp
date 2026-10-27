// N Nets in one process (design m2-c2 D1): fr_fleet hosts every node's Net on one thread, which is safe only while
// Net keeps all its state in members. Two Nets with different identities run a script of hub frames, air frames and
// their own timers, first each alone, then both on one executor with their events interleaved: each must send
// exactly what it sent alone, byte for byte and at the same times. A future function-local static (a shared counter,
// a cached buffer) fails here loudly instead of skewing a 30-node gate.
#include <memory>
#include <string>
#include <vector>

#include "sim/executor.hpp"
#include "sim/sim_core.hpp"
#include "tests/net_air_fakes.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::net::LinkKind;
using frsim::Executor;
using frsim::SimCore;

/** One node: Net on a SimCore with FakeLinks, ScriptAir and stores; what it sent is the comparison. */
struct Box {
    Box(Executor &exec, uint16_t addr, uint32_t rng_seed)
        : core(exec, "sim-" + std::to_string(addr)), serial(LinkKind::serial, core), tcp(LinkKind::tcp, core),
          udp(LinkKind::udp, core), air(core), net(core, host, config(rng_seed)), hub(addr, host.id.net)
    {
        host.id.addr = addr;
        host.hello.mac = {0x02, 0xf2, 0x00, 0x00, 0x00, static_cast<uint8_t>(addr)};
        host.id.epoch = static_cast<uint16_t>(addr + 3);
        hub.node = addr;
        net.attach(serial);
        net.attach(tcp);
        net.attach(udp);
        net.attach_stores(&stores, &stores);
        net.attach_air(air);
    }

    static fr::net::Config config(uint32_t rng_seed)
    {
        fr::net::Config c;
        c.rng_seed = rng_seed;
        return c;
    }

    /** Everything this node put on a link or the air, with its time: the trace two runs must share. */
    std::string trace() const
    {
        std::string out;
        for (const frt::Sent &s : tcp.sent) {
            out += "tcp@" + std::to_string(s.at) + " " + frt::hex(s.bytes) + "\n";
        }
        for (const frt::Sent &s : udp.sent) {
            out += "udp@" + std::to_string(s.at) + " " + frt::hex(s.bytes) + "\n";
        }
        for (const frt::AirTx &t : air.sent) {
            out += "air@" + std::to_string(t.at) + " " + frt::hex(t.bytes) + "\n";
        }
        out += "calls " + std::to_string(host.calls.size()) + "\n";
        const fr::net::State s = net.state();
        out += "relay " + std::to_string(s.relay.seeded) + "/" + std::to_string(s.relay.relayed) + "/" +
               std::to_string(s.relay.cancelled) + " bcast " + std::to_string(s.bcast.delivered) + "/" +
               std::to_string(s.bcast.dup) + " nodes " + std::to_string(s.nodes.delivered) + "\n";
        return out;
    }

    SimCore core;
    frt::FakeHost host;
    frt::FakeLink serial;
    frt::FakeLink tcp;
    frt::FakeLink udp;
    frt::ScriptAir air;
    frt::MemStores stores;
    fr::net::Net net;
    frt::HubSim hub;
    frt::Peer peer;
    size_t completed = 0;
};

/** The script, `skew` µs after the base times: a session, CMDs, hub broadcasts seeded over the air, a neighbour's
 * broadcasts relayed, the driver's completions, and the Net's own heartbeats and relay timers in between. */
void script(Executor &exec, Box &b, TimeUs skew)
{
    const TimeUs t0 = 1'100'000 + skew;
    exec.at(t0, [&b] {
        b.tcp.is_up = true;
        b.udp.is_up = true;
        b.net.link_changed(LinkKind::tcp);
        b.net.link_changed(LinkKind::udp);
    });
    exec.at(t0 + 100'000, [&b] {
        b.net.receive(LinkKind::tcp, b.hub.welcome(0, 50));
        for (const frt::Frame &f : b.tcp.frames_of(fr::wire::kClsEvent)) {
            if ((f.flags & fr::wire::kFlagAckReq) != 0) {
                b.net.receive(LinkKind::tcp, b.hub.ack(b.host.id.epoch, f.seq));
            }
        }
    });
    for (int k = 0; k < 40; ++k) {
        exec.at(t0 + 200'000 + k * 37'000, [&b, k] {
            const std::vector<uint8_t> args{static_cast<uint8_t>(k)};
            b.net.receive(LinkKind::tcp, b.hub.cmd(2, 7, args));
        });
    }
    for (int k = 0; k < 20; ++k) {
        exec.at(t0 + 250'000 + k * 100'000, [&b, k] {
            b.net.receive(LinkKind::tcp, frt::hub_broadcast(b.hub, "t", frt::bytes_of(std::to_string(k))));
        });
        exec.at(t0 + 260'000 + k * 100'000, [&b, k] {
            b.net.receive_air(b.peer.msg(fr::proto::kAddrBroadcast, "n", frt::bytes_of(std::to_string(k))), b.peer.meta(true, -70));
        });
    }
    // The driver: every send done 1.5 ms after it, through the whole run.
    for (int k = 0; k < 3000; ++k) {
        exec.at(t0 + k * 1'500, [&b] {
            for (; b.completed < b.air.sent.size(); ++b.completed) {
                b.net.air_sent(b.air.sent[b.completed].token, true);
            }
        });
    }
}

constexpr TimeUs kEnd = 6'000'000;

std::string solo(uint16_t addr, uint32_t seed, TimeUs skew)
{
    Executor exec(frsim::TimeMode::virtual_time);
    Box b(exec, addr, seed);
    script(exec, b, skew);
    exec.run_until(kEnd);
    return b.trace();
}

}  // namespace

TEST(sim_multi_net_two_nets_interleaved_equal_their_solo_runs)
{
    const std::string a_alone = solo(0x21, 0xA11CE, 0);
    const std::string b_alone = solo(0x22, 0xB0B, 7);
    CHECK(a_alone.find("air@") != std::string::npos);  // the script made it seed, relay and answer
    CHECK(a_alone.find("calls 40") != std::string::npos);
    CHECK(a_alone.find("relay 20/20/0 bcast 20/0 nodes 20") != std::string::npos);
    CHECK(a_alone.size() > 5'000u);  // dozens of frames on TCP, UDP and the air
    CHECK(a_alone != b_alone);

    Executor exec(frsim::TimeMode::virtual_time);
    auto a = std::make_unique<Box>(exec, 0x21, 0xA11CE);
    auto b = std::make_unique<Box>(exec, 0x22, 0xB0B);
    script(exec, *a, 0);
    script(exec, *b, 7);
    exec.run_until(kEnd);
    CHECK_EQ(a->trace(), a_alone);
    CHECK_EQ(b->trace(), b_alone);
}
