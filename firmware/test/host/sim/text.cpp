// The kit's text helpers (design m2-c2 D2): JSON escaping, hex, words and numbers, as net_node.cpp had them. No
// exceptions (-fno-exceptions), so numbers go through strtoul after a digit check, never std::stoi.
#include <algorithm>
#include <cstdio>
#include <cstdlib>

#include "sim/out.hpp"

namespace frsim {

std::string json_text(std::string_view s)
{
    std::string out;
    for (const char ch : s) {
        const auto c = static_cast<unsigned char>(ch);
        if (c == '"' || c == '\\') {
            out += '\\';
            out += ch;
        } else if (c < 0x20) {
            char esc[8];
            std::snprintf(esc, sizeof(esc), "\\u%04x", c);
            out += esc;
        } else {
            out += ch;
        }
    }
    return out;
}

std::string hex(std::span<const uint8_t> b)
{
    static constexpr char kDigits[] = "0123456789abcdef";
    std::string s;
    s.reserve(b.size() * 2);
    for (const uint8_t v : b) {
        s += kDigits[v >> 4];
        s += kDigits[v & 15];
    }
    return s;
}

bool parse_hex(std::string_view s, std::span<uint8_t> out)
{
    if (s.size() != out.size() * 2) {
        return false;
    }
    for (size_t i = 0; i < out.size(); ++i) {
        char byte[3] = {s[2 * i], s[2 * i + 1], 0};
        char *end = nullptr;
        out[i] = static_cast<uint8_t>(std::strtoul(byte, &end, 16));
        if (end != byte + 2) {
            return false;
        }
    }
    return true;
}

std::string_view next_word(std::string_view &s)
{
    while (!s.empty() && s.front() == ' ') {
        s.remove_prefix(1);
    }
    const size_t sp = std::min(s.find(' '), s.size());
    const std::string_view w = s.substr(0, sp);
    s.remove_prefix(sp);
    while (!s.empty() && s.front() == ' ') {
        s.remove_prefix(1);
    }
    return w;
}

bool parse_u32(std::string_view s, uint32_t lo, uint32_t hi, uint32_t &out)
{
    if (s.empty() || s.size() > 9 || s.find_first_not_of("0123456789") != std::string_view::npos) {
        return false;
    }
    out = static_cast<uint32_t>(std::strtoul(std::string(s).c_str(), nullptr, 10));
    return out >= lo && out <= hi;
}

std::string sformat(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    std::string s = vsformat(fmt, ap);
    va_end(ap);
    return s;
}

std::string vsformat(const char *fmt, va_list ap)
{
    char small[512];
    va_list again;
    va_copy(again, ap);
    const int n = std::vsnprintf(small, sizeof(small), fmt, ap);
    if (n < 0) {
        va_end(again);
        return {};
    }
    if (static_cast<size_t>(n) < sizeof(small)) {
        va_end(again);
        return std::string(small, static_cast<size_t>(n));
    }
    std::string s(static_cast<size_t>(n) + 1, '\0');
    std::vsnprintf(s.data(), s.size(), fmt, again);
    va_end(again);
    s.resize(static_cast<size_t>(n));
    return s;
}

}  // namespace frsim
