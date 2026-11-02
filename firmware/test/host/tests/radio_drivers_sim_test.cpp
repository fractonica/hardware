// The CSI-1 radio drivers (design csi-c1 D7-D9) built unchanged against the IDF shim (shim/wifi_sim.cpp: the C5's MAC v3
// CSI types, esp_netif, esp_ping; esp_sim's esp_timer on FakeCore; shim/espnow_sim.cpp for fr_net's ESP-NOW calls).
// wifi_csi: nothing before the station has an IP, then the CSI config bits per format, CSI on, the ping session to the
// gateway at rate_hz; the router, peer and any filters (the AP's BSSID, peer_mac, every sender) and the records'
// fields and flags; invalid estimates and records above 512 bytes skipped; a reconnect to another AP re-applied, a
// lost IP turning CSI off; stop; the pings' rate in whole FreeRTOS ticks; the filter's two copies, which the callback
// reads without ever waiting for a writer stopped half way.
// espnow_tx: refused without a channel, frames at rate_hz with their sequence numbers, a tick with the previous frame
// still in flight skipped (counted failed), acknowledgements counted, a lost channel stopping the run, stop.
#include <atomic>
#include <thread>
#include <vector>

#include "esp_sim.hpp"
#include "espnow_sim.hpp"
#include "fr/drv/espnow_tx.hpp"
#include "fr/drv/wifi_csi.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"
#include "wifi_sim.hpp"

namespace {

using frt::FakeCore;
using fr::hal::CsiCapture;
using fr::hal::CsiMode;

class Sink final : public fr::hal::CsiSink
{
public:
    struct Rec {
        fr::hal::CsiRecord r;
        std::vector<int8_t> data;
    };
    void on_csi(const fr::hal::CsiRecord &r) override
    {
        recs.push_back({r, {r.data.begin(), r.data.end()}});
    }
    std::vector<Rec> recs;
};

const std::array<uint8_t, 6> kAp{0x10, 0x20, 0x30, 0x40, 0x50, 0x60};
const std::array<uint8_t, 6> kPeer{0x02, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE};
const std::array<uint8_t, 6> kOther{0x7C, 0x11, 0x22, 0x33, 0x44, 0x55};

struct CsiRig {
    CsiRig()
    {
        esp_sim::reset();
        esp_sim::attach(core);
        esp_sim::wifi_reset();
        drv.init(core, sink);
    }
    ~CsiRig() { esp_sim::reset(); }  // while the core its timers sit on is alive
    void connect(const std::array<uint8_t, 6> &bssid = kAp, uint8_t channel = 36)
    {
        auto &w = esp_sim::wifi();
        w.ip = esp_sim::ip4(192, 168, 5, 23);
        w.gw = esp_sim::ip4(192, 168, 5, 1);
        w.associated = true;
        w.bssid = bssid;
        w.channel = channel;
    }
    esp_sim::CsiFrame frame(const std::array<uint8_t, 6> &from)
    {
        esp_sim::CsiFrame f;
        f.mac = from;
        f.dmac = {0x02, 0, 0, 0, 0, 1};
        f.timestamp = 123456;
        f.data.assign(490, 9);  // HE20: 245 subcarriers
        return f;
    }

    FakeCore core;
    Sink sink;
    fr::drv::WifiCsi drv{fr::drv::WifiCsi::Config{}};
};

CsiCapture capture_of(CsiMode m, uint16_t hz = 100, fr::hal::CsiFormat f = fr::hal::CsiFormat::auto_)
{
    CsiCapture c;
    c.mode = m;
    c.rate_hz = hz;
    c.format = f;
    if (m == CsiMode::peer) {
        c.peer = kPeer;
        c.has_peer = true;
    }
    return c;
}

TEST(wifi_csi_waits_for_an_ip_then_applies)
{
    CsiRig rig;
    CHECK_EQ(rig.drv.capture({.mode = CsiMode::peer}).error(), fr::Err::invalid_args);  // peer without a MAC
    CHECK_EQ(rig.drv.capture({.mode = CsiMode::router, .rate_hz = 5}).error(), fr::Err::invalid_args);
    REQUIRE(rig.drv.capture(capture_of(CsiMode::router, 100)));
    CHECK(!rig.drv.applied());
    CHECK_EQ(esp_sim::wifi().csi_config_calls, 0);
    CHECK(!rig.drv.selftest().ok);
    rig.connect();
    rig.core.advance_ms(600);  // the next poll
    REQUIRE(rig.drv.applied());
    CHECK(rig.drv.selftest().ok);
    const esp_sim::CsiConfig &c = esp_sim::wifi().csi_config;
    CHECK(c.enable);
    CHECK(c.legacy);
    CHECK(!c.force_lltf);
    CHECK(c.ht20 && c.ht40 && c.vht);
    CHECK(c.su && c.mu && c.dcm && c.beamformed);
    CHECK_EQ(c.he_stbc_mode, 2u);
    CHECK(c.lltf_8bit);
    CHECK_EQ(c.val_scale, 0u);
    CHECK(!c.dump_ack);
    CHECK(esp_sim::wifi().cb_set);
    CHECK(esp_sim::wifi().csi_on);
    esp_sim::PingSession *p = esp_sim::live_ping();
    REQUIRE(p != nullptr);
    CHECK(p->started);
    CHECK_EQ(p->count, 0u);  // infinite
    CHECK_EQ(p->interval_ms, 10u);
    CHECK_EQ(p->timeout_ms, 10u);
    CHECK(p->target_v4);
    CHECK_EQ(p->target, esp_sim::ip4(192, 168, 5, 1));
    CHECK(esp_sim::ping_round(true));
    CHECK(esp_sim::ping_round(false));
    CHECK_EQ(rig.drv.pings_sent(), 2u);
    CHECK_EQ(rig.drv.pings_lost(), 1u);
    // Polls with nothing changed apply nothing again.
    const int calls = esp_sim::wifi().csi_config_calls;
    rig.core.advance_ms(2000);
    CHECK_EQ(esp_sim::wifi().csi_config_calls, calls);
    CHECK_EQ(esp_sim::wifi().pings.size(), 1u);
}

TEST(wifi_csi_formats)
{
    CsiRig rig;
    rig.connect();
    REQUIRE(rig.drv.capture(capture_of(CsiMode::any, 50, fr::hal::CsiFormat::lltf)));
    const esp_sim::CsiConfig &c = esp_sim::wifi().csi_config;
    CHECK(c.legacy && c.force_lltf);
    CHECK(!c.ht20 && !c.ht40 && !c.vht && !c.su && !c.mu);
    CHECK(esp_sim::live_ping() == nullptr);  // no pings outside router
    REQUIRE(rig.drv.capture(capture_of(CsiMode::any, 50, fr::hal::CsiFormat::he)));
    CHECK(c.legacy && !c.force_lltf && !c.ht20 && c.su && c.mu);
    REQUIRE(rig.drv.capture(capture_of(CsiMode::any, 50, fr::hal::CsiFormat::ht)));
    CHECK(c.ht20 && c.ht40 && c.vht && !c.su);
}

TEST(wifi_csi_router_filter_and_fields)
{
    CsiRig rig;
    rig.connect();
    REQUIRE(rig.drv.capture(capture_of(CsiMode::router)));
    esp_sim::CsiFrame f = rig.frame(kAp);
    f.data[0] = -7;
    f.first_word_invalid = true;
    f.is_group = true;
    f.rssi = -61;
    f.noise = -97;
    f.channel = 149;
    f.bb_format = 4;
    REQUIRE(esp_sim::csi_frame(f));
    REQUIRE(esp_sim::csi_frame(rig.frame(kOther)));  // another sender: dropped
    esp_sim::CsiFrame bad = rig.frame(kAp);
    bad.valid = false;  // rx_channel_estimate_info_vld clear
    REQUIRE(esp_sim::csi_frame(bad));
    REQUIRE_EQ(rig.sink.recs.size(), 1u);
    const auto &r = rig.sink.recs[0];
    CHECK_EQ(r.r.t_us, 123456u);
    CHECK_EQ(r.r.rssi, -61);
    CHECK_EQ(r.r.noise, -97);
    CHECK_EQ(r.r.channel, 149u);
    CHECK(r.r.bb_format == fr::hal::CsiBbFormat::he_su);
    CHECK_EQ(r.r.flags, fr::hal::kCsiFlagFirstWordInvalid | fr::hal::kCsiFlagGroup | fr::hal::kCsiFlagMatched);
    CHECK(r.r.mac == kAp);
    REQUIRE_EQ(r.data.size(), 490u);
    CHECK_EQ(r.data[0], -7);
    CHECK_EQ(rig.drv.kept(), 1u);
    CHECK_EQ(rig.drv.skipped(), 2u);
}

TEST(wifi_csi_peer_and_any_filters)
{
    CsiRig rig;
    rig.connect();
    REQUIRE(rig.drv.capture(capture_of(CsiMode::peer)));
    CHECK(esp_sim::live_ping() == nullptr);
    esp_sim::csi_frame(rig.frame(kAp));
    esp_sim::csi_frame(rig.frame(kPeer));
    esp_sim::csi_frame(rig.frame(kOther));
    REQUIRE_EQ(rig.sink.recs.size(), 1u);
    CHECK(rig.sink.recs[0].r.mac == kPeer);
    CHECK((rig.sink.recs[0].r.flags & fr::hal::kCsiFlagMatched) != 0);
    // any: every sender, none of them matched.
    REQUIRE(rig.drv.capture(capture_of(CsiMode::any)));
    rig.sink.recs.clear();
    esp_sim::csi_frame(rig.frame(kAp));
    esp_sim::csi_frame(rig.frame(kPeer));
    esp_sim::csi_frame(rig.frame(kOther));
    REQUIRE_EQ(rig.sink.recs.size(), 3u);
    for (const auto &r : rig.sink.recs) {
        CHECK_EQ(r.r.flags & fr::hal::kCsiFlagMatched, 0u);
    }
}

TEST(wifi_csi_reconnect_and_ip_loss)
{
    CsiRig rig;
    rig.connect();
    REQUIRE(rig.drv.capture(capture_of(CsiMode::router, 200)));
    REQUIRE(rig.drv.applied());
    CHECK_EQ(esp_sim::live_ping()->interval_ms, 5u);  // 200 Hz (no FreeRTOS tick on the host)
    // The station moved to another AP: the filter follows its BSSID, the pings start again.
    const std::array<uint8_t, 6> ap2{0x10, 0x20, 0x30, 0x40, 0x50, 0x61};
    rig.connect(ap2, 44);
    rig.core.advance_ms(600);
    CHECK_EQ(esp_sim::wifi().pings.size(), 2u);
    CHECK(esp_sim::wifi().pings[0].deleted);
    esp_sim::csi_frame(rig.frame(kAp));
    esp_sim::csi_frame(rig.frame(ap2));
    REQUIRE_EQ(rig.sink.recs.size(), 1u);
    CHECK(rig.sink.recs[0].r.mac == ap2);
    // The IP lost: CSI off, no pings, until it is back.
    esp_sim::wifi().ip = 0;
    rig.core.advance_ms(600);
    CHECK(!rig.drv.applied());
    CHECK(!esp_sim::wifi().csi_on);
    CHECK(esp_sim::live_ping() == nullptr);
    rig.connect(ap2, 44);
    rig.core.advance_ms(600);
    CHECK(rig.drv.applied());
    CHECK(esp_sim::wifi().csi_on);
    // stop: off, and the polls stop.
    REQUIRE(rig.drv.stop());
    CHECK(!esp_sim::wifi().csi_on);
    CHECK(esp_sim::live_ping() == nullptr);
    const int calls = esp_sim::wifi().csi_config_calls;
    rig.core.advance_ms(2000);
    CHECK_EQ(esp_sim::wifi().csi_config_calls, calls);
}

TEST(wifi_csi_config_refused_is_tried_again)
{
    CsiRig rig;
    rig.connect();
    esp_sim::wifi().fail_config = 0x102;  // ESP_ERR_INVALID_ARG
    REQUIRE(rig.drv.capture(capture_of(CsiMode::router)));
    CHECK(!rig.drv.applied());
    esp_sim::wifi().fail_config = 0;
    rig.core.advance_ms(600);
    CHECK(rig.drv.applied());
}

TEST(wifi_csi_ping_rate_in_whole_ticks)
{
    // The C5's 100 Hz tick: esp_ping waits whole ticks, so 51-200 Hz cannot all be 100 Hz silently. The nearest whole
    // number of ticks, and the rate that gives.
    using fr::drv::WifiCsi;
    CHECK_EQ(WifiCsi::ping_ticks(100, 100), 1u);
    CHECK_EQ(WifiCsi::ping_ticks(200, 100), 1u);   // 100 Hz at most
    CHECK_EQ(WifiCsi::ping_ticks(150, 100), 1u);
    CHECK_EQ(WifiCsi::ping_ticks(60, 100), 2u);    // 50 Hz
    CHECK_EQ(WifiCsi::ping_ticks(40, 100), 3u);    // 33 Hz (2.5 rounds up)
    CHECK_EQ(WifiCsi::ping_ticks(30, 100), 3u);
    CHECK_EQ(WifiCsi::ping_ticks(10, 100), 10u);
    CHECK_EQ(WifiCsi::ping_ticks(0, 100), 1u);
    CHECK_EQ(WifiCsi::ping_ticks(150, 1000), 7u);  // 143 Hz on a 1 kHz tick
    CHECK_EQ(WifiCsi::ping_ticks(200, 1000), 5u);
    // The driver on the host's 1 kHz tick: the interval and the rate it reports.
    CsiRig rig;
    rig.connect();
    REQUIRE(rig.drv.capture(capture_of(CsiMode::router, 150)));
    REQUIRE(esp_sim::live_ping() != nullptr);
    CHECK_EQ(esp_sim::live_ping()->interval_ms, 7u);
    CHECK_EQ(rig.drv.ping_hz(), 142u);
    REQUIRE(rig.drv.capture(capture_of(CsiMode::peer)));
    CHECK_EQ(rig.drv.ping_hz(), 0u);  // no pings outside router
}

TEST(wifi_csi_oversized_record_dropped_and_counted)
{
    CsiRig rig;
    rig.connect();
    REQUIRE(rig.drv.capture(capture_of(CsiMode::router)));
    esp_sim::CsiFrame big = rig.frame(kAp);
    big.data.assign(fr::hal::kCsiDataMax + 2, 3);  // more than the wire's len may say (design §12: <= 512)
    REQUIRE(esp_sim::csi_frame(big));
    CHECK(rig.sink.recs.empty());  // dropped whole, not cut to 512
    CHECK_EQ(rig.drv.oversized(), 1u);
    CHECK_EQ(rig.drv.skipped(), 1u);
    esp_sim::CsiFrame max = rig.frame(kAp);
    max.data.assign(fr::hal::kCsiDataMax, 3);
    REQUIRE(esp_sim::csi_frame(max));
    REQUIRE_EQ(rig.sink.recs.size(), 1u);
    CHECK_EQ(rig.sink.recs[0].data.size(), fr::hal::kCsiDataMax);
    CHECK_EQ(rig.drv.oversized(), 1u);
}

TEST(wifi_csi_filter_reader_never_waits_for_a_paused_writer)
{
    using fr::drv::CsiFilter;
    CsiFilter f;
    f.set({.mode = CsiMode::router, .lo = 0x11111111, .hi = 0x1111});
    // The core task stopped half way through an update (the Wi-Fi task preempted it): the reader gets the filter in
    // use, whole, at once, again and again; the new one once the writer goes on.
    f.stage({.mode = CsiMode::peer, .lo = 0x22222222, .hi = 0x2222});
    for (int i = 0; i < 100; ++i) {
        CsiFilter::Value v;
        REQUIRE(f.get(v));
        CHECK(v.mode == CsiMode::router);
        CHECK_EQ(v.lo, 0x11111111u);
        CHECK_EQ(v.hi, 0x1111u);
    }
    f.publish();
    CsiFilter::Value v;
    REQUIRE(f.get(v));
    CHECK(v.mode == CsiMode::peer);
    CHECK_EQ(v.lo, 0x22222222u);
    CHECK_EQ(v.hi, 0x2222u);

    // A writer on another core, flat out: every read the reader takes is one whole filter, never a mix, and a read
    // that could not be had whole ends in kTries (the record dropped), never a wait.
    std::atomic<bool> stop{false};
    std::thread writer([&] {
        for (uint32_t n = 0; !stop.load(std::memory_order_relaxed); ++n) {
            const uint32_t x = n & 1 ? 0x33333333u : 0x44444444u;
            f.set({.mode = n & 1 ? CsiMode::any : CsiMode::router, .lo = x, .hi = x & 0xFFFF});
        }
    });
    uint32_t whole = 0;
    uint32_t missed = 0;
    for (int i = 0; i < 200'000; ++i) {
        CsiFilter::Value r;
        if (!f.get(r)) {
            ++missed;
            continue;
        }
        ++whole;
        const bool a = r.mode == CsiMode::any && r.lo == 0x33333333u && r.hi == 0x3333u;
        const bool b = r.mode == CsiMode::router && r.lo == 0x44444444u && r.hi == 0x4444u;
        const bool c = r.mode == CsiMode::peer && r.lo == 0x22222222u && r.hi == 0x2222u;  // before the writer ran
        if (!(a || b || c)) {
            CHECK(a || b || c);
            break;
        }
    }
    stop.store(true);
    writer.join();
    CHECK(whole > 0);
    CHECK_EQ(whole + missed, 200'000u);
}

// ---- espnow_tx ----

struct TxRig {
    TxRig()
    {
        esp_sim::reset();
        esp_sim::attach(core);
        esp_sim::air_reset();
        REQUIRE(drv.init(core));
    }
    ~TxRig() { esp_sim::reset(); }
    FakeCore core;
    fr::drv::EspnowTx drv{fr::drv::EspnowTx::Config{}};
};

TEST(espnow_tx_refused_without_a_channel)
{
    TxRig rig;
    esp_sim::air().up = false;
    CHECK_EQ(rig.drv.start(kPeer, 100, 32).error(), fr::Err::busy);
    esp_sim::air().up = true;
    CHECK_EQ(rig.drv.start({0x01, 0, 0x5E, 0, 0, 1}, 100, 32).error(), fr::Err::invalid_args);
    CHECK(!rig.drv.running());
}

TEST(espnow_tx_rate_and_frames)
{
    TxRig rig;
    REQUIRE(rig.drv.start(kPeer, 50, 32));
    CHECK(rig.drv.running());
    // Every frame acknowledged at once: 50 in a second.
    for (int i = 0; i < 100; ++i) {
        rig.core.advance_ms(10);
        auto &f = esp_sim::air().frames;
        if (!f.empty() && rig.drv.acked() < f.size()) {
            esp_sim::end_frame(f.size() - 1, true);
        }
    }
    const auto &frames = esp_sim::air().frames;
    CHECK_EQ(frames.size(), 50u);
    CHECK_EQ(rig.drv.sent(), 50u);
    CHECK_EQ(rig.drv.acked(), 50u);
    CHECK_EQ(rig.drv.failed(), 0u);
    for (size_t i = 0; i < frames.size(); ++i) {
        REQUIRE_EQ(frames[i].bytes.size(), 32u);
        CHECK_EQ(frames[i].bytes[0] | frames[i].bytes[1] << 8 | frames[i].bytes[2] << 16, static_cast<int>(i));
        CHECK_EQ(frames[i].bytes[31], 0u);
        CHECK(frames[i].dst == kPeer);
        if (i > 0) {
            CHECK_EQ(frames[i].at - frames[i - 1].at, 20'000);  // 1 / 50 Hz
        }
    }
}

TEST(espnow_tx_one_in_flight_and_stops)
{
    TxRig rig;
    REQUIRE(rig.drv.start(kPeer, 100, 16));
    rig.core.advance_ms(55);  // 5 ticks, the first frame never ends: 4 skipped
    CHECK_EQ(esp_sim::air().frames.size(), 1u);
    CHECK_EQ(rig.drv.failed(), 4u);
    esp_sim::end_frame(0, false);  // not acknowledged
    CHECK_EQ(rig.drv.failed(), 5u);
    rig.core.advance_ms(10);
    REQUIRE_EQ(esp_sim::air().frames.size(), 2u);
    CHECK_EQ(esp_sim::air().frames[1].bytes[0], 5u);  // the sequence went on through the skipped ones
    // A refused send counts failed, the next tick tries again.
    esp_sim::end_frame(1, true);
    esp_sim::air().refuse = 1;
    rig.core.advance_ms(10);
    CHECK_EQ(esp_sim::air().frames.size(), 2u);
    rig.core.advance_ms(10);
    CHECK_EQ(esp_sim::air().frames.size(), 3u);
    esp_sim::end_frame(2, true);
    // The channel lost: the run stops itself.
    esp_sim::air().up = false;
    rig.core.advance_ms(10);
    CHECK(!rig.drv.running());
    esp_sim::air().up = true;
    rig.core.advance_ms(100);
    CHECK_EQ(esp_sim::air().frames.size(), 3u);
    // start, stop.
    REQUIRE(rig.drv.start(kPeer, 100, 16));
    rig.core.advance_ms(10);
    CHECK(rig.drv.stop());
    CHECK(!rig.drv.running());
    const size_t n = esp_sim::air().frames.size();
    rig.core.advance_ms(100);
    CHECK_EQ(esp_sim::air().frames.size(), n);
    CHECK(rig.drv.selftest().ok);
}

}  // namespace
