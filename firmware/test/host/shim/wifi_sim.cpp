// The Wi-Fi shim (shim/wifi_sim.hpp): esp_wifi's CSI calls, esp_netif's IP info and esp_ping as wifi_csi uses them,
// answering as IDF v6.1 documents them.
#include "wifi_sim.hpp"

#include <cstring>
#include <deque>

#include "esp_netif.h"
#include "esp_wifi.h"
#include "lwip/ip_addr.h"
#include "ping/ping_sock.h"

struct esp_netif_obj {
    int unused = 0;
};

const ip_addr_t ip_addr_any_type = {{{{0, 0, 0, 0}, 0}}, IPADDR_TYPE_ANY};

namespace esp_sim {
namespace {

esp_netif_obj s_sta;
wifi_csi_cb_t s_cb = nullptr;
void *s_cb_ctx = nullptr;

struct Session {
    size_t index = 0;  // into wifi().pings
    esp_ping_callbacks_t cbs{};
};
std::deque<Session> s_sessions;  // stable addresses: the handles

}  // namespace

WifiSim &wifi()
{
    static WifiSim w;
    return w;
}

void wifi_reset()
{
    wifi() = WifiSim{};
    s_cb = nullptr;
    s_cb_ctx = nullptr;
    s_sessions.clear();
}

uint32_t ip4(uint8_t a, uint8_t b, uint8_t c, uint8_t d)
{
    return static_cast<uint32_t>(a) | static_cast<uint32_t>(b) << 8 | static_cast<uint32_t>(c) << 16 |
           static_cast<uint32_t>(d) << 24;
}

PingSession *live_ping()
{
    auto &p = wifi().pings;
    for (auto it = p.rbegin(); it != p.rend(); ++it) {
        if (!it->deleted) {
            return &*it;
        }
    }
    return nullptr;
}

bool csi_frame(const CsiFrame &f)
{
    if (s_cb == nullptr || !wifi().csi_on) {
        return false;
    }
    wifi_csi_info_t info;
    std::memset(&info, 0, sizeof(info));
    info.rx_ctrl.rssi = f.rssi;
    info.rx_ctrl.noise_floor = f.noise;
    info.rx_ctrl.channel = f.channel;
    info.rx_ctrl.cur_bb_format = f.bb_format;
    info.rx_ctrl.is_group = f.is_group ? 1 : 0;
    info.rx_ctrl.rx_channel_estimate_info_vld = f.valid ? 1 : 0;
    info.rx_ctrl.rx_channel_estimate_len = static_cast<unsigned>(f.data.size());
    info.rx_ctrl.timestamp = f.timestamp;
    std::memcpy(info.mac, f.mac.data(), 6);
    std::memcpy(info.dmac, f.dmac.data(), 6);
    info.first_word_invalid = f.first_word_invalid;
    std::vector<int8_t> buf = f.data;  // the driver's copy is gone after the callback: so is this one
    info.buf = buf.empty() ? nullptr : buf.data();
    info.len = static_cast<uint16_t>(buf.size());
    s_cb(s_cb_ctx, &info);
    return true;
}

bool ping_round(bool replied)
{
    PingSession *p = live_ping();
    if (p == nullptr || !p->started) {
        return false;
    }
    auto *s = static_cast<Session *>(p->impl);
    auto fn = replied ? s->cbs.on_ping_success : s->cbs.on_ping_timeout;
    if (fn != nullptr) {
        fn(s, s->cbs.cb_args);
    }
    return true;
}

}  // namespace esp_sim

using esp_sim::wifi;

namespace {

esp_sim::PingSession *session(esp_ping_handle_t hdl)
{
    return &wifi().pings[static_cast<esp_sim::Session *>(hdl)->index];
}

}  // namespace

extern "C" {

esp_err_t esp_wifi_set_csi_rx_cb(wifi_csi_cb_t cb, void *ctx)
{
    esp_sim::s_cb = cb;
    esp_sim::s_cb_ctx = ctx;
    wifi().cb_set = cb != nullptr;
    return ESP_OK;
}

esp_err_t esp_wifi_set_csi_config(const wifi_csi_config_t *config)
{
    if (config == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    ++wifi().csi_config_calls;
    if (wifi().fail_config != ESP_OK) {
        return wifi().fail_config;
    }
    const wifi_csi_acquire_config_t &c = *config;
    wifi().csi_config = {.enable = c.enable != 0,
                         .legacy = c.acquire_csi_legacy != 0,
                         .force_lltf = c.acquire_csi_force_lltf != 0,
                         .ht20 = c.acquire_csi_ht20 != 0,
                         .ht40 = c.acquire_csi_ht40 != 0,
                         .vht = c.acquire_csi_vht != 0,
                         .su = c.acquire_csi_su != 0,
                         .mu = c.acquire_csi_mu != 0,
                         .dcm = c.acquire_csi_dcm != 0,
                         .beamformed = c.acquire_csi_beamformed != 0,
                         .dump_ack = c.dump_ack_en != 0,
                         .lltf_8bit = c.lltf_bit_mode != 0,
                         .he_stbc_mode = c.acquire_csi_he_stbc_mode,
                         .val_scale = c.val_scale_cfg};
    return ESP_OK;
}

esp_err_t esp_wifi_set_csi(bool en)
{
    if (!en) {
        ++wifi().csi_off_calls;
    }
    wifi().csi_on = en;
    return ESP_OK;
}

esp_err_t esp_wifi_sta_get_ap_info(wifi_ap_record_t *ap_info)
{
    if (ap_info == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!wifi().associated) {
        return ESP_ERR_WIFI_NOT_CONNECT;
    }
    std::memset(ap_info, 0, sizeof(*ap_info));
    std::memcpy(ap_info->bssid, wifi().bssid.data(), 6);
    ap_info->primary = wifi().channel;
    return ESP_OK;
}

esp_netif_t *esp_netif_get_handle_from_ifkey(const char *if_key)
{
    return wifi().netif && if_key != nullptr && std::strcmp(if_key, "WIFI_STA_DEF") == 0 ? &esp_sim::s_sta : nullptr;
}

esp_err_t esp_netif_get_ip_info(esp_netif_t *esp_netif, esp_netif_ip_info_t *ip_info)
{
    if (esp_netif == nullptr || ip_info == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    ip_info->ip.addr = wifi().ip;
    ip_info->netmask.addr = wifi().ip != 0 ? esp_sim::ip4(255, 255, 255, 0) : 0;
    ip_info->gw.addr = wifi().gw;
    return ESP_OK;
}

esp_err_t esp_ping_new_session(const esp_ping_config_t *config, const esp_ping_callbacks_t *cbs, esp_ping_handle_t *hdl_out)
{
    if (config == nullptr || hdl_out == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    auto &p = wifi().pings;
    esp_sim::Session &s = esp_sim::s_sessions.emplace_back();
    s.index = p.size();
    s.cbs = cbs != nullptr ? *cbs : esp_ping_callbacks_t{};
    p.push_back({.count = config->count,
                 .interval_ms = config->interval_ms,
                 .timeout_ms = config->timeout_ms,
                 .target = config->target_addr.u_addr.ip4.addr,
                 .target_v4 = config->target_addr.type == IPADDR_TYPE_V4,
                 .started = false,
                 .deleted = false,
                 .impl = &s});
    *hdl_out = &s;
    return ESP_OK;
}

esp_err_t esp_ping_delete_session(esp_ping_handle_t hdl)
{
    if (hdl == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    session(hdl)->deleted = true;
    session(hdl)->started = false;
    return ESP_OK;
}

esp_err_t esp_ping_start(esp_ping_handle_t hdl)
{
    if (hdl == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    session(hdl)->started = true;
    return ESP_OK;
}

esp_err_t esp_ping_stop(esp_ping_handle_t hdl)
{
    if (hdl == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    session(hdl)->started = false;
    return ESP_OK;
}

}  // extern "C"
