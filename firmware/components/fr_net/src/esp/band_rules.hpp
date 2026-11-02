// The Wi-Fi band rules (design csi-c1 D6, spec 06 §6.3), IDF-free so that hub_link.cpp and espnow.cpp on target and
// the host suite run the same rules: fr_ident's `fr_net/band` (u8: 0 auto, also when absent; 1 2g; 2 5g) into what
// the STA does after esp_wifi_start (esp_wifi_set_band_mode where the chip has 5 GHz, SOC_WIFI_SUPPORT_5G), the
// ESP-NOW peer rate a band allows (11b does not exist on 5 GHz: both robust and fast are 11a 6 Mbps there), and the
// `wifi proto` hook's protocols per band (esp_wifi_set_protocols). Private to fr_net/src/esp.
#pragma once

#include <cstdint>

#include "fr/net/air.hpp"

namespace fr::net::esp::detail {

/** fr_ident fr_net/band. */
enum class Band : uint8_t { auto_ = 0, g2 = 1, g5 = 2 };

/** The provisioned value; anything this build does not know (a newer hub's) is auto: the driver's own choice. */
constexpr Band band_from_ident(uint8_t raw)
{
    return raw == 1 ? Band::g2 : raw == 2 ? Band::g5 : Band::auto_;
}

constexpr const char *band_name(Band b)
{
    return b == Band::g2 ? "2g" : b == Band::g5 ? "5g" : "auto";
}

/** What start() does about the band after esp_wifi_start. */
enum class BandAction : uint8_t {
    none,       // a 2.4 GHz-only chip and band auto or 2g: nothing to set (it is 2.4 GHz only anyway)
    only_2g,    // esp_wifi_set_band_mode(WIFI_BAND_MODE_2G_ONLY)
    only_5g,    // WIFI_BAND_MODE_5G_ONLY
    both,       // WIFI_BAND_MODE_AUTO
    refuse_5g,  // 5g on a chip without 5 GHz (the hub refuses it at provisioning): an error logged, it stays on 2.4 GHz
};

constexpr BandAction band_action(Band b, bool chip_has_5g)
{
    if (!chip_has_5g) {
        return b == Band::g5 ? BandAction::refuse_5g : BandAction::none;
    }
    return b == Band::g2 ? BandAction::only_2g : b == Band::g5 ? BandAction::only_5g : BandAction::both;
}

/** 2.4 GHz channels are 1-14; 5 GHz ones 36-177. */
constexpr bool is_5g_channel(uint8_t channel)
{
    return channel > 14;
}

/** A peer's PHY (IDF wifi_phy_mode_t's names; never LR, which receivers outside LR cannot hear). */
enum class Phy : uint8_t { b11, g11, a11 };

/** The PHY rate esp_now_set_peer_rate_config gets (05 §5.3): 11b 1 Mbps long preamble, or OFDM 6 Mbps. */
struct PeerRate {
    Phy phy;
    bool ofdm_6m;  // WIFI_PHY_RATE_6M, else WIFI_PHY_RATE_1M_L
};

/**
 * `rate` on `channel` (the radio's: channel C; 0 while unknown counts as 2.4 GHz): on 2.4 GHz robust is 11b 1 Mbps and
 * fast 11g 6 Mbps; on 5 GHz both are 11a 6 Mbps (design csi-c1 D6). peer_default is robust.
 */
constexpr PeerRate peer_rate(AirRate rate, uint8_t channel)
{
    if (is_5g_channel(channel)) {
        return {Phy::a11, true};
    }
    return rate == AirRate::fast ? PeerRate{Phy::g11, true} : PeerRate{Phy::b11, false};
}

/** IDF's WIFI_PROTOCOL_* bits (esp_wifi_types_generic.h; hub_link.cpp static_asserts them). */
inline constexpr uint16_t kProto11b = 0x1, kProto11g = 0x2, kProto11n = 0x4, kProto11a = 0x10, kProto11ac = 0x20,
                          kProto11ax = 0x40;

/** wifi_protocols_t {ghz_2g, ghz_5g}: what `wifi proto <ax|bgn>` asks of each band (the driver ignores the band the
 * band mode leaves out). */
struct Protocols {
    uint16_t ghz_2g;
    uint16_t ghz_5g;
};

constexpr Protocols wifi_protocols(bool ax)
{
    const uint16_t he = ax ? kProto11ax : 0;
    return {static_cast<uint16_t>(kProto11b | kProto11g | kProto11n | he),
            static_cast<uint16_t>(kProto11a | kProto11n | kProto11ac | he)};
}

}  // namespace fr::net::esp::detail
