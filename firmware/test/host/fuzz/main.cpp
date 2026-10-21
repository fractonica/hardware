// Fuzz driver (T-CODEC): runs every registered target under ASan/UBSan.
// Usage: fr_host_fuzz [cases-per-target, default 10000] [substring-filter]
#include <chrono>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "fuzz/fuzz.hpp"

int main(int argc, char **argv)
{
    uint64_t n = 10000;
    if (argc > 1) {
        n = std::strtoull(argv[1], nullptr, 10);
        if (n == 0) {
            std::fprintf(stderr, "usage: %s [cases] [filter]\n", argv[0]);
            return 64;
        }
    }
    const char *filter = argc > 2 ? argv[2] : nullptr;
    int ran = 0;
    for (const auto &t : frf::targets()) {
        if (filter && !std::strstr(t.name, filter)) {
            continue;
        }
        const auto t0 = std::chrono::steady_clock::now();
        const uint32_t digest = frf::run(t, n);
        const double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        std::printf("%-32s %" PRIu64 " cases  digest %08x  %.1f s\n", t.name, n, digest, s);
        // The gate run pipes stdout (host-test.mjs --expect); show each target as it finishes.
        std::fflush(stdout);
        ++ran;
    }
    std::printf("fuzz: %d targets, no failures\n", ran);
    return ran > 0 ? 0 : 1;
}
