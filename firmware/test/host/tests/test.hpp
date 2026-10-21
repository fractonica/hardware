// Minimal self-registering test framework for the host suite: no third-party code, no exceptions.
//   TEST(name) { CHECK(x); CHECK_EQ(a, b); CHECK_BYTES(span, frt::from_hex("ac 02")); REQUIRE(ok); }
// REQUIRE/REQUIRE_EQ return from the enclosing function, so use them only in TEST bodies or void helpers.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <expected>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace frt {

using TestFn = void (*)();

struct Registrar {
    Registrar(const char *name, TestFn fn, const char *file, int line);
};

/** Records a failed check of the running test and prints it; returns false. */
bool fail(const char *file, int line, const std::string &msg);

std::string hex(std::span<const uint8_t> b);
/** "ac 02" or "ac02" -> bytes; whitespace is ignored. */
std::vector<uint8_t> from_hex(std::string_view h);

template <class T>
constexpr bool is_plain_int = std::is_integral_v<T> && !std::is_same_v<T, bool> && !std::is_same_v<T, char> &&
                              !std::is_same_v<T, wchar_t> && !std::is_same_v<T, char8_t> &&
                              !std::is_same_v<T, char16_t> && !std::is_same_v<T, char32_t>;

template <class T>
std::string show(const T &v)
{
    if constexpr (std::is_same_v<T, bool>) {
        return v ? "true" : "false";
    } else if constexpr (std::is_enum_v<T>) {
        return "enum " + std::to_string(static_cast<long long>(std::to_underlying(v)));
    } else if constexpr (is_plain_int<T>) {
        if constexpr (std::is_signed_v<T>) {
            return std::to_string(static_cast<long long>(v));
        } else {
            return std::to_string(static_cast<unsigned long long>(v));
        }
    } else if constexpr (std::is_floating_point_v<T>) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.9g", static_cast<double>(v));
        return buf;
    } else if constexpr (std::is_convertible_v<const T &, std::string_view>) {
        return "\"" + std::string(std::string_view(v)) + "\"";
    } else if constexpr (std::is_convertible_v<const T &, std::span<const uint8_t>>) {
        return "[" + hex(std::span<const uint8_t>(v)) + "]";
    } else {
        return "<value>";
    }
}

template <class A, class B>
bool equal(const A &a, const B &b)
{
    if constexpr (is_plain_int<A> && is_plain_int<B>) {
        return std::cmp_equal(a, b);
    } else if constexpr (std::is_convertible_v<const A &, std::string_view> &&
                         std::is_convertible_v<const B &, std::string_view>) {
        return std::string_view(a) == std::string_view(b);
    } else {
        return a == b;
    }
}

template <class A, class B>
bool check_eq(const A &a, const B &b, const char *ea, const char *eb, const char *file, int line)
{
    if (equal(a, b)) {
        return true;
    }
    return fail(file, line, std::string("CHECK_EQ(") + ea + ", " + eb + ")\n      left:  " + show(a) + "\n      right: " + show(b));
}

bool check_bytes(std::span<const uint8_t> a, std::span<const uint8_t> b, const char *ea, const char *eb, const char *file,
                 int line);

}  // namespace frt

#define TEST(name)                                                                                    \
    static void frt_test_##name();                                                                    \
    static const ::frt::Registrar frt_reg_##name{#name, frt_test_##name, __FILE__, __LINE__};         \
    static void frt_test_##name()

#define CHECK(cond) (static_cast<bool>(cond) ? true : ::frt::fail(__FILE__, __LINE__, "CHECK(" #cond ")"))
#define CHECK_EQ(a, b) ::frt::check_eq((a), (b), #a, #b, __FILE__, __LINE__)
#define CHECK_BYTES(a, b) ::frt::check_bytes((a), (b), #a, #b, __FILE__, __LINE__)
#define REQUIRE(cond)     \
    do {                  \
        if (!CHECK(cond)) \
            return;       \
    } while (0)
#define REQUIRE_EQ(a, b)     \
    do {                     \
        if (!CHECK_EQ(a, b)) \
            return;          \
    } while (0)
