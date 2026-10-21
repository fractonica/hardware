// fr_app_desc_t (spec 06 §6.8, design c4 §2) as bytes: the layout the hub's ingest parses at image offset
// 288 and a node's OTA CHECK reads from the first 400 bytes. The golden bytes are the same ones
// packages/hub/test/build.test.ts parses, so both sides agree on every offset. Also links the fr_ota
// skeleton's Ota, which the target build compiles too.
#include <cstring>
#include <vector>

#include "fr/app_desc.h"
#include "fr/ota/ota.hpp"
#include "tests/test.hpp"

namespace {

// magic, version 1, proto 1.0, catalog 0xC7BDE94D | board "esp32c6-supermini" | profile "c6-pad" |
// part_profile "fr-4mb-v1" | fault 1 | reserved2.
constexpr const char *kGolden =
    "44415246 01 01 00 00 4de9bdc7"
    "657370333263362d73757065726d696e69 000000000000000000000000000000"
    "63362d706164 0000000000000000000000000000000000000000000000000000"
    "66722d346d622d7631 00000000000000"
    "01"
    "00000000000000000000000000000000000000";

template <size_t N>
void put(char (&dst)[N], const char *s)
{
    std::memset(dst, 0, N);
    std::memcpy(dst, s, std::strlen(s));
}

}  // namespace

TEST(app_desc_layout_matches_the_hub)
{
    fr_app_desc_t d{};
    d.magic = FR_APP_DESC_MAGIC;
    d.version = FR_APP_DESC_VERSION;
    d.proto_major = 1;
    d.proto_minor = 0;
    d.catalog_hash = 0xC7BDE94D;
    put(d.board, "esp32c6-supermini");
    put(d.profile, "c6-pad");
    put(d.part_profile, "fr-4mb-v1");
    d.fault = FR_APP_DESC_FAULT_HEALTH;
    std::vector<uint8_t> bytes(sizeof d);
    std::memcpy(bytes.data(), &d, sizeof d);
    CHECK_BYTES(bytes, frt::from_hex(kGolden));
    // "FRAD" as the u32 0x46524144, little-endian on every target: the bytes spell DARF.
    CHECK_EQ(std::memcmp(bytes.data(), "DARF", 4), 0);
    CHECK_EQ(FR_APP_DESC_OFFSET, 288u);
    CHECK_EQ(fr::ota::kCheckBytes, 400u);
}

TEST(ota_skeleton_takes_frames_and_health_bits)
{
    fr::ota::Ota ota;
    fr::net::OtaReply reply;
    ota.on_boot();
    ota.on_frame(fr::proto::kKindOtaOffer, {}, reply);
    ota.health_set(fr::ota::kHealthCore | fr::ota::kHealthNet);
    CHECK(!reply.has());
    CHECK(!ota.busy());
}
