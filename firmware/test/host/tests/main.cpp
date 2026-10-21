// Runs every registered TEST. Usage: fr_host_tests [substring-filter]
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "tests/test.hpp"

namespace frt {
namespace {

struct Test {
    const char *name;
    TestFn fn;
    const char *file;
    int line;
};

std::vector<Test> &registry()
{
    static std::vector<Test> tests;
    return tests;
}

const Test *g_current = nullptr;
int g_failures = 0;

}  // namespace

Registrar::Registrar(const char *name, TestFn fn, const char *file, int line)
{
    registry().push_back({name, fn, file, line});
}

bool fail(const char *file, int line, const std::string &msg)
{
    ++g_failures;
    std::printf("  %s:%d: %s%s%s\n", file, line, g_current ? "[" : "", g_current ? g_current->name : "",
                g_current ? "] " : "");
    std::printf("    %s\n", msg.c_str());
    return false;
}

std::string hex(std::span<const uint8_t> b)
{
    std::string out;
    char buf[4];
    for (size_t i = 0; i < b.size(); ++i) {
        std::snprintf(buf, sizeof(buf), i ? " %02x" : "%02x", b[i]);
        out += buf;
    }
    return out;
}

std::vector<uint8_t> from_hex(std::string_view h)
{
    std::vector<uint8_t> out;
    int hi = -1;
    for (const char c : h) {
        if (std::isspace(static_cast<unsigned char>(c))) {
            continue;
        }
        const int v = std::isdigit(static_cast<unsigned char>(c)) ? c - '0' : std::tolower(static_cast<unsigned char>(c)) - 'a' + 10;
        if (hi < 0) {
            hi = v;
        } else {
            out.push_back(static_cast<uint8_t>(hi << 4 | v));
            hi = -1;
        }
    }
    return out;
}

bool check_bytes(std::span<const uint8_t> a, std::span<const uint8_t> b, const char *ea, const char *eb, const char *file,
                 int line)
{
    if (a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin())) {
        return true;
    }
    return fail(file, line, std::string("CHECK_BYTES(") + ea + ", " + eb + ")\n      left:  [" + hex(a) + "]\n      right: [" + hex(b) + "]");
}

}  // namespace frt

int main(int argc, char **argv)
{
    using frt::registry;
    const char *filter = argc > 1 ? argv[1] : nullptr;
    // Static registration order across files is unspecified; run in a stable order.
    auto tests = registry();
    std::sort(tests.begin(), tests.end(), [](const auto &a, const auto &b) {
        const int f = std::strcmp(a.file, b.file);
        return f != 0 ? f < 0 : a.line < b.line;
    });
    int passed = 0;
    int failed = 0;
    for (const auto &t : tests) {
        if (filter && !std::strstr(t.name, filter)) {
            continue;
        }
        frt::g_current = &t;
        const int before = frt::g_failures;
        t.fn();
        if (frt::g_failures == before) {
            ++passed;
        } else {
            ++failed;
            std::printf("FAIL %s\n", t.name);
        }
    }
    frt::g_current = nullptr;
    std::printf("host tests: %d passed, %d failed\n", passed, failed);
    return failed == 0 && passed > 0 ? 0 : 1;
}
