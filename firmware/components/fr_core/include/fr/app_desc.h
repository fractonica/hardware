/*
 * fr_app_desc (spec 06 §6.8, design c4 §2): Fractonica's custom app descriptor. IDF places the
 * `.rodata_custom_desc` section right after esp_app_desc_t at the start of the image's first (DROM)
 * segment, so it sits at a fixed image offset: 24 (image header) + 8 (segment header) + 256
 * (esp_app_desc_t) = 288. The hub reads it at ingest, and a node's OTA CHECK reads it from the first
 * 400 bytes of a download, before any flash write. C, because the hub, the OTA CHECK and IDF's linker
 * all see the same bytes; the layout below is a wire format: append in reserved2 only.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FR_APP_DESC_MAGIC 0x46524144u /* "FRAD" read as a little-endian u32 */
#define FR_APP_DESC_VERSION 1
/** Image offset of fr_app_desc_t (see above). */
#define FR_APP_DESC_OFFSET 288u
/** fr_app_desc.fault: the image is a fault build (spec 03 §3.8). */
#define FR_APP_DESC_FAULT_NONE 0
#define FR_APP_DESC_FAULT_HEALTH 1 /* CONFIG_FR_TEST_FAULT_HEALTH: never sets the CAPS health bit */

typedef struct {
    uint32_t magic;            /* FR_APP_DESC_MAGIC */
    uint8_t version;           /* FR_APP_DESC_VERSION */
    uint8_t proto_major;       /* wire protocol (schema/protocol.yaml `version`) */
    uint8_t proto_minor;
    uint8_t reserved;
    uint32_t catalog_hash;     /* fr gen catalog hash (fr::cap::kCatalogHash) */
    char board[32];            /* CONFIG_FR_BOARD, NUL-terminated */
    char profile[32];          /* CONFIG_FR_PROFILE */
    char part_profile[16];     /* CONFIG_FR_PART_PROFILE */
    uint8_t fault;             /* FR_APP_DESC_FAULT_* */
    uint8_t reserved2[19];     /* zero; brings the struct to 112 B, so 288 + 112 = the 400 B CHECK reads */
} fr_app_desc_t;

#ifdef __cplusplus
#define FR_APP_DESC_ASSERT static_assert
#else
#define FR_APP_DESC_ASSERT _Static_assert
#endif
FR_APP_DESC_ASSERT(sizeof(fr_app_desc_t) == 112, "fr_app_desc_t is 112 bytes (design c4 §2)");
FR_APP_DESC_ASSERT(offsetof(fr_app_desc_t, catalog_hash) == 8, "fr_app_desc_t layout");
FR_APP_DESC_ASSERT(offsetof(fr_app_desc_t, board) == 12, "fr_app_desc_t layout");
FR_APP_DESC_ASSERT(offsetof(fr_app_desc_t, profile) == 44, "fr_app_desc_t layout");
FR_APP_DESC_ASSERT(offsetof(fr_app_desc_t, part_profile) == 76, "fr_app_desc_t layout");
FR_APP_DESC_ASSERT(offsetof(fr_app_desc_t, fault) == 92, "fr_app_desc_t layout");
#undef FR_APP_DESC_ASSERT

/** This image's descriptor (fr_core/src/app_desc.cpp). On the host there is none. */
extern const fr_app_desc_t fr_app_desc;

#ifdef __cplusplus
}
#endif
