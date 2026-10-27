// A fleet node's hub links and the serial bridge (design m2-c2 D7; sim/links.hpp), on the wall-mode executor and real
// loopback sockets, with hub_link's timing scaled down so the suite stays short:
//   - Backoff: 0.25 -> 5 s doubling, the minimum again after a 10 s connection or reset();
//   - SendBuffer: lwIP's 5,760 B, in order, nothing before its due time;
//   - SimTcp: a refused hub backs off and starts over when IP comes back; the silent state (no FIN, nothing read or
//     written) and its RST after silent_rst_us; a stale connection closed at the next WELCOME instead; the hub's
//     close reconnects; the send buffer fills the TX FIFO behind a slow AP (queued());
//   - SimUdp: the shared socket and one of its own, the AP's loss, refused while IP is down;
//   - the bridge's wire (links/serial-bridge.ts): list, open, both ways, err, detach as an unplug.
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include "sim/ap.hpp"
#include "sim/executor.hpp"
#include "sim/links.hpp"
#include "sim/sim_core.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using frsim::Ap;
using frsim::ApConfig;
using frsim::Backoff;
using frsim::Executor;
using frsim::SendBuffer;
using frsim::SimCore;
using frsim::SimTcp;
using frsim::TcpTiming;
using frsim::TimeMode;

constexpr fr::net::Mac kMac{0x02, 0xf2, 0x00, 0x00, 0x00, 0x01};

/** hub_link's timing, 12.5x faster. */
TcpTiming fast()
{
    return {.backoff_min_us = 20'000,
            .backoff_max_us = 400'000,
            .stable_us = 800'000,
            .connect_timeout_us = 240'000,
            .silent_rst_us = 300'000,
            .sndbuf_bytes = 5760};
}

ApConfig quick_ap()
{
    ApConfig c;
    c.uplink_min_ms = c.uplink_max_ms = 0;
    c.downlink_min_ms = c.downlink_max_ms = 0;
    return c;
}

/** Runs the executor until `cond` or `ms` pass; the condition's last value. */
bool run_until(Executor &exec, const std::function<bool()> &cond, int ms)
{
    const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    while (!cond()) {
        if (std::chrono::steady_clock::now() > end) {
            return cond();
        }
        exec.run_for(5'000);
    }
    return true;
}

void run_ms(Executor &exec, int ms)
{
    run_until(exec, [] { return false; }, ms);
}

/** A loopback TCP listener the test accepts from, as the hub's node port. */
struct Listener {
    int fd = -1;
    uint16_t port = 0;
    Listener()
    {
        fd = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t len = sizeof(a);
        ::bind(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a));
        ::listen(fd, 8);
        ::getsockname(fd, reinterpret_cast<sockaddr *>(&a), &len);
        ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
        port = ntohs(a.sin_port);
    }
    ~Listener() { ::close(fd); }
    int accept_one() const
    {
        const int c = ::accept(fd, nullptr, nullptr);
        if (c >= 0) {
            ::fcntl(c, F_SETFL, ::fcntl(c, F_GETFL, 0) | O_NONBLOCK);
        }
        return c;
    }
};

/** A port nothing listens on: connect is refused. */
uint16_t closed_port()
{
    Listener l;
    return l.port;  // closed when `l` goes
}

/** What a non-blocking recv on `fd` says now: bytes, 0 (FIN), -EAGAIN, or -errno. */
ssize_t peek(int fd, std::string *into = nullptr)
{
    char buf[16384];
    const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
    if (n < 0) {
        return -errno;
    }
    if (into != nullptr) {
        into->append(buf, static_cast<size_t>(n));
    }
    return n;
}

/** A loopback UDP listener: each datagram's bytes and source port. */
struct UdpListener {
    int fd = -1;
    uint16_t port = 0;
    UdpListener()
    {
        fd = ::socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t len = sizeof(a);
        ::bind(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a));
        ::getsockname(fd, reinterpret_cast<sockaddr *>(&a), &len);
        ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
        port = ntohs(a.sin_port);
    }
    ~UdpListener() { ::close(fd); }
    std::vector<std::pair<std::string, uint16_t>> drain() const
    {
        std::vector<std::pair<std::string, uint16_t>> out;
        for (;;) {
            char buf[2048];
            sockaddr_in from{};
            socklen_t len = sizeof(from);
            const ssize_t n = ::recvfrom(fd, buf, sizeof(buf), 0, reinterpret_cast<sockaddr *>(&from), &len);
            if (n < 0) {
                return out;
            }
            out.emplace_back(std::string(buf, static_cast<size_t>(n)), ntohs(from.sin_port));
        }
    }
};

/** A client of the bridge: one connection, a request line, what comes back. */
struct BridgeClient {
    int fd = -1;
    std::string got;
    BridgeClient(uint16_t port, const std::string &request)
    {
        fd = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = htons(port);
        ::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a));
        ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
        const std::string line = request + "\n";
        ::send(fd, line.data(), line.size(), 0);
    }
    ~BridgeClient() { ::close(fd); }
    /** Reads what is there; true once the bridge closed the connection. */
    bool read()
    {
        for (;;) {
            const ssize_t n = peek(fd, &got);
            if (n == 0) {
                return true;
            }
            if (n < 0) {
                return n != -EAGAIN;
            }
        }
    }
    void write(const std::string &s) const { ::send(fd, s.data(), s.size(), 0); }
};

}  // namespace

TEST(sim_links_backoff_doubles_to_five_seconds_and_starts_over)
{
    const TcpTiming t;  // hub_link.cpp's own
    Backoff b(t);
    const TimeUs never = frsim::kNeverUs;
    std::vector<TimeUs> seen;
    for (int i = 0; i < 8; ++i) {
        seen.push_back(b.closed(1'000'000, never));
    }
    CHECK(seen == (std::vector<TimeUs>{250'000, 500'000, 1'000'000, 2'000'000, 4'000'000, 5'000'000, 5'000'000, 5'000'000}));
    // A connection that lasted 10 s starts it over; a shorter one does not.
    CHECK_EQ(b.closed(20'000'000, 15'000'000), 5'000'000);
    CHECK_EQ(b.closed(30'000'000, 20'000'000), 250'000);
    CHECK_EQ(b.next(), 500'000);
    b.reset();
    CHECK_EQ(b.next(), 250'000);
}

TEST(sim_links_send_buffer_is_lwips_5760_bytes_in_order)
{
    SendBuffer sb(5760);
    const std::vector<uint8_t> k(4000, 0xAB);
    sb.push(k, 100);
    CHECK_EQ(sb.fill(), 4000u);
    CHECK_EQ(sb.room(), 1760u);
    sb.push(k, 50);  // due earlier than the bytes before it: never overtakes them
    CHECK_EQ(sb.fill(), 5760u);
    CHECK_EQ(sb.room(), 0u);
    CHECK_EQ(sb.next_due(), 100);
    CHECK(sb.take_due(99).empty());
    CHECK_EQ(sb.take_due(100).size(), 5760u);
    CHECK_EQ(sb.next_due(), frsim::kNeverUs);
    CHECK_EQ(sb.fill(), 0u);
}

TEST(sim_links_tcp_refused_backs_off_and_ip_back_starts_over)
{
    Executor exec(TimeMode::wall);
    SimCore core(exec, "t");
    Ap ap(nullptr, quick_ap());
    SimTcp tcp(exec, core, ap, kMac, fast());
    tcp.set_hub("127.0.0.1", closed_port());
    tcp.ip_up();
    CHECK(run_until(exec, [&] { return tcp.stats().connect_fails >= 5; }, 3000));
    CHECK(!tcp.up());
    CHECK(tcp.backoff().next() >= 320'000);  // 20 -> 40 -> 80 -> 160 -> 320 ms after five failures
    // Wi-Fi lost and back (AP down, wifi_down): the backoff starts over at once, as hub_link's !ip_up path.
    tcp.ip_down();
    tcp.ip_up();
    CHECK_EQ(tcp.backoff().next(), 20'000);
}

TEST(sim_links_tcp_silent_never_fins_and_resets_after_its_last_frame)
{
    Executor exec(TimeMode::wall);
    SimCore core(exec, "t");
    Ap ap(nullptr, quick_ap());
    Listener hub;
    SimTcp tcp(exec, core, ap, kMac, fast());
    tcp.set_hub("127.0.0.1", hub.port);
    tcp.ip_up();
    int peer = -1;
    REQUIRE(run_until(exec, [&] { return tcp.up() && (peer >= 0 || (peer = hub.accept_one()) >= 0); }, 3000));
    const std::vector<uint8_t> env(40, 0x11);
    CHECK(tcp.send(env));
    std::string got;
    REQUIRE(run_until(exec, [&] { peek(peer, &got); return got.size() >= 42; }, 2000));
    CHECK_EQ(got.size(), 42u);
    CHECK_EQ(static_cast<uint8_t>(got[0]), 40);

    // AP down: no FIN, nothing written, the fd still open...
    tcp.ip_down();
    CHECK(!tcp.up());
    CHECK(!tcp.send(env));
    CHECK(tcp.stale_fd() >= 0);
    run_ms(exec, 150);
    CHECK_EQ(peek(peer), -EAGAIN);
    // ... until silent_rst_us after its last frame: an RST, as the Mac's keepalive would end it.
    CHECK(run_until(exec, [&] { return tcp.stats().resets == 1; }, 2000));
    CHECK_EQ(tcp.stale_fd(), -1);
    const ssize_t r = peek(peer);
    CHECK(r == -ECONNRESET || r == 0);
    CHECK_EQ(tcp.stats().closes, 0u);
    ::close(peer);
}

TEST(sim_links_tcp_stale_connection_closes_at_the_next_welcome)
{
    Executor exec(TimeMode::wall);
    SimCore core(exec, "t");
    Ap ap(nullptr, quick_ap());
    Listener hub;
    TcpTiming t = fast();
    t.silent_rst_us = 5'000'000;  // longer than the test: only the WELCOME closes it
    SimTcp tcp(exec, core, ap, kMac, t);
    tcp.set_hub("127.0.0.1", hub.port);
    tcp.ip_up();
    int first = -1;
    REQUIRE(run_until(exec, [&] { return tcp.up() && (first >= 0 || (first = hub.accept_one()) >= 0); }, 3000));
    tcp.ip_down();
    tcp.ip_up();  // a short outage: a new connection while the old one is silent
    int second = -1;
    REQUIRE(run_until(exec, [&] { return tcp.up() && (second >= 0 || (second = hub.accept_one()) >= 0); }, 3000));
    CHECK(tcp.stale_fd() >= 0);
    CHECK_EQ(peek(first), -EAGAIN);  // the hub has heard nothing of the old one
    tcp.welcomed();
    CHECK_EQ(tcp.stale_fd(), -1);
    CHECK_EQ(tcp.stats().stale_closed, 1u);
    CHECK(run_until(exec, [&] { return peek(first) == 0; }, 1000));  // a FIN now, after the hub superseded it
    CHECK_EQ(peek(second), -EAGAIN);
    CHECK_EQ(tcp.stats().resets, 0u);
    ::close(first);
    ::close(second);
}

TEST(sim_links_tcp_hub_close_reconnects_after_the_backoff)
{
    Executor exec(TimeMode::wall);
    SimCore core(exec, "t");
    Ap ap(nullptr, quick_ap());
    Listener hub;
    SimTcp tcp(exec, core, ap, kMac, fast());
    tcp.set_hub("127.0.0.1", hub.port);
    tcp.ip_up();
    int peer = -1;
    REQUIRE(run_until(exec, [&] { return tcp.up() && (peer >= 0 || (peer = hub.accept_one()) >= 0); }, 3000));
    ::close(peer);  // the hub's FIN
    CHECK(run_until(exec, [&] { return tcp.stats().closes == 1; }, 2000));
    int again = -1;
    CHECK(run_until(exec, [&] { return tcp.up() && (again >= 0 || (again = hub.accept_one()) >= 0); }, 3000));
    CHECK_EQ(tcp.stats().connects, 2u);
    ::close(again);
}

TEST(sim_links_tcp_send_buffer_fills_the_fifo_behind_a_slow_ap)
{
    Executor exec(TimeMode::wall);
    SimCore core(exec, "t");
    ApConfig slow = quick_ap();
    slow.uplink_min_ms = slow.uplink_max_ms = 200;  // a stalled Wi-Fi
    Ap ap(nullptr, slow);
    Listener hub;
    SimTcp tcp(exec, core, ap, kMac, fast());
    tcp.set_hub("127.0.0.1", hub.port);
    tcp.ip_up();
    int peer = -1;
    REQUIRE(run_until(exec, [&] { return tcp.up() && (peer >= 0 || (peer = hub.accept_one()) >= 0); }, 3000));
    CHECK_EQ(tcp.queued(), 0u);
    for (int i = 0; i < 10; ++i) {
        CHECK(tcp.send(std::vector<uint8_t>(1000, static_cast<uint8_t>(i))));
    }
    // lwIP's buffer takes 5,760 B; the rest waits in the FIFO, which LOG reads as `queued()` (D20).
    CHECK_EQ(tcp.sndbuf().fill(), 5760u);
    CHECK_EQ(tcp.queued(), 10u * 1002 - 5760);
    std::string got;
    run_ms(exec, 100);
    peek(peer, &got);
    CHECK(got.empty());  // nothing before the AP carried it
    REQUIRE(run_until(exec, [&] { peek(peer, &got); return got.size() >= 10u * 1002; }, 3000));
    CHECK_EQ(got.size(), 10u * 1002);
    for (int i = 0; i < 10; ++i) {
        CHECK_EQ(static_cast<uint8_t>(got[static_cast<size_t>(i) * 1002 + 2]), i);  // in order
    }
    CHECK_EQ(tcp.queued(), 0u);
    ::close(peer);
}

TEST(sim_links_udp_shared_and_own_sockets)
{
    Executor exec(TimeMode::wall);
    ApConfig cfg = quick_ap();
    Ap ap(nullptr, cfg);
    UdpListener hub;
    frsim::UdpSocket shared;
    const fr::net::Mac b{0x02, 0xf2, 0x00, 0x00, 0x00, 0x02};
    const fr::net::Mac c{0x02, 0xf2, 0x00, 0x00, 0x00, 0x03};
    frsim::SimUdp x(exec, ap, kMac, shared, false);
    frsim::SimUdp y(exec, ap, b, shared, false);
    frsim::SimUdp z(exec, ap, c, shared, true);
    for (frsim::SimUdp *u : {&x, &y, &z}) {
        u->set_hub("127.0.0.1", hub.port);
    }
    const std::vector<uint8_t> env(30, 0x22);
    CHECK(!x.send(env));  // IP down: refused
    for (frsim::SimUdp *u : {&x, &y, &z}) {
        u->set_ip(true);
        CHECK(u->send(env));
    }
    std::vector<std::pair<std::string, uint16_t>> got;
    REQUIRE(run_until(exec, [&] { for (auto &g : hub.drain()) got.push_back(g); return got.size() >= 3; }, 2000));
    REQUIRE_EQ(got.size(), 3u);
    // The shared socket: one source port for x and y (the hub keys on the envelope's src); z has its own.
    CHECK_EQ(got[0].second, got[1].second);
    CHECK(got[2].second != got[0].second);
    CHECK_EQ(x.stats().sent + y.stats().sent + z.stats().sent, 3u);
    CHECK_EQ(x.stats().refused, 1u);
}

TEST(sim_links_udp_ap_loss_drops_silently)
{
    Executor exec(TimeMode::wall);
    ApConfig cfg = quick_ap();
    cfg.udp_loss = 1.0;
    Ap ap(nullptr, cfg);
    UdpListener hub;
    frsim::UdpSocket shared;
    frsim::SimUdp u(exec, ap, kMac, shared, false);
    u.set_hub("127.0.0.1", hub.port);
    u.set_ip(true);
    for (int i = 0; i < 5; ++i) {
        CHECK(u.send(std::vector<uint8_t>(30, 1)));  // the sender never knows
    }
    run_ms(exec, 50);
    CHECK(hub.drain().empty());
    CHECK_EQ(u.stats().lost, 5u);
}

TEST(sim_links_bridge_lists_opens_carries_and_unplugs)
{
    Executor exec(TimeMode::wall);
    frsim::Bridge bridge(exec);
    REQUIRE(bridge.listen(0));
    std::vector<std::string> to_device;
    bridge.attach("02f200000001", [&](std::string_view l) { to_device.emplace_back(l); });

    BridgeClient list(bridge.port(), "list");
    REQUIRE(run_until(exec, [&] { return list.read(); }, 2000));
    CHECK_EQ(list.got,
             R"([{"path":"/dev/cu.usbmodem-fr-02f200000001","manufacturer":"Espressif","serialNumber":"02:F2:00:00:00:01","vendorId":"303a","productId":"1001"}])"
             "\n");

    BridgeClient bad(bridge.port(), "open /dev/cu.nope");
    REQUIRE(run_until(exec, [&] { return bad.read(); }, 2000));
    CHECK_EQ(bad.got, "err no such port /dev/cu.nope\n");

    BridgeClient port(bridge.port(), "open " + frsim::Bridge::path_of("02f200000001"));
    REQUIRE(run_until(exec, [&] { port.read(); return port.got == "ok\n"; }, 2000));
    CHECK(bridge.open("02f200000001"));
    port.write("@fr1:hello\r\n#7 info\n");
    REQUIRE(run_until(exec, [&] { return to_device.size() == 2; }, 2000));
    CHECK_EQ(to_device[0], "@fr1:hello");
    CHECK_EQ(to_device[1], "#7 info");
    bridge.print("02f200000001", "I (10) fr: alive");
    REQUIRE(run_until(exec, [&] { port.read(); return port.got.size() > 3; }, 2000));
    CHECK_EQ(port.got, "ok\nI (10) fr: alive\n");

    // An unplug: gone from the listing, the open port's connection closed.
    bridge.detach("02f200000001");
    CHECK(!bridge.attached("02f200000001"));
    CHECK(run_until(exec, [&] { return port.read(); }, 2000));
    BridgeClient after(bridge.port(), "list");
    REQUIRE(run_until(exec, [&] { return after.read(); }, 2000));
    CHECK_EQ(after.got, "[]\n");
}
