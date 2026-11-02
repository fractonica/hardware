// The host suite's Wi-Fi shim (design csi-c1 D7, D8): the test side of idf/esp_wifi.h, idf/esp_netif.h and
// idf/ping/ping_sock.h. The suite builds hardware/drivers/wifi_csi unchanged against idf/ (FR_HOST_SHIM), so its tests
// check what the driver asks of the hardware (the CSI config, the callback, CSI on and off, the ping session to the
// gateway) and which records reach the sink. The station (IP, gateway, AP) is what the test sets; a CSI frame is the
// registered callback run with a wifi_csi_info_t made from the test's CsiFrame, as the Wi-Fi task would. This header
// keeps IDF's types out of the tests (plain fields, IDF's names).
#pragma once

#include <array>
#include <cstdint>
#include <vector>

namespace esp_sim {

/** wifi_csi_acquire_config_t (the C5's), field by field. */
struct CsiConfig {
    bool enable = false, legacy = false, force_lltf = false, ht20 = false, ht40 = false, vht = false, su = false,
         mu = false, dcm = false, beamformed = false, dump_ack = false, lltf_8bit = false;
    unsigned he_stbc_mode = 0, val_scale = 0;
};

/** esp_ping_config_t's fields wifi_csi sets, and the session's state. */
struct PingSession {
    uint32_t count = 0;
    uint32_t interval_ms = 0;
    uint32_t timeout_ms = 0;
    uint32_t target = 0;  // IPv4, lwIP's order
    bool target_v4 = false;
    bool started = false;
    bool deleted = false;
    void *impl = nullptr;  // the shim's
};

/** One received frame's CSI (wifi_csi_info_t and its rx_ctrl, the fields the driver reads). */
struct CsiFrame {
    std::array<uint8_t, 6> mac{};
    std::array<uint8_t, 6> dmac{};
    int8_t rssi = -50;
    int8_t noise = -95;
    uint8_t channel = 36;
    uint8_t bb_format = 4;  // RX_BB_FORMAT_HE_SU
    bool is_group = false;
    bool valid = true;  // rx_channel_estimate_info_vld
    bool first_word_invalid = false;
    uint32_t timestamp = 0;
    std::vector<int8_t> data;
};

struct WifiSim {
    // the station
    bool netif = true;  // WIFI_STA_DEF exists
    uint32_t ip = 0;    // lwIP's order; 0: no address
    uint32_t gw = 0;
    bool associated = false;
    std::array<uint8_t, 6> bssid{};
    uint8_t channel = 0;
    // CSI
    CsiConfig csi_config{};
    int csi_config_calls = 0;
    bool cb_set = false;
    bool csi_on = false;
    int csi_off_calls = 0;
    int fail_config = 0;  // what esp_wifi_set_csi_config answers (0: ESP_OK, it takes it)
    // esp_ping: every session made, in order
    std::vector<PingSession> pings;
};

WifiSim &wifi();
void wifi_reset();
/** a.b.c.d in lwIP's order (network order in the u32). */
uint32_t ip4(uint8_t a, uint8_t b, uint8_t c, uint8_t d);
/** The newest ping session not deleted (nullptr: none). */
PingSession *live_ping();
/** One CSI frame through the registered callback; false when none is registered or CSI is off. */
bool csi_frame(const CsiFrame &f);
/** The live session's next ping, answered or not: its callback, as the ping task would; false without one. */
bool ping_round(bool replied);

}  // namespace esp_sim
