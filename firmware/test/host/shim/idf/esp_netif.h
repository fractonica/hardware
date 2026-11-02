// Host shim (firmware/test/host/shim/wifi_sim.hpp): the parts of esp_netif.h wifi_csi uses (IDF v6.1 names and types:
// esp_netif_types.h, esp_netif_ip_addr.h). Addresses are lwIP's: network byte order in the u32.
#pragma once

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

struct esp_netif_obj;
typedef struct esp_netif_obj esp_netif_t;

struct esp_ip4_addr {
    uint32_t addr;
};
typedef struct esp_ip4_addr esp_ip4_addr_t;

typedef struct {
    esp_ip4_addr_t ip;
    esp_ip4_addr_t netmask;
    esp_ip4_addr_t gw;
} esp_netif_ip_info_t;

esp_netif_t *esp_netif_get_handle_from_ifkey(const char *if_key);
esp_err_t esp_netif_get_ip_info(esp_netif_t *esp_netif, esp_netif_ip_info_t *ip_info);

#ifdef __cplusplus
}
#endif
