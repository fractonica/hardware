// The Wi-Fi band rules (design csi-c1 D6; fr_net/src/esp/band_rules.hpp), which hub_link.cpp and espnow.cpp follow on
// target: fr_ident's fr_net/band into the band mode set after esp_wifi_start (a 2.4 GHz-only chip takes none and
// refuses 5g), the ESP-NOW peer rate per band (11a 6 Mbps for robust and fast on 5 GHz), the `wifi proto` protocols per
// band, the STA's pin and channel C on a 5 GHz channel, the scheduler's plain frames (espnow_tx's: no link retry,
// their end outside Net), and every peer's rate set again when channel C changes band.
#include <vector>

#include "../../../components/fr_net/src/esp/air_sched.hpp"
#include "../../../components/fr_net/src/esp/band_rules.hpp"
#include "../../../components/fr_net/src/esp/sta_rules.hpp"
#include "tests/test.hpp"

namespace {

using fr::net::AirRate;
using namespace fr::net::esp::detail;

TEST(band_ident_values)
{
    CHECK(band_from_ident(0) == Band::auto_);  // also an identity without the key (nvs_get_u8 leaves 0)
    CHECK(band_from_ident(1) == Band::g2);
    CHECK(band_from_ident(2) == Band::g5);
    CHECK(band_from_ident(3) == Band::auto_);  // a value this build does not know
    CHECK(band_from_ident(255) == Band::auto_);
    CHECK_EQ(std::string_view(band_name(Band::g5)), "5g");
    CHECK_EQ(std::string_view(band_name(Band::g2)), "2g");
    CHECK_EQ(std::string_view(band_name(Band::auto_)), "auto");
}

TEST(band_mode_per_chip)
{
    // The C5 (SOC_WIFI_SUPPORT_5G): every band sets its mode.
    CHECK(band_action(Band::g5, true) == BandAction::only_5g);
    CHECK(band_action(Band::g2, true) == BandAction::only_2g);
    CHECK(band_action(Band::auto_, true) == BandAction::both);
    // The C3, C6, S3: nothing to set for auto and 2g; 5g is refused (logged), the chip stays on 2.4 GHz.
    CHECK(band_action(Band::auto_, false) == BandAction::none);
    CHECK(band_action(Band::g2, false) == BandAction::none);
    CHECK(band_action(Band::g5, false) == BandAction::refuse_5g);
}

TEST(band_espnow_peer_rate)
{
    CHECK(!is_5g_channel(0));
    CHECK(!is_5g_channel(1));
    CHECK(!is_5g_channel(14));
    CHECK(is_5g_channel(36));
    CHECK(is_5g_channel(165));
    // 2.4 GHz: 11b 1 Mbps robust (and the peer default), 11g 6 Mbps fast.
    CHECK(peer_rate(AirRate::robust, 6).phy == Phy::b11);
    CHECK(!peer_rate(AirRate::robust, 6).ofdm_6m);
    CHECK(peer_rate(AirRate::peer_default, 0).phy == Phy::b11);
    CHECK(peer_rate(AirRate::fast, 11).phy == Phy::g11);
    CHECK(peer_rate(AirRate::fast, 11).ofdm_6m);
    // 5 GHz: no 11b; both are 11a 6 Mbps.
    for (uint8_t ch : {36, 44, 100, 149, 165}) {
        for (AirRate r : {AirRate::robust, AirRate::fast, AirRate::peer_default}) {
            CHECK(peer_rate(r, ch).phy == Phy::a11);
            CHECK(peer_rate(r, ch).ofdm_6m);
        }
    }
}

TEST(band_wifi_proto_per_band)
{
    const Protocols ax = wifi_protocols(true);
    const Protocols bgn = wifi_protocols(false);
    CHECK_EQ(ax.ghz_2g, 0x1 | 0x2 | 0x4 | 0x40);    // b/g/n/ax
    CHECK_EQ(ax.ghz_5g, 0x10 | 0x4 | 0x20 | 0x40);  // a/n/ac/ax
    CHECK_EQ(bgn.ghz_2g, 0x1 | 0x2 | 0x4);
    CHECK_EQ(bgn.ghz_5g, 0x10 | 0x4 | 0x20);
    CHECK((bgn.ghz_5g & kProto11b) == 0);  // never 11b on 5 GHz
}

TEST(band_sta_pins_a_5ghz_channel)
{
    // The pin and channel C are u8 channels: 36-165 go through as 1-14 do (the survey found no 2.4 GHz bound).
    Pins pins;
    const uint8_t bssid[6] = {0x10, 0x20, 0x30, 0x40, 0x50, 0x60};
    pins.load(Pin{});
    pins.use(0x1234, nullptr, false);
    CHECK(pins.associated(bssid, 165));
    CHECK_EQ(pins.home(), 165);
    CHECK_EQ(pins.stored().channel, 165);
    CHECK(pins.associated(nullptr, 149));  // the AP moved channel
    CHECK_EQ(pins.home(), 149);
}

class PlainRadio final : public fr::net::air::Radio
{
public:
    bool add_peer(const fr::net::Mac &) override { return true; }
    void del_peer(const fr::net::Mac &) override {}
    bool transmit(const fr::net::Mac &, std::span<const uint8_t>) override
    {
        ++tx;
        return true;
    }
    void arm(uint32_t) override {}
    void disarm() override {}
    void done(uint32_t token, bool ok) override { net_ends.push_back({token, ok}); }
    void done_plain(uint32_t token, bool ok) override { plain_ends.push_back({token, ok}); }

    bool set_rate(const fr::net::Mac &mac, AirRate rate) override
    {
        rates.push_back({mac, rate});
        return rate_ok;
    }

    struct End {
        uint32_t token;
        bool ok;
    };
    struct Rate {
        fr::net::Mac mac;
        AirRate rate;
    };
    int tx = 0;
    std::vector<End> net_ends;
    std::vector<End> plain_ends;
    std::vector<Rate> rates;
    bool rate_ok = true;
};

TEST(air_sched_plain_frame_no_retry_and_its_own_end)
{
    PlainRadio radio;
    fr::net::air::Scheduler sched(radio);
    const fr::net::Mac peer{0x02, 1, 2, 3, 4, 5};
    const uint8_t bytes[32] = {7};
    REQUIRE(sched.send(peer, bytes, fr::net::AirPrio::bulk, 0x11, 0, AirRate::robust, true));
    CHECK_EQ(radio.tx, 1);
    sched.sent(false, 1000);  // not acknowledged: no link retry for a plain frame
    CHECK_EQ(radio.tx, 1);
    REQUIRE_EQ(radio.plain_ends.size(), 1u);
    CHECK_EQ(radio.plain_ends[0].token, 0x11u);
    CHECK(!radio.plain_ends[0].ok);
    CHECK(radio.net_ends.empty());
    // An envelope after it still gets its retries and Net's end.
    REQUIRE(sched.send(peer, bytes, fr::net::AirPrio::normal, 0x22, 2000));
    sched.sent(false, 2100);
    CHECK_EQ(sched.stats().retries, 1u);
    sched.timer(2100 + fr::net::air::kRetryDelayUs[0]);
    sched.sent(true, 7000);
    REQUIRE_EQ(radio.net_ends.size(), 1u);
    CHECK_EQ(radio.net_ends[0].token, 0x22u);
    CHECK_EQ(radio.plain_ends.size(), 1u);
}

TEST(air_sched_band_flip_rates_every_peer_again)
{
    // Channel C moved to the other band (espnow.cpp air_set_channel): every peer entry's rate is one of the old band's,
    // so the broadcast peer, each LRU peer and the pinned gateway are set again, each at the rate it has.
    PlainRadio radio;
    fr::net::air::Scheduler sched(radio);
    const fr::net::Mac gw{0x02, 9, 9, 9, 9, 9};
    const fr::net::Mac a{0x02, 1, 1, 1, 1, 1};
    const fr::net::Mac b{0x02, 2, 2, 2, 2, 2};
    const uint8_t bytes[16] = {1};
    REQUIRE(sched.pin(&gw, 0));
    REQUIRE(sched.send(a, bytes, fr::net::AirPrio::normal, 1, 0));
    sched.sent(true, 100);
    REQUIRE(sched.send(b, bytes, fr::net::AirPrio::normal, 2, 200, AirRate::fast));
    sched.sent(true, 300);
    REQUIRE_EQ(sched.peers(), 3u);
    radio.rates.clear();
    const fr::net::air::RateChange r = sched.reapply_rates();
    CHECK_EQ(r.peers, 4u);  // the broadcast peer, a, b, the pinned gateway
    CHECK_EQ(r.failed, 0u);
    REQUIRE_EQ(radio.rates.size(), 4u);
    CHECK(radio.rates[0].mac == fr::net::kBroadcastMac);
    CHECK(radio.rates[0].rate == AirRate::peer_default);
    bool saw_a = false, saw_b = false, saw_gw = false;
    for (const auto &x : radio.rates) {
        saw_a = saw_a || (x.mac == a && x.rate == AirRate::peer_default);
        saw_b = saw_b || (x.mac == b && x.rate == AirRate::fast);  // b took fast for its frame: it keeps it
        saw_gw = saw_gw || (x.mac == gw && x.rate == AirRate::peer_default);
    }
    CHECK(saw_a && saw_b && saw_gw);
    // A refusal is counted; the others still go.
    radio.rate_ok = false;
    radio.rates.clear();
    const fr::net::air::RateChange bad = sched.reapply_rates();
    CHECK_EQ(bad.peers, 4u);
    CHECK_EQ(bad.failed, 4u);
    CHECK_EQ(radio.rates.size(), 4u);
    CHECK_EQ(sched.stats().rate_fail, 4u);
}

}  // namespace
