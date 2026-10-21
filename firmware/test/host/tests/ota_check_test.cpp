// CHECK (spec 06 §6.6, design c4 §3): the image fields at their 06 §6.8 offsets, the REJECT code each
// failure earns, which flags lift which checks, and the version rule (leading semver only; a non-semver
// label is never a downgrade).
#include "tests/ota_fakes.hpp"

namespace {

using frt::ImageSpec;
using frt::make_image;
using fr::ota::Reject;

std::optional<Reject> check(const ImageSpec &s, uint32_t flags = 0)
{
    const auto img = make_image(s);
    return fr::ota::check_image(std::span<const uint8_t>(img.data(), fr::ota::kCheckBytes), flags,
                                frt::default_running(), frt::default_ident());
}

}  // namespace

TEST(ota_semver_takes_the_leading_triple)
{
    using fr::ota::leading_semver;
    using fr::ota::Semver;
    CHECK(leading_semver("0.1.0+g1a2b3c4.dirty.9f2c1e07") == (Semver{0, 1, 0}));
    CHECK(leading_semver("v1.2.3-rc1") == (Semver{1, 2, 3}));
    CHECK(leading_semver("10.20.30") == (Semver{10, 20, 30}));
    CHECK(leading_semver("1.2.3.dirty") == (Semver{1, 2, 3}));
    CHECK(!leading_semver("1.2"));
    CHECK(!leading_semver("dev"));
    CHECK(!leading_semver(""));
    CHECK(!leading_semver("1.2.3x"));
    CHECK(!leading_semver("1..3"));
    CHECK(!leading_semver("99999999999.0.0"));
}

TEST(ota_downgrade_compares_semver_only)
{
    using fr::ota::is_downgrade;
    CHECK(is_downgrade("0.1.0", "0.2.0"));
    CHECK(is_downgrade("0.9.9+dirty", "1.0.0"));
    CHECK(is_downgrade("1.2.2", "1.2.10"));  // numerically, not as text
    CHECK(!is_downgrade("0.2.0", "0.1.0"));
    CHECK(!is_downgrade("0.1.0+g2", "0.1.0+g1"));  // the same version: a rebuild is no downgrade
    CHECK(!is_downgrade("dev", "1.0.0"));
    CHECK(!is_downgrade("0.1.0", "unknown"));
}

TEST(ota_check_image_accepts_a_matching_image)
{
    CHECK(!check({}));
    // The fault byte is not CHECK's business: a fault build is installed like any other (T-OTA).
    CHECK(!check({.fault = 1}));
}

TEST(ota_check_image_offsets_match_esp_image_header)
{
    // esp_image_header_t (packed): chip_id at 12 (u16), min_chip_rev at 14, min/max_chip_rev_full at 15/17,
    // hash_appended at 23; esp_app_desc_t at 32 with its version at +16; fr_app_desc_t at 288.
    const auto img = make_image({.chip_id = 0x0D, .min_rev = 0x0102, .max_rev = 0x0304});
    CHECK_EQ(img[12], 0x0D);
    CHECK_EQ(img[13], 0x00);
    CHECK_EQ(img[15], 0x02);
    CHECK_EQ(img[16], 0x01);
    CHECK_EQ(img[17], 0x04);
    CHECK_EQ(img[18], 0x03);
    CHECK_EQ(img[23], 1);
    CHECK_EQ(std::memcmp(img.data() + 32, "\x32\x54\xcd\xab", 4), 0);
    CHECK_EQ(std::memcmp(img.data() + 48, "0.2.0", 5), 0);
    CHECK_EQ(std::memcmp(img.data() + 288, "DARF", 4), 0);
    CHECK_EQ(std::memcmp(img.data() + 288 + 12, "esp32c6-supermini", 17), 0);
}

TEST(ota_check_image_bad_image)
{
    CHECK(check({.magic = 0xE8}) == Reject::bad_image);
    CHECK(check({.hash_appended = 0}) == Reject::bad_image);  // no appended digest: fw_id could never match
    CHECK(check({.esp_desc_magic = 0}) == Reject::bad_image);
    CHECK(check({.fr_magic = 0}) == Reject::bad_image);  // a non-Fractonica image
    const auto img = make_image({});
    CHECK(fr::ota::check_image(std::span<const uint8_t>(img.data(), fr::ota::kCheckBytes - 1), 0,
                               frt::default_running(), frt::default_ident()) == Reject::bad_image);
    // FORCE never lifts the structure checks.
    CHECK(check({.fr_magic = 0}, fr::ota::kOfferForce) == Reject::bad_image);
}

TEST(ota_check_image_chip)
{
    CHECK(check({.chip_id = 5}) == Reject::chip);                // a C3 image on a C6
    CHECK(check({.min_rev = 2}) == Reject::chip);                // needs v0.2, this chip is v0.1
    CHECK(check({.max_rev = 0}) == std::nullopt);                // 0: no maximum (IDF's rule)
    CHECK(check({.max_rev = 0xFFFF}) == std::nullopt);           // 0xFFFF: no maximum
    CHECK(check({.min_rev = 1, .max_rev = 1}) == std::nullopt);  // the bounds are inclusive
    CHECK(check({.chip_id = 5}, fr::ota::kOfferForce) == Reject::chip);
    auto run = frt::default_running();
    run.chip_rev = 200;  // v2.0 against an image for up to v1.99
    const auto img = make_image({});
    CHECK(fr::ota::check_image(img, 0, run, frt::default_ident()) == Reject::chip);
}

TEST(ota_check_image_identity_unless_force)
{
    CHECK(check({.board = "esp32c3-supermini"}) == Reject::identity);
    CHECK(check({.profile = "c6-pad-mono"}) == Reject::identity);
    CHECK(check({.part = "fr-8mb-v1"}) == Reject::identity);
    CHECK(check({.profile = "c6-pad-x"}) == Reject::identity);  // not a prefix match
    CHECK(check({.profile = "c6-pad-mono"}, fr::ota::kOfferForce) == std::nullopt);
}

TEST(ota_check_image_downgrade_unless_allowed)
{
    CHECK(check({.version = "0.0.9"}) == Reject::downgrade);
    CHECK(check({.version = "0.0.9"}, fr::ota::kOfferAllowDowngrade) == std::nullopt);
    CHECK(check({.version = "0.0.9"}, fr::ota::kOfferForce) == Reject::downgrade);  // FORCE is not ALLOW_DOWNGRADE
    CHECK(check({.version = "0.1.0+other"}) == std::nullopt);
    CHECK(check({.version = "experiment"}) == std::nullopt);
}

TEST(ota_check_image_order_structure_chip_identity_version)
{
    // One code per image: the most fundamental failure wins.
    CHECK(check({.chip_id = 5, .board = "x"}) == Reject::chip);
    CHECK(check({.version = "0.0.1", .board = "x"}) == Reject::identity);
    CHECK(check({.chip_id = 5, .fr_magic = 0}) == Reject::bad_image);
}

TEST(ota_check_offer)
{
    const auto run = [] {
        auto r = frt::default_running();
        r.has_last_invalid = true;
        r.last_invalid_fw_id.fill(0x22);
        return r;
    }();
    std::array<uint8_t, 32> fw{};
    fw.fill(0x33);
    using fr::ota::check_offer;
    CHECK(check_offer(fw, 100'000, 0, run) == std::nullopt);
    CHECK(check_offer(fw, 0x1E0000, 0, run) == std::nullopt);  // exactly the slot
    CHECK(check_offer(fw, 0x1E0001, 0, run) == Reject::size);
    CHECK(check_offer(fw, 0x1E0001, fr::ota::kOfferForce, run) == Reject::size);
    CHECK(check_offer(fw, 399, 0, run) == Reject::bad_image);
    CHECK(check_offer(run.fw_id, 100'000, 0, run) == Reject::same_fw);
    CHECK(check_offer(run.last_invalid_fw_id, 100'000, 0, run) == Reject::same_fw);
    CHECK(check_offer(run.fw_id, 100'000, fr::ota::kOfferForce, run) == std::nullopt);
    CHECK(check_offer(run.last_invalid_fw_id, 100'000, fr::ota::kOfferForce, run) == std::nullopt);
    auto no_invalid = run;
    no_invalid.has_last_invalid = false;  // a stale digest without a last-invalid slot does not count
    CHECK(check_offer(run.last_invalid_fw_id, 100'000, 0, no_invalid) == std::nullopt);
}

TEST(ota_wire_values)
{
    // design c4 §3 and the hub's orchestrator agree on these numbers.
    CHECK_EQ(static_cast<int>(Reject::busy), 1);
    CHECK_EQ(static_cast<int>(Reject::chip), 2);
    CHECK_EQ(static_cast<int>(Reject::identity), 3);
    CHECK_EQ(static_cast<int>(Reject::size), 4);
    CHECK_EQ(static_cast<int>(Reject::same_fw), 5);
    CHECK_EQ(static_cast<int>(Reject::downgrade), 6);
    CHECK_EQ(static_cast<int>(Reject::bad_image), 7);
    CHECK_EQ(static_cast<int>(fr::ota::Phase::downloading), 1);
    CHECK_EQ(static_cast<int>(fr::ota::Phase::staged), 2);
    CHECK_EQ(static_cast<int>(fr::ota::Phase::rebooting), 3);
    CHECK_EQ(static_cast<int>(fr::ota::FailReason::download), 1);
    CHECK_EQ(static_cast<int>(fr::ota::FailReason::digest), 2);
    CHECK_EQ(static_cast<int>(fr::ota::FailReason::flash), 3);
    CHECK_EQ(static_cast<int>(fr::ota::RollbackReason::health_timeout), 1);
    CHECK_EQ(static_cast<int>(fr::ota::RollbackReason::crash), 2);
    CHECK_EQ(static_cast<int>(fr::ota::RollbackReason::unknown), 3);
    CHECK_EQ(fr::ota::kOfferForce, 1u);
    CHECK_EQ(fr::ota::kOfferDeferCommit, 2u);
    CHECK_EQ(fr::ota::kOfferAllowDowngrade, 4u);
}
