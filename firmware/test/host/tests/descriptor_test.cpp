// The node descriptor fr_core builds (spec 07 §7.4, design c3 §2): byte for byte the shared golden vector
// (schema/vectors/messages.json `Descriptor.c6_pad`), whose FNV-1a 32 is HELLO's descriptor_hash, and the
// limits it refuses instead of truncating.
#include <vector>

#include "fr/core/descriptor.hpp"
#include "fr/hash.hpp"
#include "messages.hpp"
#include "tests/test.hpp"

namespace {

/** A capability that only describes itself: fixed id, version and traits bytes. */
class StubCap final : public fr::cap::Capability
{
public:
    StubCap(uint16_t id, fr::cap::Version v, std::vector<uint8_t> traits) : id_(id), v_(v), traits_(std::move(traits)) {}

    uint16_t cap_id() const override { return id_; }
    fr::cap::Version version() const override { return v_; }
    const char *type_name() const override { return "fr.stub"; }
    fr::Status dispatch(uint8_t, std::span<const uint8_t>, fr::cap::Reply &) override
    {
        return std::unexpected(fr::Err::unsupported);
    }
    void report_all() override {}
    void encode_traits(fr::wire::Writer &w) const override { w.raw(traits_); }

private:
    uint16_t id_;
    fr::cap::Version v_;
    std::vector<uint8_t> traits_;
};

constexpr const char *kC6PadHex =
    "080112083f2a9c01b2d4001118a089f9e009220663362d7061642a11657370333263362d73757065726d696e69320d08011001"
    "1880022204626f6f7432150802100218800222067374617475732a0408011001";

fr::core::DescriptorSource c6_pad_source(const std::vector<uint8_t> &prefix)
{
    return {.fw_id_prefix = prefix, .catalog_hash = 2619229344u, .profile = "c6-pad", .board = "esp32c6-supermini"};
}

}  // namespace

TEST(descriptor_matches_the_golden_vector_in_port_order_without_system_ports)
{
    StubCap node(0x00F0, {1, 0}, {});
    StubCap button(0x0001, {1, 0}, {});
    StubCap led(0x0002, {1, 0}, frt::from_hex("08011001"));
    StubCap diag(0x00F2, {1, 0}, {});
    // The board table need not be in port order; node and diag are the same on every device; a port
    // whose init failed is still part of the firmware it describes.
    fr::PortEntry ports[] = {
        {0, "node", &node, true}, {2, "status", &led, true}, {1, "boot", &button, false}, {241, "diag", &diag, true}};
    auto prefix = frt::from_hex("3f2a9c01b2d40011");
    uint8_t out[fr::proto::Descriptor::kMaxSize];
    size_t n = fr::core::build_descriptor(c6_pad_source(prefix), ports, out);
    CHECK_BYTES(std::span<const uint8_t>(out, n), frt::from_hex(kC6PadHex));
    CHECK_EQ(n, 83u);
    CHECK_EQ(fr::wire::descriptor_hash({out, n}), 0x347fd1c7u);

    auto d = fr::proto::decode_descriptor({out, n});
    REQUIRE(d.has_value());
    REQUIRE_EQ(d->caps.size(), 2u);
    CHECK_EQ(d->caps[0].port, 1);
    CHECK_EQ(d->caps[1].name, "status");
    CHECK_EQ(d->caps[1].version, 0x0100);
}

TEST(descriptor_skips_ports_without_a_capability)
{
    StubCap led(0x0002, {1, 2}, {});
    fr::PortEntry ports[] = {{1, "boot", nullptr, false}, {2, "status", &led, true}};
    auto prefix = frt::from_hex("0011223344556677");
    uint8_t out[fr::proto::Descriptor::kMaxSize];
    size_t n = fr::core::build_descriptor(c6_pad_source(prefix), ports, out);
    auto d = fr::proto::decode_descriptor({out, n});
    REQUIRE(n > 0 && d.has_value());
    REQUIRE_EQ(d->caps.size(), 1u);
    CHECK_EQ(d->caps[0].version, 0x0102);
    CHECK_EQ(d->frame_version, 1);
}

TEST(descriptor_refuses_what_it_cannot_hold)
{
    auto prefix = frt::from_hex("3f2a9c01b2d40011");
    StubCap led(0x0002, {1, 0}, frt::from_hex("08011001"));
    fr::PortEntry one[] = {{2, "status", &led, true}};
    uint8_t small[16];
    CHECK_EQ(fr::core::build_descriptor(c6_pad_source(prefix), one, small), 0u);

    // DescriptorCap.traits holds 16 bytes.
    StubCap fat(0x0002, {1, 0}, std::vector<uint8_t>(fr::core::kMaxTraitsBytes + 1, 0x08));
    fr::PortEntry fat_port[] = {{2, "status", &fat, true}};
    uint8_t out[fr::proto::Descriptor::kMaxSize];
    CHECK_EQ(fr::core::build_descriptor(c6_pad_source(prefix), fat_port, out), 0u);

    // More instances than a Descriptor carries.
    StubCap cap(0x0001, {1, 0}, {});
    std::vector<fr::PortEntry> many;
    for (uint8_t p = 1; p <= 17; ++p) {
        many.push_back({p, "x", &cap, true});
    }
    CHECK_EQ(fr::core::build_descriptor(c6_pad_source(prefix), many, out), 0u);
    many.pop_back();
    CHECK(fr::core::build_descriptor(c6_pad_source(prefix), many, out) > 0);
}
