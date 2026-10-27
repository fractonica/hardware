// T-CODEC parity: every fuzz target runs the same 10^4 cases as its TS twin and must reach the same
// digest, i.e. the C++ and TS decoders accept and reject exactly the same inputs with the same codes.
// The pins below equal the `pinned` values in packages/protocol/test/wire.fuzz.test.ts.
#include <cstring>

#include "fuzz/fuzz.hpp"
#include "tests/test.hpp"

namespace {

struct Pin {
    const char *target;
    uint32_t digest;
};

constexpr Pin PINS[] = {
    {"wire.reader", 0xec91243a},
    {"wire.envelope", 0x5dd26f64},  // M2-C4: EXT exec_at_hub_us (0x82) became a known u32
    {"wire.serial_line", 0x2e2fabaf},
    {"wire.base64url", 0xfd98a19c},
};

constexpr uint64_t PINNED_N = 10000;

}  // namespace

TEST(fuzz_digests_match_ts)
{
    for (const auto &pin : PINS) {
        const frf::Target *found = nullptr;
        for (const auto &t : frf::targets()) {
            if (std::strcmp(t.name, pin.target) == 0) {
                found = &t;
            }
        }
        if (!CHECK(found != nullptr)) {
            continue;
        }
        if (!CHECK_EQ(frf::run(*found, PINNED_N), pin.digest)) {
            std::printf("    target %s\n", pin.target);
        }
    }
}
