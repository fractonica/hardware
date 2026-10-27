// A fleet node's hub links (design m2-c2 D7), on the wall-mode executor: SimTcp, SimUdp and SimSerial, and the
// serial bridge that serves the hub's `--serial-bridge` wire for the nodes a scenario puts on USB.
//
// SimTcp is hub_link.cpp's TCP on a non-blocking socket: the TX FIFO (TxFifo<8192>, queued() its fill), behind it
// lwIP's 5,760 B send buffer drained at the AP's latency and stalled in its gaps, frames from the hub delivered after
// the AP's downlink latency through the core's network queue, and hub_link's reconnect timing (backoff 0.25 -> 5 s,
// back to 0.25 s after a connection that lasted 10 s or when IP comes back, a 3 s connect timeout). Net's drop()
// closes the socket (the hub sees a FIN), as on target. What has no FIN on RF never closes it: AP down, wifi_down,
// `tcp 0` and a power cut make the connection silent: up() false, the fd left open, nothing read or written. The
// Mac's keepalive would end such a connection about 8 s after its last frame; on loopback the kernel would answer
// the probes forever, so SimTcp resets it (SO_LINGER {1, 0}: an RST) 8 s after its last frame, or closes it once a
// new connection got its WELCOME (the hub has superseded it by then), whichever comes first.
//
// SimUdp sends one datagram per envelope after the AP's uplink latency, dropped by the AP's udp_loss and gaps, over
// the fleet's one shared socket (the hub maps a datagram to its peer by the envelope's src) or a socket of its own.
// SimSerial is fr_serial's `@fr1:` line and fr_diag's `#<id> <line>` channel on the node's bridge port.
//
// The bridge (links/serial-bridge.ts, virtual-usb.ts's wire): one TCP connection per request; `list` answers one JSON
// line of PortInfo (Espressif's VID 303a and PID 1001, the MAC as the USB serial number) and closes; `open <path>`
// answers `ok` and the connection is that port from then on, both ways, or `err <message>`. Closing the port's
// connections is an unplug. Test code: it may allocate.
#pragma once

#include <netinet/in.h>

#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "fr/base.hpp"
#include "fr/net/link.hpp"
#include "fr/net/net.hpp"
#include "fr/net/tx_fifo.hpp"
#include "sim/ap.hpp"
#include "sim/executor.hpp"
#include "sim/sim_core.hpp"

namespace frsim {

constexpr fr::TimeUs kNeverUs = INT64_MAX;

/** hub_link.cpp's TCP timing (05 §5.11) and the fleet's silent-reset rule (D7); host tests scale it down. */
struct TcpTiming {
    fr::TimeUs backoff_min_us = 250'000;
    fr::TimeUs backoff_max_us = 5'000'000;
    /** A connection that lasted this long starts the backoff over. */
    fr::TimeUs stable_us = 10'000'000;
    fr::TimeUs connect_timeout_us = 3'000'000;
    /** A silent connection is reset this long after its last frame: the Mac's keepalive (5 s idle, 3 probes 1 s apart). */
    fr::TimeUs silent_rst_us = 8'000'000;
    /** lwIP's send buffer (CONFIG_LWIP_TCP_SND_BUF_DEFAULT, s3l-pad-release sdkconfig). */
    size_t sndbuf_bytes = 5760;
};

/** hub_link.cpp's reconnect backoff: doubled after every close, from the minimum again after a stable connection. */
class Backoff
{
public:
    explicit Backoff(const TcpTiming &t) : t_(t), next_(t.backoff_min_us) {}

    /**
     * The connection (or the attempt) ended at `now`; `connected_at` is when it connected (kNeverUs: it never did).
     * Returns the delay before the next attempt, and doubles it for the one after.
     */
    fr::TimeUs closed(fr::TimeUs now, fr::TimeUs connected_at)
    {
        if (connected_at != kNeverUs && now - connected_at >= t_.stable_us) {
            next_ = t_.backoff_min_us;
        }
        const fr::TimeUs d = next_;
        next_ = std::min(next_ * 2, t_.backoff_max_us);
        return d;
    }
    /** IP lost, or drop_hub_link released: the next close waits the minimum again. */
    void reset() { next_ = t_.backoff_min_us; }
    fr::TimeUs next() const { return next_; }

private:
    TcpTiming t_;
    fr::TimeUs next_;
};

/**
 * lwIP's send buffer behind SimTcp's TX FIFO (D7): bytes the FIFO handed over wait here until the AP has carried them
 * (its uplink latency, then the bytes at its PHY rate, in order, and never inside a gap); only then do they reach the
 * socket. Its room is what lets the FIFO drain, so a stalled AP fills the FIFO, as on target.
 */
class SendBuffer
{
public:
    explicit SendBuffer(size_t capacity) : cap_(capacity) {}

    size_t capacity() const { return cap_; }
    size_t fill() const { return fill_; }
    size_t room() const { return cap_ - fill_; }
    /** `bytes` (at most room()) are on their way, due at `due` (never before the bytes queued before them). */
    void push(std::span<const uint8_t> bytes, fr::TimeUs due);
    /** The bytes due by `now`, in order (they leave the buffer). */
    std::vector<uint8_t> take_due(fr::TimeUs now);
    /** When the oldest bytes are due (kNeverUs when empty). */
    fr::TimeUs next_due() const;
    void clear();

private:
    struct Chunk {
        fr::TimeUs due;
        std::vector<uint8_t> bytes;
    };
    size_t cap_;
    size_t fill_ = 0;
    fr::TimeUs last_due_ = 0;
    std::deque<Chunk> chunks_;
};

/** What a link hands a received envelope to (the node: Net::receive, plus its WELCOME hooks). */
using RxFn = std::function<void(fr::net::LinkKind, std::span<const uint8_t>)>;

class SimTcp final : public fr::net::Link
{
public:
    struct Stats {
        uint32_t connects = 0;        // connections made
        uint32_t connect_fails = 0;   // attempts refused or timed out
        uint32_t closes = 0;          // connections closed with a FIN (Net's drop, the hub's close, an error)
        uint32_t resets = 0;          // silent connections reset (RST) after silent_rst_us
        uint32_t stale_closed = 0;    // silent connections closed after the next WELCOME
        uint32_t tx_frames = 0;       // envelopes queued
        uint32_t tx_refused = 0;      // envelopes refused (down, or the FIFO full)
        uint32_t rx_frames = 0;       // envelopes from the hub delivered to Net
        uint32_t rx_dropped = 0;      // envelopes the core's network queue refused
        uint64_t tx_bytes = 0;        // bytes written to the socket
        uint64_t rx_bytes = 0;        // bytes read from it
    };
    /** Called with each envelope's arrival (the socket read, on the fleet's clock): the fleet's arrival skew (D16). */
    using ArrivalFn = std::function<void(std::span<const uint8_t> env, fr::TimeUs at)>;

    /** `mac` keys the AP's draws. The node's core takes received envelopes (post_net) and link changes (post). */
    SimTcp(Executor &exec, SimCore &core, Ap &ap, const fr::net::Mac &mac, const TcpTiming &timing = {});
    ~SimTcp();
    SimTcp(const SimTcp &) = delete;
    SimTcp &operator=(const SimTcp &) = delete;

    /** The hub's node TCP port. */
    void set_hub(std::string host, uint16_t port);
    /** The node (re)built: Net hears of link changes, `rx` gets envelopes. */
    void bind(fr::net::Net &net, RxFn rx);
    void set_arrival(ArrivalFn fn) { arrival_ = std::move(fn); }
    /** IP is up (associated, Wi-Fi on, TCP enabled): the backoff starts over and a connection is tried now. */
    void ip_up();
    /** IP gone, or the node powered off: the connection goes silent (never closed; reset at +8 s). */
    void ip_down();
    /** A power cut: silent, and Net is forgotten until bind() (the node is rebuilt); Net's hold and the backoff go
     * too, as the RAM they are on target. */
    void crash();
    /** The node got its WELCOME on the current connection: a stale silent one is closed now (D7). */
    void welcomed();

    // fr::net::Link
    fr::net::LinkKind kind() const override { return fr::net::LinkKind::tcp; }
    bool up() const override { return phase_ == Phase::connected; }
    fr::Status send(std::span<const uint8_t> envelope) override;
    void drop(fr::net::DropReason) override;
    void hold(bool on) override;
    size_t queued() const override { return tx_.fill(); }

    const Stats &stats() const { return stats_; }
    /** For the tests: the socket (-1 when none), the silent one, when the next attempt is due, the backoff, IP, the hold. */
    int fd() const { return fd_; }
    int stale_fd() const { return stale_fd_; }
    fr::TimeUs retry_at() const { return retry_at_; }
    const Backoff &backoff() const { return backoff_; }
    const SendBuffer &sndbuf() const { return sndbuf_; }
    bool ip() const { return ip_; }
    /** Net's hold (drop_hub_link, ip_block): no connection is tried while it lasts. */
    bool held() const { return held_; }

private:
    enum class Phase : uint8_t { idle, waiting, connecting, connected };
    /** The connection id of frames that arrived before the hub closed theirs: delivered all the same. */
    static constexpr uint64_t kClosedConn = UINT64_MAX;

    void schedule_attempt(fr::TimeUs delay);
    void attempt();
    void on_writable_connect();
    void connected();
    /** Closes the connection with a FIN (or an RST when `rst`), and schedules the next attempt. */
    void close_now(bool reconnect);
    void notify();
    void on_ready(uint32_t events);
    void read_all();
    void deliver_due();
    void flush();
    void pump();
    void write_out();
    void watch();
    void go_silent();
    void reset_stale();

    Executor &exec_;
    SimCore &core_;
    Ap &ap_;
    fr::net::Mac mac_;
    TcpTiming timing_;
    std::string host_ = "127.0.0.1";
    uint16_t port_ = 0;
    fr::net::Net *net_ = nullptr;
    RxFn rx_;
    ArrivalFn arrival_;

    Phase phase_ = Phase::idle;
    bool ip_ = false;
    bool held_ = false;
    int fd_ = -1;
    uint64_t conn_ = 0;  // connections tried: stale events and frames check it
    fr::TimeUs connected_at_ = kNeverUs;
    fr::TimeUs last_frame_at_ = 0;
    fr::TimeUs retry_at_ = kNeverUs;
    EventId attempt_event_ = 0;
    EventId timeout_event_ = 0;
    Backoff backoff_;
    uint64_t draws_ = 0;  // the AP's per-node counter

    // The silent connection (one at a time: a newer one replaces it after resetting it).
    int stale_fd_ = -1;
    EventId stale_event_ = 0;

    // Transmit: the FIFO, lwIP's buffer, then bytes the socket did not take yet.
    fr::net::TxFifo<8192> tx_;
    SendBuffer sndbuf_;
    std::vector<uint8_t> wbuf_;
    EventId pump_event_ = 0;
    fr::TimeUs pump_at_ = kNeverUs;

    // Receive: bytes of a frame in progress, then whole envelopes waiting out the AP's latency.
    std::vector<uint8_t> rbuf_;
    struct Inbound {
        fr::TimeUs due;
        uint64_t conn;
        std::vector<uint8_t> env;
    };
    std::deque<Inbound> inbound_;
    EventId deliver_event_ = 0;
    std::deque<std::vector<uint8_t>> ready_;  // posted to the core's network queue, one post each

    Stats stats_;
};

/** A UDP socket on loopback that sends only (the hub never sends UDP, links/udp.ts). */
class UdpSocket
{
public:
    UdpSocket();
    ~UdpSocket();
    UdpSocket(const UdpSocket &) = delete;
    UdpSocket &operator=(const UdpSocket &) = delete;
    bool ok() const { return fd_ >= 0; }
    bool send_to(const std::string &host, uint16_t port, std::span<const uint8_t> bytes);

private:
    int fd_ = -1;
};

class SimUdp final : public fr::net::Link
{
public:
    struct Stats {
        uint32_t sent = 0;     // datagrams written
        uint32_t lost = 0;     // datagrams the AP lost (udp_loss, a gap)
        uint32_t refused = 0;  // sends while IP was down
    };

    /** `own` null: the fleet's shared socket `shared`; else a socket of the node's own (`udp: own`). */
    SimUdp(Executor &exec, Ap &ap, const fr::net::Mac &mac, UdpSocket &shared, bool own);
    void set_hub(std::string host, uint16_t port);
    void bind(fr::net::Net &net) { net_ = &net; }
    void set_ip(bool up) { ip_ = up; }
    /** A power cut: nothing in flight survives. */
    void crash();

    fr::net::LinkKind kind() const override { return fr::net::LinkKind::udp; }
    bool up() const override { return ip_; }
    fr::Status send(std::span<const uint8_t> envelope) override;

    const Stats &stats() const { return stats_; }

private:
    void send_due();

    Executor &exec_;
    Ap &ap_;
    fr::net::Mac mac_;
    UdpSocket &shared_;
    std::unique_ptr<UdpSocket> own_;
    std::string host_ = "127.0.0.1";
    uint16_t port_ = 0;
    fr::net::Net *net_ = nullptr;
    bool ip_ = false;
    uint64_t draws_ = 0;
    uint64_t epoch_ = 0;
    struct Out {
        fr::TimeUs due;
        std::vector<uint8_t> bytes;
    };
    std::deque<Out> queue_;
    EventId event_ = 0;
    Stats stats_;
};

/** fr_serial's line on the node's bridge port: `@fr1:` envelopes both ways, the `#<id>` diag channel in. */
class SimSerial final : public fr::net::Link
{
public:
    using WriteFn = std::function<void(std::string_view line)>;
    /** A `#<id> <line>` line from the hub: the answer (`#<id> {json}`) goes back on the line. */
    using DiagFn = std::function<std::string(std::string_view id, std::string_view line)>;

    explicit SimSerial(SimCore &core) : core_(core) {}

    void bind(fr::net::Net &net, RxFn rx, DiagFn diag);
    /** Where the node's lines go (its bridge port; null: nowhere). */
    void set_write(WriteFn write) { write_ = std::move(write); }
    /** The USB host is there (the port attached) or not; Net hears of it. */
    void set_host(bool present);
    /** `hub_mute`: the hub's lines stop reaching the node, the USB host staying. */
    void set_mute(bool on) { muted_ = on; }
    /** A line the hub wrote to the port. */
    void on_line(std::string_view line);
    /** A line of the node's own (an ESP_LOG line): out on the port as it is. */
    void print(std::string_view line);
    /** A power cut: Net is forgotten until bind(). */
    void crash();

    fr::net::LinkKind kind() const override { return fr::net::LinkKind::serial; }
    bool up() const override { return host_; }
    fr::Status send(std::span<const uint8_t> envelope) override;

    /** The id of a serial command-channel line, `#<1-8 digits> <line>` (fr_diag split_id). */
    static std::optional<std::string_view> serial_id(std::string_view line);

private:
    SimCore &core_;
    fr::net::Net *net_ = nullptr;
    RxFn rx_;
    DiagFn diag_;
    WriteFn write_;
    bool host_ = false;
    bool muted_ = false;
    std::deque<std::vector<uint8_t>> ready_;
};

/** The hub's `--serial-bridge` (D7): one USB-Serial/JTAG port per node a scenario puts on USB. */
class Bridge
{
public:
    explicit Bridge(Executor &exec);
    ~Bridge();
    Bridge(const Bridge &) = delete;
    Bridge &operator=(const Bridge &) = delete;

    /** Listens on 127.0.0.1 (port 0: any free one); false when it cannot. */
    bool listen(uint16_t port = 0);
    uint16_t port() const { return port_; }

    /** The port of `mac` (12 hex): `/dev/cu.usbmodem-fr-<mac>`. */
    static std::string path_of(std::string_view mac_hex);
    /** Plugs a port in; `to_device` gets every line the hub writes to it. Replaces one with the same MAC. */
    void attach(std::string_view mac_hex, std::function<void(std::string_view)> to_device);
    /** Unplugs it: gone from the listing, its connections closed (the hub sees a disconnect). */
    void detach(std::string_view mac_hex);
    bool attached(std::string_view mac_hex) const;
    /** The hub has the port open (the device's lines reach it). */
    bool open(std::string_view mac_hex) const;
    /** A line the device prints (LF appended); dropped while no one has the port open, as on a real port. */
    void print(std::string_view mac_hex, std::string_view line);

private:
    struct Conn;
    struct Port {
        std::string mac;
        std::function<void(std::string_view)> to_device;
        std::set<Conn *> open;
    };
    void accept_all();
    void on_conn(Conn &c, uint32_t events);
    void close_conn(Conn &c);
    void write(Conn &c, std::string_view bytes);
    std::string listing() const;

    Executor &exec_;
    int fd_ = -1;
    uint16_t port_ = 0;
    std::map<std::string, Port> ports_;  // by MAC hex
    std::map<int, std::unique_ptr<Conn>> conns_;
};

}  // namespace frsim
