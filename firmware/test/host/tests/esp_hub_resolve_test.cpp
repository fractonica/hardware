// Where the node looks for the hub (spec 05 §5.12.5, design c6 D26; fr_net/src/esp/hub_resolve.hpp), which
// hub_link.cpp follows on target: hub_host (a literal, mDNS for `.local`, else DNS), the address it last had,
// fr_ident's hub_ip, and only then the hub's `_fractonica._tcp` advert: PTR, SRV/TXT when the PTR answer did
// not carry them, then the SRV target's address, at the SRV port.
#include <cstdio>
#include <optional>
#include <string>
#include <vector>

#include "../../../components/fr_net/src/esp/hub_resolve.hpp"
#include "tests/test.hpp"

namespace {

using fr::net::esp::detail::Advert;
using fr::net::esp::detail::HubAddress;
using fr::net::esp::detail::How;
using fr::net::esp::detail::ipv4;
using fr::net::esp::detail::parse_ipv4;
using fr::net::esp::detail::Resolved;

/** Answers from tables, and every query in order ("a:<name>", "dns:<host>", "ptr", "srv:<instance>"). */
class FakeResolver final : public fr::net::esp::detail::Resolver
{
public:
    uint32_t mdns_a(const char *name) override
    {
        log.push_back(std::string("a:") + name);
        for (const auto &[n, ip] : a) {
            if (n == name) {
                return ip;
            }
        }
        return 0;
    }
    uint32_t dns(const char *host) override
    {
        log.push_back(std::string("dns:") + host);
        return dns_ip;
    }
    bool browse(Advert &out) override
    {
        log.emplace_back("ptr");
        if (!ptr) {
            return false;
        }
        out = *ptr;
        return true;
    }
    bool srv(Advert &out) override
    {
        log.push_back(std::string("srv:") + out.instance);
        if (srv_host.empty()) {
            return false;
        }
        std::snprintf(out.host, sizeof(out.host), "%s", srv_host.c_str());
        out.port = srv_port;
        return true;
    }

    std::vector<std::pair<std::string, uint32_t>> a;
    uint32_t dns_ip = 0;
    std::optional<Advert> ptr;
    std::string srv_host;
    uint16_t srv_port = 0;
    std::vector<std::string> log;
};

const uint32_t kHub = ipv4(192, 168, 1, 20);
const uint32_t kMoved = ipv4(192, 168, 1, 31);

Advert instance(const char *name)
{
    Advert a;
    std::snprintf(a.instance, sizeof(a.instance), "%s", name);
    return a;
}

}  // namespace

TEST(esp_hub_resolve_parses_address_literals)
{
    CHECK_EQ(parse_ipv4("192.168.1.20"), kHub);
    CHECK_EQ(parse_ipv4("10.0.0.1"), ipv4(10, 0, 0, 1));
    for (const char *bad : {"", "192.168.1", "192.168.1.256", "192.168.1.20.5", "a.b.c.d", "192.168.1.20 ", "hub.local"}) {
        CHECK_EQ(parse_ipv4(bad), 0u);
    }
}

TEST(esp_hub_resolve_hub_host_first)
{
    HubAddress h;
    h.configure(7421, ipv4(10, 0, 0, 9));
    FakeResolver r;
    r.a = {{"dimas-mbp", kHub}};
    // A literal needs no lookup; a .local name goes to mDNS without its domain (any case); others to DNS.
    Resolved x = h.resolve("192.168.1.20", r);
    CHECK_EQ(x.ip, kHub);
    CHECK(x.how == How::literal);
    CHECK(r.log.empty());
    x = h.resolve("dimas-mbp.LOCAL", r);
    CHECK_EQ(x.ip, kHub);
    CHECK_EQ(x.port, 7421);
    CHECK(x.how == How::mdns);
    r.dns_ip = kMoved;
    x = h.resolve("hub.example", r);
    CHECK_EQ(x.ip, kMoved);
    CHECK(x.how == How::dns);
    CHECK(r.log == (std::vector<std::string>{"a:dimas-mbp", "dns:hub.example"}));
}

TEST(esp_hub_resolve_falls_back_to_the_last_address_then_hub_ip)
{
    HubAddress h;
    h.configure(7421, ipv4(10, 0, 0, 9));
    FakeResolver r;
    r.ptr = instance("Fractonica dimas-mbp");  // never asked: the fallbacks come first
    // No hub_host answer yet: fr_ident's hub_ip.
    Resolved x = h.resolve("dimas-mbp.local", r);
    CHECK_EQ(x.ip, ipv4(10, 0, 0, 9));
    CHECK(x.how == How::hub_ip);
    // Once it answered, its address outlives a silent spell (Local Network Privacy, a busy responder).
    r.a = {{"dimas-mbp", kHub}};
    CHECK(h.resolve("dimas-mbp.local", r).how == How::mdns);
    r.a.clear();
    x = h.resolve("dimas-mbp.local", r);
    CHECK_EQ(x.ip, kHub);
    CHECK(x.how == How::last);
    for (const std::string &q : r.log) {
        CHECK(q != "ptr");
    }
}

TEST(esp_hub_resolve_finds_the_advert_when_nothing_else_does)
{
    // A node with no hub_host, no address yet and no hub_ip (an UNASSIGNED C6 on the dev network, or one
    // whose hub_host stopped resolving before it ever did): the hub's own advert.
    HubAddress h;
    h.configure(7421, 0);
    FakeResolver r;
    Advert full = instance("Fractonica dimas-mbp");
    std::snprintf(full.host, sizeof(full.host), "dimas-mbp.local");
    full.port = 7521;
    full.ip = kHub;
    r.ptr = full;
    // The PTR answer carried SRV and A (macOS sends them as additional records): one query.
    Resolved x = h.resolve("", r);
    CHECK_EQ(x.ip, kHub);
    CHECK_EQ(x.port, 7521);  // the SRV port, not the configured one
    CHECK(x.how == How::advert);
    CHECK(r.log == std::vector<std::string>{"ptr"});
    // PTR alone: SRV of the instance, then the target's A record, without ".local".
    r.log.clear();
    r.ptr = instance("Fractonica dimas-mbp");
    r.srv_host = "dimas-mbp.local";
    r.srv_port = 7421;
    r.a = {{"dimas-mbp", kMoved}};
    x = h.resolve("", r);
    CHECK_EQ(x.ip, kMoved);
    CHECK_EQ(x.port, 7421);
    CHECK(r.log == (std::vector<std::string>{"ptr", "srv:Fractonica dimas-mbp", "a:dimas-mbp"}));
    // The advert's address is no hub_host address: every attempt that gets this far asks again, so a hub
    // that moved is found at its new address.
    r.log.clear();
    r.a = {{"dimas-mbp", kHub}};
    CHECK_EQ(h.resolve("", r).ip, kHub);
    CHECK_EQ(r.log.front(), std::string("ptr"));
    // A hub_host that resolves still wins over it.
    r.a.push_back({"other", kMoved});
    x = h.resolve("other.local", r);
    CHECK(x.how == How::mdns);
    CHECK_EQ(x.port, 7421);
}

TEST(esp_hub_resolve_advert_failures_find_nothing)
{
    HubAddress h;
    h.configure(7421, 0);
    FakeResolver r;
    // Nobody answers the PTR query.
    Resolved x = h.resolve("hub.local", r);
    CHECK_EQ(x.ip, 0u);
    CHECK(x.how == How::none);
    CHECK(r.log == (std::vector<std::string>{"a:hub", "ptr"}));
    // An instance whose SRV never answers.
    r.ptr = instance("Fractonica x");
    CHECK_EQ(h.resolve("", r).ip, 0u);
    // An SRV whose target has no address.
    r.srv_host = "x.local";
    r.srv_port = 7421;
    CHECK_EQ(h.resolve("", r).ip, 0u);
    CHECK_EQ(r.log.back(), std::string("a:x"));
}
