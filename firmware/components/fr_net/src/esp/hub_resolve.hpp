// Where the hub is (spec 05 §5.12.5, design c6 D26), IDF-free so that hub_link.cpp on target and the host suite
// run the same chain: hub_host (an address literal, mDNS for a `.local` name, else DNS), then the address
// hub_host last resolved to this boot, then fr_ident's hub_ip, and only when all three fail the hub's own
// advert: an mDNS PTR query for `_fractonica._tcp`, the SRV (and TXT) of the instance it names, then the SRV
// target's address and the SRV port. Every lookup goes through Resolver, which hub_link.cpp implements with
// lwIP and espressif/mdns and the tests fake. Private to fr_net/src/esp.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace fr::net::esp::detail {

/** An IPv4 address in network order (lwIP's s_addr), from its four bytes. */
inline uint32_t ipv4(uint8_t a, uint8_t b, uint8_t c, uint8_t d)
{
    const std::array<uint8_t, 4> bytes{a, b, c, d};
    uint32_t ip = 0;
    std::memcpy(&ip, bytes.data(), sizeof(ip));
    return ip;
}

/** A dotted-quad literal ("192.168.1.20") in network order; 0 when `s` is not one. */
inline uint32_t parse_ipv4(const char *s)
{
    uint8_t q[4] = {};
    for (int i = 0; i < 4; ++i) {
        unsigned v = 0;
        int digits = 0;
        while (*s >= '0' && *s <= '9' && digits < 3) {
            v = v * 10 + static_cast<unsigned>(*s++ - '0');
            ++digits;
        }
        if (digits == 0 || v > 255 || *s != (i < 3 ? '.' : '\0')) {
            return 0;
        }
        q[i] = static_cast<uint8_t>(v);
        s += i < 3 ? 1 : 0;
    }
    return ipv4(q[0], q[1], q[2], q[3]);
}

/** One `_fractonica._tcp` instance as far as the answers so far describe it; strings NUL-terminated. */
struct Advert {
    char instance[64] = {};  // the PTR target ("Fractonica dimas-mbp")
    char host[64] = {};      // the SRV target, with or without ".local"; empty: no SRV yet
    uint16_t port = 0;       // the SRV port (the hub's node port, 7421); 0: no SRV yet
    uint32_t ip = 0;         // the SRV target's IPv4 in network order; 0: no A record yet
};

/** The lookups the chain makes; each may block for its timeout (the fr_net task, between connections). */
class Resolver
{
public:
    /** mDNS A of `name`, given without ".local" (espressif/mdns takes it so); 0 for no answer. */
    virtual uint32_t mdns_a(const char *name) = 0;
    /** DNS A of `host`; 0 for no answer. */
    virtual uint32_t dns(const char *host) = 0;
    /** mDNS PTR `_fractonica._tcp.local`: the first instance, with whatever SRV, TXT and A records the answer
     * carried along (a macOS responder sends them all); false when nobody answers. */
    virtual bool browse(Advert &out) = 0;
    /** mDNS SRV of `out.instance`: fills host and port; false for no answer. */
    virtual bool srv(Advert &out) = 0;

protected:
    ~Resolver() = default;
};

/** How resolve() found the address, for the log line. */
enum class How : uint8_t { none, literal, mdns, dns, last, hub_ip, advert };

constexpr const char *how_name(How h)
{
    switch (h) {
    case How::none:
        return "none";
    case How::literal:
        return "literal";
    case How::mdns:
        return "mdns";
    case How::dns:
        return "dns";
    case How::last:
        return "last address";
    case How::hub_ip:
        return "hub_ip";
    case How::advert:
        return "_fractonica._tcp";
    }
    return "?";
}

/** The hub's address and port; ip 0: none found (the link stays down until the next attempt). */
struct Resolved {
    uint32_t ip = 0;
    uint16_t port = 0;
    How how = How::none;
};

/**
 * The chain, with the one thing it keeps between attempts: the address hub_host last resolved to. An address
 * found through the advert is not kept as hub_host's: it is looked up again on each attempt that gets that
 * far, so a hub that moved is found again, and a hub_host that resolves later still wins.
 */
class HubAddress
{
public:
    /** The provisioned port (CONFIG_FR_HUB_PORT) and fr_ident's hub_ip (network order, 0: none). */
    void configure(uint16_t port, uint32_t hub_ip)
    {
        port_ = port;
        fallback_ip_ = hub_ip;
    }

    Resolved resolve(const char *hub_host, Resolver &r)
    {
        const size_t len = hub_host != nullptr ? std::strlen(hub_host) : 0;
        Resolved out{.ip = 0, .port = port_, .how = How::none};
        if (len > 0 && (out.ip = parse_ipv4(hub_host)) != 0) {
            out.how = How::literal;
        } else if (is_local(hub_host, len)) {
            char name[kNameMax];
            copy_name(name, hub_host, len - kLocalSuffixLen);
            if ((out.ip = r.mdns_a(name)) != 0) {
                out.how = How::mdns;
            }
        } else if (len > 0 && (out.ip = r.dns(hub_host)) != 0) {
            out.how = How::dns;
        }
        if (out.ip != 0) {
            last_ip_ = out.ip;
            return out;
        }
        if (last_ip_ != 0) {
            return {.ip = last_ip_, .port = port_, .how = How::last};
        }
        if (fallback_ip_ != 0) {
            return {.ip = fallback_ip_, .port = port_, .how = How::hub_ip};
        }
        return advert(r);
    }

private:
    static constexpr size_t kNameMax = 64;
    static constexpr size_t kLocalSuffixLen = 6;  // ".local"

    static bool is_local(const char *s, size_t len)
    {
        if (len <= kLocalSuffixLen) {
            return false;
        }
        const char *suffix = s + len - kLocalSuffixLen;
        static constexpr char kLocal[] = ".local";
        for (size_t i = 0; i < kLocalSuffixLen; ++i) {
            const char c = suffix[i] >= 'A' && suffix[i] <= 'Z' ? static_cast<char>(suffix[i] - 'A' + 'a') : suffix[i];
            if (c != kLocal[i]) {
                return false;
            }
        }
        return true;
    }

    static void copy_name(char (&out)[kNameMax], const char *s, size_t n)
    {
        n = n < kNameMax - 1 ? n : kNameMax - 1;
        std::memcpy(out, s, n);
        out[n] = '\0';
    }

    /** Design c6 D26: PTR, then SRV/TXT unless the PTR answer carried them, then the SRV target's A record. */
    Resolved advert(Resolver &r)
    {
        Advert a;
        if (!r.browse(a)) {
            return {};
        }
        if ((a.host[0] == '\0' || a.port == 0) && !r.srv(a)) {
            return {};
        }
        if (a.host[0] == '\0' || a.port == 0) {
            return {};  // an SRV without a target or port is no address
        }
        if (a.ip == 0) {
            const size_t len = std::strlen(a.host);
            char name[kNameMax];
            copy_name(name, a.host, is_local(a.host, len) ? len - kLocalSuffixLen : len);
            a.ip = r.mdns_a(name);
        }
        if (a.ip == 0) {
            return {};
        }
        return {.ip = a.ip, .port = a.port, .how = How::advert};
    }

    uint16_t port_ = 7421;
    uint32_t fallback_ip_ = 0;  // fr_ident hub_ip
    uint32_t last_ip_ = 0;      // hub_host's last address this boot
};

}  // namespace fr::net::esp::detail
