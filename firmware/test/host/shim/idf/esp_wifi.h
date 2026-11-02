// Host shim (firmware/test/host/shim/wifi_sim.hpp): the parts of esp_wifi.h (and the esp_wifi_types*.h it pulls in)
// that wifi_csi uses, with IDF v6.1's names, types and values. The shim plays the ESP32-C5 (SOC_WIFI_HE_SUPPORT, MAC
// v3, 5 GHz): wifi_csi_acquire_config_t and esp_wifi_rxctrl_t are its definitions, copied from
// components/esp_wifi/include/esp_wifi_he_types.h (CONFIG_SOC_WIFI_MAC_VERSION_NUM == 3), wifi_csi_info_t from
// local/esp_wifi_types_native.h. wifi_ap_record_t carries only the fields the driver reads (bssid, primary), in the
// real order up to them. The C3/S3 (wifi_csi_config_t of lltf_en...) and C6 (MAC v2) variants are compiled by IDF only.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifndef CONFIG_SOC_WIFI_HE_SUPPORT
#define CONFIG_SOC_WIFI_HE_SUPPORT 1
#endif
#ifndef CONFIG_SOC_WIFI_MAC_VERSION_NUM
#define CONFIG_SOC_WIFI_MAC_VERSION_NUM 3
#endif
#ifndef CONFIG_SOC_WIFI_SUPPORT_5G
#define CONFIG_SOC_WIFI_SUPPORT_5G 1
#endif
#if CONFIG_SOC_WIFI_MAC_VERSION_NUM != 3
#error "the esp_wifi shim has the C5's (MAC v3) CSI types only"
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define ESP_ERR_WIFI_BASE 0x3000
#define ESP_ERR_WIFI_NOT_INIT (ESP_ERR_WIFI_BASE + 1)
#define ESP_ERR_WIFI_NOT_STARTED (ESP_ERR_WIFI_BASE + 2)
#define ESP_ERR_WIFI_NOT_CONNECT (ESP_ERR_WIFI_BASE + 15)

typedef enum {
    WIFI_IF_STA = 0,
    WIFI_IF_AP = 1,
} wifi_interface_t;

typedef enum {
    RX_BB_FORMAT_11B = 0,
    RX_BB_FORMAT_11G = 1,
    RX_BB_FORMAT_11A = RX_BB_FORMAT_11G,
    RX_BB_FORMAT_HT = 2,
    RX_BB_FORMAT_VHT = 3,
    RX_BB_FORMAT_HE_SU = 4,
    RX_BB_FORMAT_HE_MU = 5,
    RX_BB_FORMAT_HE_ERSU = 6,
    RX_BB_FORMAT_HE_TB = 7,
    RX_BB_FORMAT_VHT_MU = 11,
} wifi_rx_bb_format_t;

typedef struct {
    uint32_t enable                 : 1;
    uint32_t acquire_csi_legacy     : 1;
    uint32_t acquire_csi_force_lltf : 1;
    uint32_t acquire_csi_ht20       : 1;
    uint32_t acquire_csi_ht40       : 1;
    uint32_t acquire_csi_vht        : 1;
    uint32_t acquire_csi_su         : 1;
    uint32_t acquire_csi_mu         : 1;
    uint32_t acquire_csi_dcm        : 1;
    uint32_t acquire_csi_beamformed : 1;
    uint32_t acquire_csi_he_stbc_mode: 2;
    uint32_t val_scale_cfg           : 4;
    uint32_t dump_ack_en             : 1;
    uint32_t lltf_bit_mode           : 1;
    uint32_t reserved                : 14;
} wifi_csi_acquire_config_t;

typedef wifi_csi_acquire_config_t wifi_csi_config_t;

typedef struct {
    signed rssi: 8;
    unsigned rate: 5;
    unsigned : 1;
    unsigned : 2;
    unsigned : 12;
    unsigned rxmatch0: 1;
    unsigned rxmatch1: 1;
    unsigned rxmatch2: 1;
    unsigned rxmatch3: 1;
    uint32_t he_siga1;
    unsigned rxend_state: 8;
    uint16_t he_siga2;
    unsigned : 7;
    unsigned is_group: 1;
    unsigned timestamp: 32;
    unsigned : 15;
    unsigned : 15;
    unsigned : 2;
    signed noise_floor: 8;
    signed : 8;
    signed : 8;
    unsigned : 8;
    unsigned : 8;
    unsigned : 8;
    unsigned : 2;
    unsigned sigb_len: 10;
    unsigned : 1;
    unsigned : 1;
    unsigned : 1;
    unsigned : 1;
    unsigned channel: 8;
    unsigned second: 8;
    unsigned : 4;
    unsigned : 4;
    unsigned : 1;
    unsigned : 7;
    unsigned : 2;
    unsigned : 4;
    unsigned : 2;
    unsigned : 11;
    unsigned : 1;
    unsigned : 12;
    unsigned : 12;
    unsigned cur_bb_format: 4;
    unsigned rx_channel_estimate_len: 10;
    unsigned rx_channel_estimate_info_vld: 1;
    unsigned : 5;
    unsigned : 21;
    unsigned : 10;
    unsigned : 1;
    unsigned : 3;
    unsigned : 1;
    unsigned : 6;
    unsigned : 21;
    unsigned : 1;
    unsigned : 32;
    unsigned : 7;
    unsigned : 1;
    unsigned : 8;
    unsigned : 16;
    unsigned sig_len: 14;
    unsigned : 2;
    unsigned dump_len: 14;
    unsigned : 2;
    unsigned rx_state: 8;
    unsigned : 8;
    unsigned : 16;
} __attribute__((packed)) esp_wifi_rxctrl_t;

typedef esp_wifi_rxctrl_t wifi_pkt_rx_ctrl_t;

typedef struct wifi_csi_info_t {
    wifi_pkt_rx_ctrl_t rx_ctrl;
    uint8_t mac[6];
    uint8_t dmac[6];
    bool first_word_invalid;
    int8_t *buf;
    uint16_t len;
    uint8_t *hdr;
    uint8_t *payload;
    uint16_t payload_len;
    uint16_t rx_seq;
} wifi_csi_info_t;

/** The real one goes on (ssid[33], second, rssi, ...): wifi_csi reads bssid and primary only. */
typedef struct {
    uint8_t bssid[6];
    uint8_t ssid[33];
    uint8_t primary;
} wifi_ap_record_t;

typedef void (*wifi_csi_cb_t)(void *ctx, wifi_csi_info_t *data);

esp_err_t esp_wifi_set_csi_rx_cb(wifi_csi_cb_t cb, void *ctx);
esp_err_t esp_wifi_set_csi_config(const wifi_csi_config_t *config);
esp_err_t esp_wifi_set_csi(bool en);
esp_err_t esp_wifi_sta_get_ap_info(wifi_ap_record_t *ap_info);

#ifdef __cplusplus
}
#endif
