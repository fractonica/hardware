// The ESP-NOW driver's send discipline (design c5 §3, spec 05 §5.3; fr_net/src/esp/air_sched.hpp), which
// espnow.cpp runs on target and fr_net_node's fake air medium on the host: priority queues with one send in
// flight, link retries 2 ms then 4 ms, the send guard and the late verdicts it holds the next send for, the
// 17-peer LRU that never evicts a peer used within a second, and Net sending again from inside a frame's end.
#include <functional>
#include <vector>

#include "../../../components/fr_net/src/esp/air_sched.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::net::AirPrio;
using fr::net::Mac;
using fr::net::air::kSendGuardUs;
using fr::net::air::kSendLostUs;
using fr::net::air::Scheduler;

class FakeRadio final : public fr::net::air::Radio
{
public:
    struct Tx {
        Mac dst;
        std::vector<uint8_t> bytes;
    };

    bool add_peer(const Mac &mac) override
    {
        adds.push_back(mac);
        return add_ok;
    }
    void del_peer(const Mac &mac) override { dels.push_back(mac); }
    bool transmit(const Mac &dst, std::span<const uint8_t> frame) override
    {
        tx.push_back({dst, {frame.begin(), frame.end()}});
        return transmit_ok;
    }
    void arm(uint32_t delay_us) override
    {
        armed.push_back(delay_us);
        timer_on = true;
    }
    void disarm() override { timer_on = false; }
    void done(uint32_t token, bool ok) override
    {
        ends.push_back({token, ok});
        if (on_done) {
            on_done(token, ok);
        }
    }

    struct End {
        uint32_t token;
        bool ok;
    };
    std::vector<Mac> adds;
    std::vector<Mac> dels;
    std::vector<Tx> tx;
    std::vector<uint32_t> armed;
    std::vector<End> ends;
    bool timer_on = false;
    bool add_ok = true;
    bool transmit_ok = true;
    std::function<void(uint32_t, bool)> on_done;
};

Mac mac(uint8_t last)
{
    return {0x24, 0x0a, 0xc4, 0x00, 0x00, last};
}

std::vector<uint8_t> frame(uint8_t tag, size_t len = 20)
{
    std::vector<uint8_t> f(len, tag);
    f[0] = 0xA1;
    return f;
}

}  // namespace

TEST(air_sched_one_send_in_flight_served_by_priority)
{
    FakeRadio r;
    Scheduler s(r);
    CHECK(s.send(fr::net::kBroadcastMac, frame(1), AirPrio::normal, 1, 0));
    CHECK(s.send(fr::net::kBroadcastMac, frame(2), AirPrio::bulk, 2, 0));
    CHECK(s.send(fr::net::kBroadcastMac, frame(3), AirPrio::normal, 3, 0));
    CHECK(s.send(fr::net::kBroadcastMac, frame(4), AirPrio::urgent, 4, 0));
    // The first went out at once; the rest wait for its verdict.
    REQUIRE_EQ(r.tx.size(), 1u);
    CHECK_EQ(r.tx[0].bytes[1], 1);
    CHECK(s.in_flight());
    CHECK_EQ(s.queued(), 4u);
    std::vector<uint8_t> order;
    for (int i = 0; i < 4; ++i) {
        s.sent(true, 1000);
    }
    REQUIRE_EQ(r.tx.size(), 4u);
    for (const auto &t : r.tx) {
        order.push_back(t.bytes[1]);
    }
    // URGENT > NORMAL (oldest first) > BULK.
    CHECK_EQ(order, (std::vector<uint8_t>{1, 4, 3, 2}));
    REQUIRE_EQ(r.ends.size(), 4u);
    CHECK_EQ(r.ends[0].token, 1u);
    CHECK_EQ(r.ends[1].token, 4u);
    CHECK(r.ends[3].ok);
    CHECK(!s.in_flight());
    CHECK_EQ(s.stats().sent, 4u);
    CHECK(r.adds.empty());  // the broadcast peer is the driver's, added at init
    // A verdict with nothing awaiting one is dropped.
    s.sent(false, 2000);
    CHECK_EQ(r.ends.size(), 4u);
}

TEST(air_sched_refuses_sizes_and_keeps_room_for_urgent)
{
    FakeRadio r;
    Scheduler s(r);
    CHECK_EQ(s.send(fr::net::kBroadcastMac, {}, AirPrio::normal, 1, 0).error(), fr::Err::invalid_args);
    CHECK_EQ(s.send(fr::net::kBroadcastMac, frame(1, 251), AirPrio::urgent, 1, 0).error(), fr::Err::invalid_args);
    CHECK(s.send(fr::net::kBroadcastMac, frame(1, 250), AirPrio::normal, 1, 0));
    size_t normal = 1;
    while (s.send(fr::net::kBroadcastMac, frame(2), AirPrio::normal, 2, 0)) {
        ++normal;
    }
    CHECK_EQ(normal, fr::net::air::kQueueFrames - fr::net::air::kUrgentReserve);
    CHECK_EQ(s.send(fr::net::kBroadcastMac, frame(3), AirPrio::bulk, 3, 0).error(), fr::Err::busy);
    size_t urgent = 0;
    while (s.send(fr::net::kBroadcastMac, frame(4), AirPrio::urgent, 4, 0)) {
        ++urgent;
    }
    CHECK_EQ(urgent, fr::net::air::kUrgentReserve);
    CHECK_EQ(s.queued(), fr::net::air::kQueueFrames);
    CHECK_EQ(s.stats().refused, 5u);
    CHECK(r.ends.empty());  // a refused send never ends through done()
}

TEST(air_sched_link_retries_after_2_then_4_ms)
{
    FakeRadio r;
    Scheduler s(r);
    const Mac dst = mac(1);
    TimeUs now = 1'000'000;
    CHECK(s.send(dst, frame(7), AirPrio::urgent, 9, now));
    REQUIRE_EQ(r.tx.size(), 1u);
    CHECK(r.tx[0].dst == dst);
    REQUIRE_EQ(r.adds.size(), 1u);
    CHECK(r.adds[0] == dst);
    CHECK_EQ(r.armed.back(), fr::net::air::kSendGuardUs);
    s.sent(false, now + 500);  // no MAC ACK
    CHECK_EQ(r.armed.back(), 2'000u);
    s.timer(now + 1'000);  // early (a stale alarm): ignored
    CHECK_EQ(r.tx.size(), 1u);
    now += 2'500;
    s.timer(now);
    CHECK_EQ(r.tx.size(), 2u);
    s.sent(false, now + 500);
    CHECK_EQ(r.armed.back(), 4'000u);
    now += 4'500;
    s.timer(now);
    REQUIRE_EQ(r.tx.size(), 3u);
    CHECK(r.ends.empty());
    s.sent(false, now + 500);
    REQUIRE_EQ(r.ends.size(), 1u);
    CHECK_EQ(r.ends[0].token, 9u);
    CHECK(!r.ends[0].ok);
    CHECK_EQ(s.stats().retries, 2u);
    CHECK_EQ(s.stats().failed, 1u);
    CHECK(!r.timer_on);
    CHECK_EQ(r.adds.size(), 1u);  // the same peer entry for every attempt
}

TEST(air_sched_retry_that_succeeds_ends_ok)
{
    FakeRadio r;
    Scheduler s(r);
    CHECK(s.send(mac(1), frame(1), AirPrio::normal, 5, 0));
    CHECK(s.send(mac(1), frame(2), AirPrio::normal, 6, 0));
    s.sent(false, 100);
    s.timer(2'100);
    s.sent(true, 2'200);
    REQUIRE_EQ(r.ends.size(), 1u);
    CHECK(r.ends[0].ok);
    CHECK_EQ(r.tx.size(), 3u);  // frame 1 twice, then frame 2 started
    CHECK_EQ(r.tx[2].bytes[1], 2);
}

TEST(air_sched_guard_and_refused_transmit_count_as_failed_attempts)
{
    FakeRadio r;
    Scheduler s(r);
    CHECK(s.send(mac(2), frame(1), AirPrio::normal, 1, 0));
    // No send callback at all: the guard fails the attempt; the link retry waits for that callback, which
    // never comes, until kSendLostUs after the send.
    s.timer(kSendGuardUs);
    CHECK_EQ(r.armed.back(), 2'000u);
    s.timer(kSendGuardUs + 2'000);
    CHECK_EQ(r.tx.size(), 1u);
    CHECK_EQ(r.armed.back(), kSendLostUs - kSendGuardUs - 2'000);
    // esp_now_send refusing (ESP_ERR_ESPNOW_NO_MEM) is a failed attempt too, and owes no callback: no hold.
    r.transmit_ok = false;
    s.timer(kSendLostUs);
    CHECK_EQ(r.armed.back(), 4'000u);
    s.timer(kSendLostUs + 4'000);
    REQUIRE_EQ(r.ends.size(), 1u);
    CHECK(!r.ends[0].ok);
    CHECK_EQ(r.tx.size(), 3u);
    CHECK_EQ(s.stats().guard, 1u);
    CHECK_EQ(s.stats().lost, 1u);
}

TEST(air_sched_late_verdict_is_not_taken_for_the_retry)
{
    // A send callback later than the guard used to be taken for the retransmission's (2 ms on), and every
    // later verdict shifted onto the next frame: a unicast never ACKed ended mac_acked.
    FakeRadio r;
    Scheduler s(r);
    CHECK(s.send(mac(1), frame(1), AirPrio::normal, 1, 0));
    CHECK(s.send(mac(2), frame(2), AirPrio::normal, 2, 0));
    s.timer(kSendGuardUs);  // A's callback is late: that attempt failed, the retry is due 2 ms on
    s.timer(kSendGuardUs + 2'000);
    // ... but the first send is still the driver's: the retry waits for its verdict.
    CHECK_EQ(r.tx.size(), 1u);
    CHECK(s.in_flight());
    // The late verdict (ACKed) settles that first send only, and the retry goes out.
    s.sent(true, 300'000);
    REQUIRE_EQ(r.tx.size(), 2u);
    CHECK(r.tx[1].dst == mac(1));
    CHECK(r.ends.empty());
    CHECK_EQ(r.armed.back(), kSendGuardUs);
    // The retries' own verdicts decide A.
    s.sent(false, 301'000);
    s.timer(305'000);
    REQUIRE_EQ(r.tx.size(), 3u);
    s.sent(false, 306'000);
    REQUIRE_EQ(r.ends.size(), 1u);
    CHECK_EQ(r.ends[0].token, 1u);
    CHECK(!r.ends[0].ok);
    // B went out once A ended, and takes its own verdict.
    REQUIRE_EQ(r.tx.size(), 4u);
    CHECK(r.tx[3].dst == mac(2));
    s.sent(true, 307'000);
    REQUIRE_EQ(r.ends.size(), 2u);
    CHECK_EQ(r.ends[1].token, 2u);
    CHECK(r.ends[1].ok);
    CHECK_EQ(s.stats().guard, 1u);
    CHECK_EQ(s.stats().lost, 0u);
}

TEST(air_sched_next_frame_waits_for_the_late_verdict_of_a_frame_the_guard_ended)
{
    FakeRadio r;
    Scheduler s(r);
    CHECK(s.send(mac(1), frame(1), AirPrio::normal, 1, 0));
    s.sent(false, 1'000);
    s.timer(3'000);
    s.sent(false, 3'500);
    s.timer(7'500);
    s.timer(7'500 + kSendGuardUs);  // the last attempt's callback is late: A ends failed
    REQUIRE_EQ(r.ends.size(), 1u);
    CHECK(!r.ends[0].ok);
    CHECK(!s.in_flight());
    // B waits for that callback: its verdict is A's, not B's.
    CHECK(s.send(fr::net::kBroadcastMac, frame(2), AirPrio::urgent, 2, 200'000));
    CHECK_EQ(r.tx.size(), 3u);
    s.sent(true, 250'000);
    REQUIRE_EQ(r.tx.size(), 4u);
    CHECK(r.tx[3].dst == fr::net::kBroadcastMac);
    CHECK_EQ(r.ends.size(), 1u);
    s.sent(true, 251'000);
    REQUIRE_EQ(r.ends.size(), 2u);
    CHECK_EQ(r.ends[1].token, 2u);
    CHECK(r.ends[1].ok);
}

TEST(air_sched_lost_callback_holds_the_next_send_for_a_second_only)
{
    FakeRadio r;
    Scheduler s(r);
    CHECK(s.send(fr::net::kBroadcastMac, frame(1), AirPrio::normal, 1, 0));
    CHECK(s.send(fr::net::kBroadcastMac, frame(2), AirPrio::normal, 2, 0));
    s.timer(kSendGuardUs);
    s.timer(kSendGuardUs + 2'000);
    s.timer(kSendLostUs - 1'000);  // a stale alarm: still held
    CHECK_EQ(r.tx.size(), 1u);
    s.timer(kSendLostUs);  // the driver lost that callback: the retry goes
    REQUIRE_EQ(r.tx.size(), 2u);
    CHECK_EQ(s.stats().lost, 1u);
    // Several verdicts between two services (the lost one after all, then the retry's): the last is the
    // latest send's.
    s.sent(2, true, kSendLostUs + 1'000);
    REQUIRE_EQ(r.ends.size(), 1u);
    CHECK_EQ(r.ends[0].token, 1u);
    CHECK(r.ends[0].ok);
    REQUIRE_EQ(r.tx.size(), 3u);  // frame 2 at once
    CHECK_EQ(r.tx[2].bytes[1], 2);
}

TEST(air_sched_peer_lru_never_evicts_a_peer_used_within_a_second)
{
    FakeRadio r;
    Scheduler s(r);
    TimeUs now = 0;
    for (uint8_t i = 0; i < fr::net::air::kUnicastPeers; ++i) {
        now += 10'000;
        REQUIRE(s.send(mac(i), frame(i), AirPrio::normal, i, now));
        s.sent(true, now);
    }
    CHECK_EQ(s.peers(), fr::net::air::kUnicastPeers);
    CHECK_EQ(r.adds.size(), fr::net::air::kUnicastPeers);
    // An 18th peer while the oldest was used 0.84 s ago: refused, Net floods that frame instead.
    now = 1'000'000;
    CHECK_EQ(s.send(mac(100), frame(100), AirPrio::urgent, 100, now).error(), fr::Err::busy);
    CHECK(r.dels.empty());
    // A peer in the table is still served.
    CHECK(s.send(mac(5), frame(5), AirPrio::normal, 5, now));
    s.sent(true, now);
    // Once the oldest is idle for a second, it makes room (the LRU: mac(0), used at 10 ms).
    now = 1'010'001;
    CHECK(s.send(mac(100), frame(100), AirPrio::normal, 100, now));
    REQUIRE_EQ(r.dels.size(), 1u);
    CHECK(r.dels[0] == mac(0));
    CHECK(r.adds.back() == mac(100));
    CHECK_EQ(s.peers(), fr::net::air::kUnicastPeers);
    CHECK_EQ(s.stats().evictions, 1u);
}

TEST(air_sched_peer_the_radio_refuses_refuses_the_send)
{
    FakeRadio r;
    Scheduler s(r);
    r.add_ok = false;
    CHECK_EQ(s.send(mac(1), frame(1), AirPrio::normal, 1, 0).error(), fr::Err::busy);
    CHECK_EQ(s.peers(), 0u);
    CHECK(r.tx.empty());
}

TEST(air_sched_done_may_send_again)
{
    // Net's fallback chain sends from inside air_sent(): the scheduler is settled before done() runs.
    FakeRadio r;
    Scheduler s(r);
    bool resent = false;
    r.on_done = [&](uint32_t token, bool ok) {
        if (token == 1 && !ok && !resent) {
            resent = true;
            CHECK(s.send(fr::net::kBroadcastMac, frame(2), AirPrio::urgent, 2, 10'000));
        }
    };
    CHECK(s.send(mac(1), frame(1), AirPrio::urgent, 1, 0));
    s.sent(false, 0);
    s.timer(2'000);
    s.sent(false, 2'000);
    s.timer(6'000);
    s.sent(false, 6'000);
    CHECK(resent);
    REQUIRE_EQ(r.tx.size(), 4u);
    CHECK(r.tx[3].dst == fr::net::kBroadcastMac);
    CHECK(s.in_flight());
    s.sent(true, 7'000);
    CHECK_EQ(r.ends.size(), 2u);
    CHECK(!s.in_flight());
}
