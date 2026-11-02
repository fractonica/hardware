// The streams' shared pieces (fr/stream/stream.hpp): the endpoint's dotted IPv4 and the runtime's StreamHost.
#include "fr/stream/stream.hpp"

#include <cstdio>

namespace fr::stream {
namespace {

StreamHost *s_host = nullptr;

}  // namespace

void format_ipv4(uint32_t ipv4, char *out, size_t len)
{
    std::snprintf(out, len, "%u.%u.%u.%u", static_cast<unsigned>(ipv4 >> 24), static_cast<unsigned>((ipv4 >> 16) & 0xFF),
                  static_cast<unsigned>((ipv4 >> 8) & 0xFF), static_cast<unsigned>(ipv4 & 0xFF));
}

bool parse_ipv4(const char *text, uint32_t &out)
{
    if (text == nullptr) {
        return false;
    }
    uint32_t v = 0;
    const char *p = text;
    for (int part = 0; part < 4; ++part) {
        if (*p < '0' || *p > '9') {
            return false;
        }
        uint32_t octet = 0;
        int digits = 0;
        while (*p >= '0' && *p <= '9') {
            octet = octet * 10 + static_cast<uint32_t>(*p - '0');
            if (++digits > 3 || octet > 255) {
                return false;
            }
            ++p;
        }
        v = v << 8 | octet;
        if (part < 3) {
            if (*p != '.') {
                return false;
            }
            ++p;
        }
    }
    if (*p != '\0') {
        return false;
    }
    out = v;
    return true;
}

void set_stream_host(StreamHost *host)
{
    s_host = host;
}

StreamHost *stream_host()
{
    return s_host;
}

}  // namespace fr::stream
