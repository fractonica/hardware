// Device identity (spec 06 §6.3): factory MAC plus the hub-assigned addr/alias/net stored in the
// read-only `fr_ident` NVS partition. Without that partition the device is UNASSIGNED (addr 0xFFFE).
#pragma once

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FR_ADDR_UNASSIGNED 0xFFFE

typedef enum {
    FR_ID_UNASSIGNED = 0,
    FR_ID_PROVISIONED = 1,
    FR_ID_MISBOUND = 2,  // fr_ident belongs to another MAC (image copied between boards)
} fr_id_state_t;

typedef struct {
    uint8_t mac[6];
    char device_id[13];  // 12 lowercase hex digits of the factory MAC
    fr_id_state_t state;
    uint16_t addr;
    uint16_t net;
    char alias[32];
    uint32_t alias_rev;
    uint16_t epoch_floor;
    char board[32];    // compiled in (CONFIG_FR_BOARD)
    char profile[32];  // compiled in (CONFIG_FR_PROFILE)
} fr_identity_t;

/** Factory MAC (6 bytes). Never use esp_efuse_mac_get_default(): it returns 8 bytes on the C6. */
esp_err_t fr_id_get_mac(uint8_t out[6]);

/** Loads identity; a missing or empty fr_ident is not an error (state = UNASSIGNED). */
esp_err_t fr_id_load(fr_identity_t *out);

const char *fr_id_state_name(fr_id_state_t state);

#ifdef __cplusplus
}
#endif
