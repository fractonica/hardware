// Spike S2's hooks (design m2-c4-gateway D19) below the radio: the driver's per-frame rate, `air rate`, a send's end
// (link retries, queue wait), the no-peer refusal and `air churn` in air::Scheduler; `air bench` between two Nets on the
// host air model (counts, gaps, dups, echo RTT, broadcast runs) and `net stream`; and the kit's `diag air ...`, `net
// stream` and the unsupported ones on fleet nodes (SimAir).
#include <functional>
#include <string>
#include <vector>

#include "../../../components/fr_net/src/esp/air_sched.hpp"
#include "fr/net/us_histogram.hpp"
#include "sim/node.hpp"
#include "tests/net_air_fakes.hpp"
#include "tests/net_air_medium.hpp"
#include "tests/net_fakes.hpp"
#include "tests/sim_node_rig.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::net::AirPrio;
using fr::net::AirRate;
using fr::net::Mac;
using fr::net::air::Scheduler;

class RateRadio final : public fr::net::air::Radio
{
public:
    struct SetRate {
        Mac mac;
        AirRate rate;
    };
    bool add_peer(const Mac &) override
    {
        clock += add_cost;
        return add_ok;
    }
    void del_peer(const Mac &) override { clock += del_cost; }
    bool transmit(const Mac &dst, std::span<const uint8_t>) override
    {
        tx.push_back(dst);
        return true;
    }
    void arm(uint32_t) override {}
    void disarm() override {}
    void done(uint32_t token, bool ok) override { ends.push_back({token, ok}); }
    bool set_rate(const Mac &mac, AirRate rate) override
    {
        rates.push_back({mac, rate});
        return rate_ok;
    }
    struct End {
        uint32_t token;
        bool ok;
    };
    std::vector<Mac> tx;
    std::vector<End> ends;
    std::vector<SetRate> rates;
    bool add_ok = true;
    bool rate_ok = true;
    TimeUs clock = 0;
    TimeUs add_cost = 120;
    TimeUs del_cost = 40;
};

Mac peer_mac(uint8_t last)
{
    return {0x24, 0x0a, 0xc4, 0x00, 0x00, last};
}

const std::vector<uint8_t> kFrame(30, 0xA1);

}  // namespace

TEST(us_histogram_percentiles_within_a_sixteenth)
{
    fr::net::UsHistogram h;
    CHECK_EQ(h.percentile(500), 0u);
    for (uint32_t v = 1; v <= 1000; ++v) {
        h.add(v * 100);  // 100 µs .. 100 ms
    }
    CHECK_EQ(h.count(), 1000u);
    CHECK_EQ(h.max(), 100'000u);
    const uint32_t p50 = h.percentile(500);
    const uint32_t p99 = h.percentile(990);
    CHECK(p50 >= 50'000 && p50 <= 50'000 + 50'000 / 16 + 1);
    CHECK(p99 >= 99'000 && p99 <= 100'000);
    h.add(5'000'000);  // beyond the top bin: the max stays exact
    CHECK_EQ(h.max(), 5'000'000u);
    CHECK_EQ(h.percentile(1000), 5'000'000u);
}

TEST(air_sched_frame_rate_is_set_on_its_peer_and_put_back)
{
    RateRadio radio;
    Scheduler s(radio);
    TimeUs now = 1'000'000;
    REQUIRE(s.send(peer_mac(1), kFrame, AirPrio::normal, 1, now, AirRate::fast).has_value());
    REQUIRE_EQ(radio.rates.size(), 1u);
    CHECK(radio.rates[0].mac == peer_mac(1));
    CHECK(radio.rates[0].rate == AirRate::fast);
    s.sent(true, now += 1000);
    // The next frame to that peer has none of its own: the peer gets its default back.
    REQUIRE(s.send(peer_mac(1), kFrame, AirPrio::normal, 2, now).has_value());
    REQUIRE_EQ(radio.rates.size(), 2u);
    CHECK(radio.rates[1].rate == AirRate::peer_default);
    s.sent(true, now += 1000);
    // Default rates: no set_rate at all while every frame is the peer's default (router mode is unchanged).
    REQUIRE(s.send(peer_mac(1), kFrame, AirPrio::normal, 3, now).has_value());
    s.sent(true, now += 1000);
    REQUIRE(s.send(fr::net::kBroadcastMac, kFrame, AirPrio::normal, 4, now).has_value());
    s.sent(true, now += 1000);
    CHECK_EQ(radio.rates.size(), 2u);
    CHECK_EQ(s.stats().rate_fail, 0u);
}

TEST(air_sched_air_rate_sets_every_peer_and_later_ones)
{
    RateRadio radio;
    Scheduler s(radio);
    TimeUs now = 1'000'000;
    for (uint8_t i = 1; i <= 3; ++i) {
        REQUIRE(s.send(peer_mac(i), kFrame, AirPrio::normal, i, now).has_value());
        s.sent(true, now += 1000);
    }
    CHECK(radio.rates.empty());
    radio.rate_ok = false;
    const fr::net::air::RateChange r = s.set_default_rate(false, AirRate::fast);
    CHECK_EQ(r.peers, 3u);
    CHECK_EQ(r.failed, 3u);
    CHECK_EQ(s.stats().rate_fail, 3u);
    radio.rate_ok = true;
    radio.rates.clear();
    // A new peer gets it at its first frame; a known peer whose set_rate the driver refused is asked again at its next
    // frame (it never got the rate), and then keeps it.
    REQUIRE(s.send(peer_mac(9), kFrame, AirPrio::normal, 9, now).has_value());
    s.sent(true, now += 1000);
    REQUIRE(s.send(peer_mac(1), kFrame, AirPrio::normal, 10, now).has_value());
    s.sent(true, now += 1000);
    REQUIRE(s.send(peer_mac(1), kFrame, AirPrio::normal, 11, now).has_value());
    s.sent(true, now += 1000);
    REQUIRE_EQ(radio.rates.size(), 2u);
    CHECK(radio.rates[0].mac == peer_mac(9));
    CHECK(radio.rates[0].rate == AirRate::fast);
    CHECK(radio.rates[1].mac == peer_mac(1));
    CHECK(radio.rates[1].rate == AirRate::fast);
    // The broadcast peer apart.
    const fr::net::air::RateChange b = s.set_default_rate(true, AirRate::fast);
    CHECK_EQ(b.peers, 1u);
    CHECK(radio.rates.back().mac == fr::net::kBroadcastMac);
    CHECK(s.default_rate(true) == AirRate::fast);
}

TEST(air_sched_last_done_tells_retries_and_queue_wait)
{
    RateRadio radio;
    Scheduler s(radio);
    TimeUs now = 1'000'000;
    REQUIRE(s.send(peer_mac(1), kFrame, AirPrio::normal, 11, now).has_value());
    REQUIRE(s.send(peer_mac(2), kFrame, AirPrio::normal, 12, now).has_value());  // waits behind 11
    fr::net::AirDone d11{};
    fr::net::AirDone d12{};
    radio.ends.clear();
    s.sent(false, now += 3000);   // 11 fails once
    s.timer(now += 2000);         // the 2 ms link retry
    s.sent(true, now += 1000);    // 11 ok after one retry
    d11 = s.last_done(11);
    s.sent(true, now += 1500);    // 12, started when 11 ended
    d12 = s.last_done(12);
    CHECK_EQ(d11.retries, 1u);
    CHECK_EQ(d11.queued_us, 0u);
    CHECK_EQ(d12.retries, 0u);
    CHECK_EQ(d12.queued_us, 6000u);
    CHECK_EQ(s.last_done(11).retries, 0u);  // only the last end is known
}

TEST(air_sched_tells_a_no_peer_refusal_from_a_full_queue)
{
    RateRadio radio;
    Scheduler s(radio);
    TimeUs now = 1'000'000;
    for (uint8_t i = 1; i <= fr::net::air::kUnicastPeers; ++i) {
        REQUIRE(s.send(peer_mac(i), kFrame, AirPrio::urgent, i, now).has_value());
        CHECK(!s.refused_no_peer());
        s.sent(true, now += 100);
    }
    // Every peer used within the last second: busy, for want of a peer slot.
    CHECK(s.send(peer_mac(99), kFrame, AirPrio::urgent, 99, now).error() == fr::Err::busy);
    CHECK(s.refused_no_peer());
    // A full queue to a known peer: busy, not for a peer.
    for (uint32_t i = 0; i < fr::net::air::kQueueFrames; ++i) {
        REQUIRE(s.send(peer_mac(1), kFrame, AirPrio::urgent, 200 + i, now).has_value());
    }
    CHECK(s.send(peer_mac(1), kFrame, AirPrio::urgent, 100, now).error() == fr::Err::busy);
    CHECK(!s.refused_no_peer());
}

TEST(air_churn_times_each_add_and_del)
{
    RateRadio radio;
    fr::net::air::ChurnStats st;
    fr::net::air::churn(radio, 100, [&radio] { return radio.clock; }, st);
    CHECK_EQ(st.n, 100u);
    CHECK_EQ(st.failed, 0u);
    CHECK_EQ(st.add.count(), 100u);
    CHECK_EQ(st.add.percentile(500), 120u);
    CHECK_EQ(st.del.max(), 40u);
    radio.add_ok = false;
    fr::net::air::churn(radio, 5, [&radio] { return radio.clock; }, st);
    CHECK_EQ(st.failed, 5u);
    CHECK_EQ(st.del.count(), 0u);
}

// ---- air bench between two Nets ----

namespace {

struct BenchPair {
    explicit BenchPair(double loss = 0.0) : medium(core, {.loss = loss, .seed = 7}), a(core, medium, 0x21, 1), b(core, medium, 0x22, 2)
    {
        core.run_ready();
    }
    void run_ms(uint32_t ms) { core.advance_ms(ms); }

    frt::FakeCore core;
    frt::AirMedium medium;
    frt::SimNode a;
    frt::SimNode b;
};

}  // namespace

TEST(net_bench_unicast_with_echo_counts_both_ends)
{
    BenchPair p;
    REQUIRE(p.a.net.bench_tx(p.b.radio.mac, 200, 100, 0, true).has_value());
    CHECK(p.a.net.bench_report().tx.running);
    p.run_ms(2000);
    const fr::net::BenchReport ra = p.a.net.bench_report();
    CHECK(!ra.tx.running);
    CHECK_EQ(ra.tx.sent, 200u);
    CHECK_EQ(ra.tx.acked, 200u);
    CHECK_EQ(ra.tx.failed, 0u);
    CHECK_EQ(ra.tx.echoes, 200u);
    CHECK(ra.tx.rtt_p50_us >= 2 * (900 + 8 * 100));  // two frames of airtime at least
    CHECK(ra.tx.rtt_max_us >= ra.tx.rtt_p99_us && ra.tx.rtt_p99_us >= ra.tx.rtt_p50_us);
    CHECK(ra.tx.elapsed_ms > 0);
    const fr::net::BenchReport rb = p.b.net.bench_report();
    REQUIRE_EQ(rb.rx_count, 1u);
    CHECK(rb.rx[0].mac == p.a.radio.mac);
    CHECK_EQ(rb.rx[0].addr, 0x21u);
    CHECK_EQ(rb.rx[0].received, 200u);
    CHECK_EQ(rb.rx[0].gaps, 0u);
    CHECK_EQ(rb.rx[0].dups, 0u);
    CHECK_EQ(rb.rx[0].echoed, 200u);
    CHECK_EQ(rb.rx[0].rssi_p50, -55);
    // Every frame was `len` bytes on the air (the pad fills it), TTL 1, and nothing was relayed or delivered.
    for (const frt::AirMedium::Transmission &t : p.medium.log) {
        if (t.from == p.a.radio.mac && t.bytes[2] == fr::wire::kClsNet) {
            CHECK(t.bytes.size() >= 98 && t.bytes.size() <= 100);
            CHECK_EQ(t.bytes[16], 0x11);
        }
    }
    CHECK_EQ(p.b.net.state().relay.relayed, 0u);
    CHECK_EQ(p.b.net.state().nodes.dup, 0u);  // outside the node windows
    // reset: every count goes.
    p.b.net.bench_reset();
    CHECK_EQ(p.b.net.bench_report().rx_count, 0u);
}

TEST(net_bench_loss_shows_as_gaps_and_failed_verdicts)
{
    BenchPair p(0.3);
    REQUIRE(p.a.net.bench_tx(p.b.radio.mac, 300, 64, 5, false).has_value());
    p.run_ms(3000);
    const fr::net::BenchTx tx = p.a.net.bench_report().tx;
    CHECK(!tx.running);
    CHECK_EQ(tx.sent + tx.refused, 300u);  // paced: a frame the driver's queue had no room for is skipped
    CHECK_EQ(tx.acked + tx.failed, tx.sent);
    CHECK(tx.failed > 0);
    CHECK_EQ(tx.echoes, 0u);
    const fr::net::BenchRx rx = p.b.net.bench_report().rx[0];
    // The link retries bring copies the receiver already had (its MAC ACK lost): dups; frames lost on every try: gaps.
    CHECK(rx.received + rx.gaps >= 280);  // the last seqs lost leave no gap behind them
    CHECK(rx.received <= tx.sent);
    CHECK(rx.dups > 0);
    CHECK_EQ(p.b.net.bench_report().rx[0].echoed, 0u);
}

TEST(net_bench_broadcast_paced_with_echoes_from_any_node)
{
    BenchPair p;
    REQUIRE(p.a.net.bench_tx(fr::net::kBroadcastMac, 20, 40, 10, true).has_value());
    p.run_ms(150);
    CHECK(p.a.net.bench_report().tx.running);
    CHECK(p.a.net.bench_report().tx.sent >= 14 && p.a.net.bench_report().tx.sent <= 16);
    p.run_ms(200);
    const fr::net::BenchTx tx = p.a.net.bench_report().tx;
    CHECK(tx.broadcast);
    CHECK_EQ(tx.sent, 20u);
    CHECK_EQ(tx.acked, 20u);
    CHECK_EQ(tx.echoes, 20u);
    CHECK_EQ(p.b.net.bench_report().rx[0].received, 20u);
}

TEST(net_bench_limits)
{
    BenchPair p;
    CHECK(p.a.net.bench_tx(p.b.radio.mac, 0, 64, 0, false).error() == fr::Err::invalid_args);
    CHECK(p.a.net.bench_tx(p.b.radio.mac, 1, 31, 0, false).error() == fr::Err::invalid_args);
    CHECK(p.a.net.bench_tx(p.b.radio.mac, 1, fr::net::Net::kBenchLenMax + 1, 0, false).error() == fr::Err::invalid_args);
    p.a.radio.is_up = false;
    p.a.net.link_changed(fr::net::LinkKind::espnow);
    CHECK(p.a.net.bench_tx(p.b.radio.mac, 1, 64, 0, false).error() == fr::Err::failed);
}

TEST(net_stream_reports_state_at_its_rate_on_port_241)
{
    frt::AirRig r;
    r.session(fr::net::LinkKind::tcp);
    r.clear_sent();
    REQUIRE(r.net.stream(50, 1, 12).has_value());
    r.core.advance_ms(1500);
    const auto states = r.tcp.frames(fr::wire::kClsState, fr::net::Net::kStreamProp);
    CHECK_EQ(states.size(), 50u);
    REQUIRE(!states.empty());
    CHECK_EQ(states[0].port, fr::proto::kPortDiag);
    CHECK_EQ(states[0].body.size(), 12u);
    CHECK_EQ(states.back().body[0], 50u);
    CHECK_EQ(r.net.stream_sent(), 50u);
    CHECK(r.net.stream(1001, 1, 8).error() == fr::Err::invalid_args);
    REQUIRE(r.net.stream(10, 60, 8).has_value());
    r.core.advance_ms(500);
    REQUIRE(r.net.stream(0, 0, 8).has_value());  // ends it
    const size_t n = r.tcp.frames(fr::wire::kClsState, fr::net::Net::kStreamProp).size();
    r.core.advance_ms(1000);
    CHECK_EQ(r.tcp.frames(fr::wire::kClsState, fr::net::Net::kStreamProp).size(), n);
}

// ---- the kit's diag hooks (fleet nodes, SimAir) ----

namespace {

std::string run(frsim::FleetNode &n, const std::string &line)
{
    return frt::answer_text(n.command(line));
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

TEST(sim_diag_air_bench_rate_churn_and_stream)
{
    frt::FleetRig r(2);
    r.node(1).power_on();
    r.node(2).power_on();
    r.run_ms(1000);
    frsim::FleetNode &n = r.node(1);
    has(run(n, "diag air bench tx 02:f2:00:00:00:02 50 80 0 echo"),
        R"("response":{"ok":true,"dst":"02f200000002","count":50,"len":80,"interval_ms":0,"echo":true})");
    r.run_ms(1000);
    const std::string tx = run(n, "diag air bench rx");
    has(tx, R"("tx":{"running":false,"dst":"02f200000002","count":50,"len":80,"interval_ms":0,"echo":true,"sent":50,)");
    has(tx, R"("acked":50,"failed":0,"echoes":50,)");
    const std::string rx = run(r.node(2), "diag air bench rx reset");
    has(rx, R"("rx":[{"mac":"02f200000001","addr":1,"received":50,"gaps":0,"dups":0,)");
    has(rx, R"("echoed":50,)");
    has(run(r.node(2), "diag air bench rx"), R"("rx":[]})");
    has(run(n, "diag air bench tx bcast 0 80 0"), R"("error":"invalid_args")");
    // rate: every unicast peer now (node 2 is one), then on the medium at 6 Mbps.
    has(run(n, "diag air rate fast"), R"("response":{"ok":true,"rate":"fast","peer":"unicast","peers":1,"rate_fail":0})");
    has(run(n, "diag air rate robust bcast"), R"("peer":"bcast","peers":1,)");
    has(run(n, "diag air churn 20"), R"("response":{"ok":true,"n":20,"failed":0,"add_us":{"p50":0,"p99":0,"max":0},)");
    // The medium has no TX power, protocols or CPU.
    has(run(n, "diag air txpower 34"), R"("error":"unsupported")");
    has(run(n, "diag wifi proto ax"), R"("error":"unsupported")");
    has(run(n, "diag cpu"), R"("error":"unsupported")");
    has(run(n, "diag net stream 20 1"), R"("response":{"ok":true,"hook":"stream","hz":20,"s":1,"len":8,"port":241,"prop":1})");
    // The gateway link's rows.
    has(run(n, "diag info"), R"("gateway":{"up":false,"session":false,"synced":false})");
    has(run(n, "diag stats gateway"), R"("gateway":{"live":0,"beacons":0,"lost":0,"opened":0,"closed":0,"tx_nak":0,"too_big":0})");
}
