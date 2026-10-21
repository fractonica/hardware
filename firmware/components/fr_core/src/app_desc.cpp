// fr_app_desc (spec 06 §6.8, design c4 §2): defined once, with C linkage, so `-u fr_app_desc`
// (CMakeLists.txt) names it and IDF's linker script places it right after esp_app_desc_t, at image
// offset 288 (ld.flash.sections: `.flash.appdesc` takes `.rodata_desc`, then `.rodata_custom_desc`).
// C++ rather than C only to take the catalog hash from the generated constant; a namespace-scope C++
// `const` would have internal linkage, hence the explicit `extern "C"`. Target only: the host suite
// has no image.
#include "fr/app_desc.h"

#include "catalog.hpp"   // generated fr::cap::kCatalogHash
#include "protocol.hpp"  // generated fr::proto::kProtocolVersion
#include "sdkconfig.h"

// A fault build (spec 03 §3.8, `fr build --fault health`) says so in its descriptor, which the hub's
// ingest checks against the build it asked for: a layer that did not take effect fails the build.
#if CONFIG_FR_TEST_FAULT_HEALTH
#define FR_APP_DESC_FAULT_VALUE FR_APP_DESC_FAULT_HEALTH
#else
#define FR_APP_DESC_FAULT_VALUE FR_APP_DESC_FAULT_NONE
#endif

// `used`: nothing references it, so the compiler would drop it; `-u` keeps the linker's section GC
// from doing the same. String literals longer than a field fail to compile, so every field keeps its NUL.
extern "C" const fr_app_desc_t fr_app_desc __attribute__((used, section(".rodata_custom_desc"))) = {
    .magic = FR_APP_DESC_MAGIC,
    .version = FR_APP_DESC_VERSION,
    .proto_major = fr::proto::kProtocolVersion,
    .proto_minor = 0,
    .reserved = 0,
    .catalog_hash = fr::cap::kCatalogHash,
    .board = CONFIG_FR_BOARD,
    .profile = CONFIG_FR_PROFILE,
    .part_profile = CONFIG_FR_PART_PROFILE,
    .fault = FR_APP_DESC_FAULT_VALUE,
    .reserved2 = {},
};
