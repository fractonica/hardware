// fr_net_node: one node on the host for interop runs against a real hub on loopback (design c3 §5). The
// real fr_net core (fr::net::Net), the real button and LED services and the descriptor builder talk to the
// hub over POSIX TCP (`len u16 LE` framing) and UDP, as fr_net/src/esp does on target, and optionally over
// a serial line on stdin/stdout (`@fr1:` ENV lines, as fr_serial); a poll() loop is the core task. It shows
// that the C++ node and the TS router agree on the wire, the handshake, keepalives, udp_ok, the response
// cache, expire_at and BYE before any board runs them. The real fr_ota core (fr::ota::Ota) runs on the OTA
// fake of tools/ota_fake.hpp (design c4 §5): OFFERs download from the hub's node port with the board's own
// HTTP GET (fr::ota::HttpGet), and with --ota-dir a restarted process boots what the OTA installed
// (PENDING_VERIFY, health gate, rollback). With --air-dir it also joins a fake air medium (design c5 §5):
// ESP-NOW as UDP datagrams on loopback between the fr_net_node processes registered in that directory, under
// the real driver's send discipline (fr_net/src/esp/air_sched.hpp), so several C++ nodes run node <-> node
// delivery, flooding and bindings with or without the hub. The directory and the bindings persist in
// --ota-dir (fr_dir.bin, fr_bind.bin, as nvs:fr_dir and nvs:fr_bind), written through the fr_worker fake.
//
//   fr_net_node {--hub-tcp <port> --hub-udp <port> [--serial 1] | --serial 1} --mac <12 hex> [--host 127.0.0.1]
//               [--addr <n>] [--net <n>] [--epoch <n>] [--hb-ms <n>] [--alias <a>] [--alias-rev <n>]
//               [--fw <16 hex> | --fw-id <64 hex>] [--hub-http <port>] [--ota-dir <dir>] [--version <label>]
//               [--health-ms <n>] [--fault health] [--air-dir <dir> [--air-loss <pct>] [--air-seed <n>]
//               [--air-rssi <dBm>] [--air-channel <n>] [--air-ack-ms <n>]] [--pin-target <udp port>]
//               [--pin-listen <udp port>] [--role node|gateway|fixture] [--board <b>] [--profile <p>] [--chip <n>]
//               [--led-kind mono|gpio_low|ws2812] [--led-tap <udp port>] [--test-pin-tap <udp port>]
//               [--fixture 1 [--line <ch>=<udp port>]...] [--net-log 1]
//   fr_net_node --make-image <path> [--version <label>] [--size <n>] [--board <b>] [--profile <p>]
//               [--part <pp>] [--chip <n>] [--min-rev <n>] [--max-rev <n>] [--fault 0|1] [--seed <n>]
//
// --hub-http is the hub's node HTTP port (default 7422; tests pass their own). With --ota-dir each start is
// a new boot epoch (the stored one + 1, at least --epoch). The running image is
// `--fw-id`, or `--fw` padded with zeros, or what --ota-dir says; its version label `--version` (0.1.0).
// --health-ms shortens the 60 s health deadline; `--fault health` is a fault build (CAPS never set), as is
// an installed image whose fr_app_desc says fault = 1. The node is board esp32c6-supermini, profile c6-pad,
// part_profile fr-4mb-v1, chip 13 rev 1, with a 0x1E0000 update slot.
// --make-image writes an app image that passes this node's CHECK (06 §6.8 layout, the SHA-256 of the
// rest appended) and prints `{"ev":"image","fw_id":"<64 hex>","size":<n>}`.
//
// --air-dir names the medium: each node registers `<mac>.port` there. --air-loss drops that percentage of the
// datagrams this node receives (data and MAC ACKs), from --air-seed's generator; --air-rssi is the RSSI its
// received frames report (default -50), --air-channel its channel C (default 6: a frame from another
// channel is not heard), --air-ack-ms how long a unicast waits for its MAC ACK (default 3).
//
// Stdin takes one command per line: `state`, `udp_block <s>`, `drop_hub_link <s>`, `ip_block <s>` (TCP and
// UDP lose every envelope, serial does not), `bye`, `tcp 0|1` (close TCP and stay off / reconnect), `usb 0|1`
// (the serial link's USB host), `hub_mute 0|1` (the hub's serial lines stop reaching the node, the link up: a dead hub
// process with the port still enumerated), `crash` (end like a panic: no BYE,
// the next start sees the reset reason), `quit`, and with --serial the hub's `@fr1:` lines. C5 adds
// `wifi_down <s>` (TCP and UDP down for s seconds, ESP-NOW and serial carry on; 0 ends it), `air_loss <pct>`,
// `inject <gesture>` (the boot button, as input_simulate: click, double_click, long_press, press, release),
// `msg <dst|broadcast> <topic> [data…]` and `msg_reliable <dst> <topic> [data…]` (fr::msg::send to a node
// addr, 0 for the hub, this node's own addr or every node; the data is the rest of the line), `bind <hex>` (an encoded Binding, as fr.node.bind_set stores it), `unbind <slot|all>`,
// `bindings`, `neighbors` and `directory`. C6 adds `loss <pct> <s> [both|tx|rx]` (Net::loss, design c6 D21: that share
// of the hub-link envelopes sent and/or received is lost; 0 ends it). Stdout gets
// one JSON object per line (`{"ev":"..."}`): link changes, udp_ok changes, dispatched commands, LED levels,
// `state` answers and `reboot` (`"reason":"ota"` after an install, `"rollback"` after a missed health
// deadline: the process exits, and a restart with the same --ota-dir is the next boot); the OTA side adds
// `ota_frame` (from the hub), `ota_tx` (to it), `ota_get` (each HTTP GET), `ota_boot`, `ota_valid` and
// `ota_rollback`; with --serial also the node's `@fr1:` lines. C5 adds `air` (the medium joined), `msg` (a MSG
// for this node: src, topic, data as text when UTF-8, len), `msg_sent`, `bind_set`, `bind_clear`, `bind`,
// `unbind`, `bindings` (hex of the encoded BindingList), `neighbors`, `directory` (addr and MAC by addr), `wifi`,
// `inject` and C5 counters in `state` (air_*, relay_*, bcast_*, bind_*, `nodes` by path, `medium` the fake air's
// own, `msgs` per topic).
//
// C6 (design c6 §6 S6): fr.diag on port 241 answers fr.diag.exec lines over the hub link: `pin_pulse <us>`, `net
// loss <pct> <s> [both|tx|rx]`, `net drop_hub_link|udp_block|ip_block|wifi_down <s>`, `stats [section]` and `info`.
// `stats` answers as fr_diag does (design c5 §2, 09 §9.7): the C3/C6 counters (dup, cached_replies, delivery_failed,
// ...) and the sections links, bcast, relay, espnow, bindings, nodes, msgs and (M2-C2) net_logs, or one of them alone
// with `stats <section>`. `net wifi_down <s>` is the stdin command's, run 300 ms after its RESULT went out (fr_net's
// WifiSta delay, M2-C2 review fleet-5).
// A hub CMD with exec_at runs at its time through the real Net scheduler (D22). --pin-target is the T-LAT wire
// out: `pin_pulse` sends one UDP datagram (the pulse length in µs, as text) to that loopback port and answers
// {ok, pin 20, us, at_us} as the board's test pin would. --pin-listen is the wire in: a datagram on that port
// (0: any free one, printed as `{"ev":"pin_listen","port":N}`) presses the boot button through its input slot,
// as the GPIO ISR would, and releases it after the pulse, so down, up and click follow the real debounce path.
// Their lines are `pin_pulse` {us, at_us} and `pin_in` {us, at_us}; `state` adds loss_*, cmds_scheduled, exec_*
// and rx_queue_us_max.
//
// M2-C1 (design m2-c1-hil §4 S2): without --hub-tcp/--hub-udp the node is serial only, as a radio-off build
// (the HIL fixture): no TCP or UDP link, HELLO without `wifi`, and the serial session's WELCOME sets the NET
// health bit. --role is the HELLO role (default node), --board, --profile and --chip what HELLO, the descriptor
// and fr_ota's CHECK say (default esp32c6-supermini, c6-pad, 13); the board also gives the test pin `pin_pulse`
// and `info` report (C3 OLED 10, C6 Super Mini 20, S3 LCD 16; none on the fixture board, so -1). The wires to a
// virtual fixture are text datagrams on loopback, as --pin-target's: `level 0|1` (a wire's level), `<us>` (a
// pulse: low now, released `us` later) and `frame <grb> <bits>` (one WS2812 refresh). Whatever takes a wire's
// datagram (--pin-listen, a fixture input line) stamps it at its arrival, the kernel's SO_TIMESTAMP (recv_stamped),
// as the GPIO ISR stamps the pin's edge on target: a late wake from poll() on a loaded host is no later edge. A
// pad's --led-tap gets every LedService write as its status LED's pin carries it, by --led-kind: `mono` (default,
// active high) and `gpio_low` (led_gpio active low, the C3 pads) a `level`, sent again every 250 ms while it
// holds, as a wire keeps its level; `ws2812` (the C6 and S3 pads: RGB, dimmable, max_brightness 64) a `frame`
// with the GRB that led_ws2812 would send; line `led_sent` {at_us} says when each write's datagram went (the pin's
// change on the pad's clock), printed after that write's STATE was stamped. --test-pin-tap gets each pin_pulse as `<us>` (beside --pin-target). --pin-listen also
// takes `level 0|1`: a fixture's open-drain line holding the boot button down (wired-AND with a pulse; line
// `pin_in` {level, at_us}). --fixture 1 is the virtual fixture: role fixture, board esp32s3-devkitc1-n16r8,
// profile s3k-fixture, chip 9, and s3k-fixture's table, status (fr.led, WS2812, max_brightness 32) on port 1 and
// fr.fixture ch0-ch13 on 2-15 (ch0-ch3 open-drain BOOT lines, ch4-ch5 LED level taps, ch6-ch7 WS2812 taps,
// ch8-ch11 test_pin taps with the pull-up, ch12-ch13 the M2-C3 pwm analog lines), each S1's FixtureService on
// a fake line, and no boot button. A pwm line (design m2-c3-inputs §3) takes set_duty: it keeps the duty, answers
// with the core clock's low 32 bits, and prints `duty` {name, duty, at_us} for every change (release: duty 0); it
// sends nothing over its wire.
// `--line <ch>=<port>` wires a channel: a driving line sends its wire's `level` to that port (a pad's
// --pin-listen) and reads it back; an input line listens on it (0: any free one) for a pad's taps. Each line
// prints `line` {name, port, drive, decode, pull}; stdin `line <ch> <port>` rewires a driving line, `lines`
// prints `lines` {items: [{name, level, pressing, port}]}. `state` adds health (fr_ota's bits) and hub_session.
//
// M2-C2 (design m2-c2 D2): the node classes live in the fleet kit (sim/, library fr_sim: Device, NodeCap, NodeDiag,
// NodeOtaHost, the blobs, the state printers and this stdin table as frsim::Commands), shared with fr_fleet. This
// file keeps main(), HostCore and its poll() loop, its blocking links, FakeAir, the wires and the virtual fixture,
// so its I/O timing and its lines do not change. NodeDiag adds `inject <inst> <gesture>` and `neighbors [from]` in
// fr_diag's shapes (D11). `--net-log 1` attaches the kit's log source (D20): HELLO caps net_log, fr_core's `ready
// id=…` banner at boot and `alive fw=…` every 10 s, fr_ota's `slot … open` line, and stdin `log <E|W|I|D|V> <tag>
// <text>`; Net drains them as LOG frames over TCP, and with --serial each also goes out on the USB line (stdout) as
// fr_serial prints it. Without it a `log` line goes only to the USB line.
// Test code: it may allocate.
#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/uio.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdarg>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "fr/core/core.hpp"
#include "fr/core/node_net.hpp"
#include "fr/core/port.hpp"
#include "fr/net/net.hpp"
#include "fr/serial_line.hpp"
#include "fr/services/button_service.hpp"
#include "fr/services/fixture_service.hpp"
#include "fr/services/led_service.hpp"
#include "sim/commands.hpp"
#include "sim/node.hpp"
#include "sim/out.hpp"
#include "tools/ota_fake.hpp"
// The ESP-NOW driver's IDF-free send discipline; not on the include path, as it is private to fr_net/src/esp.
#include "../../../components/fr_net/src/esp/air_sched.hpp"

namespace {

using fr::TimeUs;
using fr::net::LinkKind;
using frsim::parse_hex;

/** The process's one output: stdout, untagged, as cpp-node.ts and every interop suite parse it. */
frsim::StdOut g_out;

__attribute__((format(printf, 1, 2))) void emit(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    g_out.vemit(fmt, ap);
    va_end(ap);
}
constexpr TimeUs kNever = INT64_MAX;

/** The core task on the host: a monotonic clock, timer and input-slot pools, a post queue (EspCore order). */
class HostCore final : public fr::Core
{
public:
    HostCore() : start_(std::chrono::steady_clock::now()) {}

    TimeUs now() const override
    {
        // Not 0 at start, like esp_timer after boot.
        return 1'000'000 +
               std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - start_).count();
    }

    fr::Timer *timer(fr::Callback<void(), 24> on_fire) override
    {
        if (timers_used_ == timers_.size()) {
            return nullptr;
        }
        HostTimer &t = timers_[timers_used_++];
        t.core = this;
        t.on_fire = on_fire;
        return &t;
    }

    fr::InputSlot *input_slot(fr::Callback<void(const fr::InputSample &), 24> on_change) override
    {
        if (slots_used_ == slots_.size()) {
            return nullptr;
        }
        HostSlot &s = slots_[slots_used_++];
        s.on_change = on_change;
        return &s;
    }

    bool post(fr::Callback<void(), 32> fn) override
    {
        posts_.push_back(fn);
        return true;
    }

    /** Input slots, due timers (earliest first), posted functions, until nothing is ready. */
    void run_ready()
    {
        for (;;) {
            bool any = false;
            for (size_t i = 0; i < slots_used_; ++i) {
                HostSlot &s = slots_[i];
                if (s.pending) {
                    fr::InputSample sample = s.sample;
                    s.sample.edges = 0;
                    s.pending = false;
                    s.on_change(sample);
                    any = true;
                }
            }
            if (HostTimer *t = earliest(); t != nullptr && t->deadline <= now()) {
                t->armed = false;
                t->on_fire();
                any = true;
            }
            if (!posts_.empty()) {
                fr::Callback<void(), 32> fn = posts_.front();
                posts_.pop_front();
                fn();
                any = true;
            }
            if (!any) {
                return;
            }
        }
    }

    TimeUs next_deadline() const
    {
        const HostTimer *t = earliest();
        return t != nullptr ? t->deadline : kNever;
    }

private:
    struct HostTimer final : fr::Timer {
        HostCore *core = nullptr;
        fr::Callback<void(), 24> on_fire;
        bool armed = false;
        TimeUs deadline = 0;
        uint64_t order = 0;

        void start(uint32_t delay_us) override
        {
            armed = true;
            deadline = core->now() + delay_us;
            order = ++core->order_;
        }
        void stop() override { armed = false; }
        bool running() const override { return armed; }
    };

    struct HostSlot final : fr::InputSlot {
        fr::Callback<void(const fr::InputSample &), 24> on_change;
        bool pending = false;
        fr::InputSample sample{};

        void update_from_isr(bool level, TimeUs at) override
        {
            sample.level = level;
            sample.at = at;
            ++sample.edges;
            pending = true;
        }
    };

    const HostTimer *earliest() const
    {
        const HostTimer *best = nullptr;
        for (size_t i = 0; i < timers_used_; ++i) {
            const HostTimer &t = timers_[i];
            if (t.armed &&
                (best == nullptr || t.deadline < best->deadline || (t.deadline == best->deadline && t.order < best->order))) {
                best = &t;
            }
        }
        return best;
    }
    HostTimer *earliest() { return const_cast<HostTimer *>(std::as_const(*this).earliest()); }

    std::chrono::steady_clock::time_point start_;
    uint64_t order_ = 0;
    // The virtual fixture's 14 lines take 4 each (FixtureService's flush, the fake line's three).
    std::array<HostTimer, 80> timers_{};
    size_t timers_used_ = 0;
    std::array<HostSlot, 4> slots_{};
    size_t slots_used_ = 0;
    std::deque<fr::Callback<void(), 32>> posts_;
};

/**
 * One loopback UDP socket, bound to `port` (0: any) when `listen`, else unbound for sending. A listening one has
 * the kernel stamp each datagram's arrival (SO_TIMESTAMP), which recv_stamped reads.
 */
int open_udp(bool listen, uint16_t &port)
{
    const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0 || !listen) {
        return fd;
    }
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = htons(port);
    socklen_t len = sizeof(a);
    if (::bind(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 ||
        ::getsockname(fd, reinterpret_cast<sockaddr *>(&a), &len) != 0) {
        ::close(fd);
        return -1;
    }
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    const int on = 1;
    (void)::setsockopt(fd, SOL_SOCKET, SO_TIMESTAMP, &on, sizeof(on));
    port = ntohs(a.sin_port);
    return fd;
}

/**
 * One datagram from a wire's socket (open_udp listen), and `at`: when it arrived, on the core clock. A wire edge
 * is stamped at its arrival, as the GPIO ISR stamps esp_timer at the pin's edge on target, not when this process
 * got to read it: on a loaded host poll() wakes a process milliseconds late, and that is no time the pin changed.
 * The kernel's arrival stamp (SO_TIMESTAMP) is wall time, taken to the core clock by how long ago it was; without
 * one, `at` is now.
 */
ssize_t recv_stamped(int fd, char *buf, size_t len, const HostCore &core, TimeUs &at)
{
    iovec iov{.iov_base = buf, .iov_len = len};
    alignas(cmsghdr) char ctrl[CMSG_SPACE(sizeof(timeval))];
    msghdr m{};
    m.msg_iov = &iov;
    m.msg_iovlen = 1;
    m.msg_control = ctrl;
    m.msg_controllen = sizeof(ctrl);
    const ssize_t got = ::recvmsg(fd, &m, 0);
    at = core.now();
    if (got < 0 || (m.msg_flags & MSG_CTRUNC) != 0) {
        return got;
    }
    for (cmsghdr *c = CMSG_FIRSTHDR(&m); c != nullptr; c = CMSG_NXTHDR(&m, c)) {
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_TIMESTAMP) {
            timeval arrived{};
            std::memcpy(&arrived, CMSG_DATA(c), sizeof(arrived));
            timeval wall{};
            ::gettimeofday(&wall, nullptr);
            const TimeUs now = core.now();  // read right after the wall clock: one instant on both
            const int64_t ago =
                (static_cast<int64_t>(wall.tv_sec) - arrived.tv_sec) * 1'000'000 + (wall.tv_usec - arrived.tv_usec);
            // A wall clock stepped since: never after now, no further back than 10 s.
            at = now - std::clamp<int64_t>(ago, 0, 10'000'000);
        }
    }
    return got;
}

/** Text datagrams to one loopback UDP port: the wires between fr_net_node processes (T-LAT, the HIL taps). */
class UdpOut
{
public:
    explicit UdpOut(uint16_t port = 0) { retarget(port); }
    ~UdpOut()
    {
        if (fd_ >= 0) {
            ::close(fd_);
        }
    }
    UdpOut(const UdpOut &) = delete;
    UdpOut &operator=(const UdpOut &) = delete;

    /** Wired (a port given). */
    bool on() const { return fd_ >= 0 && port_ != 0; }
    uint16_t port() const { return port_; }
    void retarget(uint16_t port)
    {
        port_ = port;
        if (fd_ < 0 && port != 0) {
            uint16_t unused = 0;
            fd_ = open_udp(false, unused);
        }
    }
    void send(std::string_view text) const
    {
        if (!on()) {
            return;
        }
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = htons(port_);
        ::sendto(fd_, text.data(), text.size(), 0, reinterpret_cast<const sockaddr *>(&a), sizeof(a));
    }

private:
    int fd_ = -1;
    uint16_t port_ = 0;
};

/** One datagram off a wire: `level 0|1`, `<us>` (a pulse) or `frame <grb> <bits>`; nullopt for anything else. */
struct WireMsg {
    enum Kind : uint8_t { level, pulse, frame } kind = level;
    bool high = false;  // level
    uint32_t us = 0;    // pulse (10-100000 µs, as pin_pulse takes)
    uint32_t grb = 0;   // frame
    uint8_t bits = 0;   // frame
};

std::optional<WireMsg> parse_wire(std::string_view text)
{
    unsigned long a = 0;
    unsigned long b = 0;
    const std::string t(text);
    if (t == "level 0" || t == "level 1") {
        return WireMsg{.kind = WireMsg::level, .high = t.back() == '1'};
    }
    if (std::sscanf(t.c_str(), "frame %lu %lu", &a, &b) == 2 && a <= 0xFFFFFF && b <= 255) {
        return WireMsg{.kind = WireMsg::frame, .grb = static_cast<uint32_t>(a), .bits = static_cast<uint8_t>(b)};
    }
    if (!t.empty() && t.find_first_not_of("0123456789") == std::string::npos && t.size() <= 9) {
        a = std::strtoul(t.c_str(), nullptr, 10);
        // As before M2-C1: a length out of range is a 2 ms pulse.
        return WireMsg{.kind = WireMsg::pulse, .us = a >= 10 && a <= 100000 ? static_cast<uint32_t>(a) : 2000};
    }
    return std::nullopt;
}

/**
 * The boot button: released unless --pin-listen wires it to another node's test pin (T-LAT on loopback, design c6
 * §6 S6). A pulse presses it now and releases it after the pulse, each edge through the input slot as the GPIO
 * ISR feeds it on target, so ButtonService debounces and emits down, up and click as for a real press. inject
 * drives ButtonService directly, as before.
 */
class WiredButton final : public fr::hal::ButtonSource
{
public:
    explicit WiredButton(HostCore &core) : core_(core) {}

    fr::Status init(fr::Core &core, fr::hal::ButtonSink &sink) override
    {
        sink_ = &sink;
        slot_ = core.input_slot([this](const fr::InputSample &s) { sink_->on_button_edge(s.level, s.at, s.edges); });
        release_ = core.timer([this] {
            pulsing_ = false;
            update(core_.now());
        });
        if (slot_ == nullptr || release_ == nullptr) {
            return std::unexpected(fr::Err::failed);
        }
        return {};
    }
    bool level_pressed() const override { return low_; }
    fr::hal::Selftest selftest() override { return {!low_, low_ ? "pressed at rest" : "idle level ok"}; }

    /** The wire went low for `us` at `at` (its datagram's arrival, recv_stamped); a pulse while one runs moves its
     * release. */
    void pulse(uint32_t us, TimeUs at)
    {
        pulsing_ = true;
        update(at);
        release_->start(us);
    }

    /** A fixture's open-drain line (`level 0|1`, design m2-c1-hil D4) changed at `at`: low holds the button down
     * until it lets go. Wired-AND with a pulse: the button reads released only once neither pulls the wire low. */
    void hold(bool low, TimeUs at)
    {
        held_ = low;
        update(at);
    }

private:
    /** The ISR's stamp is the edge's time: the wire's, not when this process ran. */
    void update(TimeUs at)
    {
        if (const bool low = pulsing_ || held_; low != low_) {
            low_ = low;
            slot_->update_from_isr(low, at);
        }
    }

    HostCore &core_;
    fr::hal::ButtonSink *sink_ = nullptr;
    fr::InputSlot *slot_ = nullptr;
    fr::Timer *release_ = nullptr;
    bool low_ = false;
    bool pulsing_ = false;
    bool held_ = false;
};

/** What drives the status LED's pin (--led-kind): its features, and what an LED tap sees on the pin. */
enum class LedKind : uint8_t {
    mono,      // a mono LED, active high (the default, as before M2-C1)
    gpio_low,  // led_gpio, active low: the C3 OLED pads
    ws2812,    // led_ws2812, RGB and dimmable: the C6 and S3 pads
};

/** The status LED: prints what it shows and, with --led-tap, sends what its pin carries (design m2-c1-hil §4 S2). */
class PadLight final : public fr::hal::LightOutput
{
public:
    /** A level tap says its level again this often: a wire keeps its level, whenever the fixture looks. */
    static constexpr TimeUs kRepeatUs = 250'000;

    PadLight(HostCore &core, LedKind kind, uint16_t tap) : core_(core), kind_(kind), tap_(tap) {}

    fr::Status init(fr::Core &) override { return {}; }
    fr::hal::LightFeatures features() const override
    {
        return {.rgb = kind_ == LedKind::ws2812, .dimmable = kind_ == LedKind::ws2812};
    }
    fr::Status write(const fr::hal::LightLevel &l) override
    {
        if (kind_ != LedKind::ws2812) {
            emit(R"({"ev":"led","on":%s})", l.on ? "true" : "false");
            pin_high_ = l.on == (kind_ == LedKind::mono);
            repeat_at_ = 0;  // tap() sends it now
            const TimeUs at = core_.now();
            tap(at);
            pinned(at);
            return {};
        }
        // led_ws2812.cpp: each component scaled by the brightness (0 when off), one 24-bit GRB refresh.
        const uint32_t b = l.on ? l.brightness : 0;
        const auto scale = [b](uint8_t c) { return (static_cast<uint32_t>(c) * b + 127) / 255; };
        const uint32_t grb = scale(l.color.g) << 16 | scale(l.color.r) << 8 | scale(l.color.b);
        emit(R"({"ev":"led","on":%s,"grb":%u})", l.on ? "true" : "false", grb);
        const std::string frame = "frame " + std::to_string(grb) + " 24";
        const TimeUs at = core_.now();
        tap_.send(frame);
        pinned(at);
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "ok"}; }

    /** A level tap's datagram, when due (each write, then every kRepeatUs); the main loop calls it. */
    void tap(TimeUs now)
    {
        if (kind_ == LedKind::ws2812 || !tap_.on() || now < repeat_at_) {
            return;
        }
        tap_.send(pin_high_ ? "level 1" : "level 0");
        repeat_at_ = now + kRepeatUs;
    }

    /**
     * Line `led_sent` {at_us} for each write's tap datagram: when the pin changed, on the pad's clock, read right
     * before the send. The main loop prints them, after the write's STATE was stamped (never in between: no log
     * line delays that STATE), so a test can tell a STATE the pad stamped at its pin change from one a loaded host
     * held it up for.
     */
    void log_sent()
    {
        for (const TimeUs at : sent_) {
            emit(R"({"ev":"led_sent","at_us":%lld})", static_cast<long long>(at));
        }
        sent_.clear();
    }

private:
    void pinned(TimeUs at)
    {
        if (tap_.on()) {
            sent_.push_back(at);
        }
    }

    HostCore &core_;
    LedKind kind_;
    UdpOut tap_;
    bool pin_high_ = false;  // known after LedService's first write (init writes off)
    TimeUs repeat_at_ = kNever;
    std::vector<TimeUs> sent_;  // write() taps not yet printed (log_sent)
};

/** TCP to the hub, `len u16 LE | envelope` (05 §5.12.2); reconnects 250 ms after a close, like hub_link.cpp. */
class TcpLink final : public fr::net::Link
{
public:
    TcpLink(HostCore &core, std::string host, uint16_t port) : core_(core), host_(std::move(host)), port_(port) {}

    LinkKind kind() const override { return LinkKind::tcp; }
    bool up() const override { return fd_ >= 0; }
    fr::Status send(std::span<const uint8_t> envelope) override
    {
        if (fd_ < 0 || envelope.size() > fr::proto::kMtuBulk) {
            return std::unexpected(fr::Err::busy);
        }
        std::vector<uint8_t> frame(envelope.size() + 2);
        frame[0] = static_cast<uint8_t>(envelope.size());
        frame[1] = static_cast<uint8_t>(envelope.size() >> 8);
        std::memcpy(frame.data() + 2, envelope.data(), envelope.size());
        size_t off = 0;
        while (off < frame.size()) {
            const ssize_t n = ::send(fd_, frame.data() + off, frame.size() - off, 0);
            if (n <= 0) {
                close_and_retry("send failed");
                return std::unexpected(fr::Err::failed);
            }
            off += static_cast<size_t>(n);
        }
        return {};
    }
    /** Net lost the session: close now, reconnect after the backoff (Net HELLOs on the new connection). */
    void drop(fr::net::DropReason) override { close_and_retry("dropped by Net"); }
    /** drop_hub_link: no reconnect while held; released, at once (hub_link.cpp's Hub::poll). */
    void hold(bool on) override
    {
        if (held_ && !on) {
            retry_at_ = 0;
        }
        held_ = on;
    }

    void bind(fr::net::Net &net) { net_ = &net; }
    int fd() const { return fd_; }
    /** Where received envelopes go: Net, and the WELCOME check for the OTA health bit. */
    std::function<void(LinkKind, std::span<const uint8_t>)> rx;
    TimeUs retry_at() const { return fd_ < 0 && enabled_ && !held_ ? retry_at_ : kNever; }
    /** `tcp 0|1`: off closes the connection and stops reconnecting (Wi-Fi gone), on lets it reconnect. */
    void enable(bool on)
    {
        enabled_ = on;
        if (!on) {
            close_and_retry("switched off");
        }
    }

    void try_connect()
    {
        if (fd_ >= 0 || !enabled_ || held_ || core_.now() < retry_at_) {
            return;
        }
        const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_port = htons(port_);
        ::inet_pton(AF_INET, host_.c_str(), &a.sin_addr);
        if (fd < 0 || ::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0) {
            if (fd >= 0) {
                ::close(fd);
            }
            retry_at_ = core_.now() + 250'000;
            return;
        }
        const int one = 1;
        ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
#ifdef SO_NOSIGPIPE
        ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
        fd_ = fd;
        rx_.clear();
        emit(R"({"ev":"tcp","up":true})");
        notify();
    }

    /** The socket is readable: whole envelopes go to Net. */
    void on_readable()
    {
        uint8_t buf[2048];
        const ssize_t n = ::recv(fd_, buf, sizeof(buf), 0);
        if (n <= 0) {
            close_and_retry(n == 0 ? "closed by the hub" : "recv failed");
            return;
        }
        rx_.insert(rx_.end(), buf, buf + n);
        size_t at = 0;
        while (rx_.size() - at >= 2) {
            const size_t len = rx_[at] | static_cast<size_t>(rx_[at + 1]) << 8;
            if (len == 0 || len > fr::proto::kMtuBulk) {
                close_and_retry("bad frame length");
                return;
            }
            if (rx_.size() - at - 2 < len) {
                break;
            }
            const std::vector<uint8_t> env(rx_.begin() + static_cast<long>(at + 2), rx_.begin() + static_cast<long>(at + 2 + len));
            at += 2 + len;
            rx(LinkKind::tcp, env);
            if (fd_ < 0) {
                return;  // Net dropped the link while handling it
            }
        }
        rx_.erase(rx_.begin(), rx_.begin() + static_cast<long>(at));
    }

private:
    void close_and_retry(const char *why)
    {
        if (fd_ < 0) {
            return;
        }
        ::close(fd_);
        fd_ = -1;
        rx_.clear();
        retry_at_ = core_.now() + 250'000;
        emit(R"({"ev":"tcp","up":false,"why":"%s"})", why);
        notify();
    }
    /** As on target, the link change reaches Net through the core queue, never re-entrantly. */
    void notify()
    {
        fr::net::Net *net = net_;
        core_.post([net] { net->link_changed(LinkKind::tcp); });
    }

    HostCore &core_;
    std::string host_;
    uint16_t port_;
    fr::net::Net *net_ = nullptr;
    int fd_ = -1;
    bool enabled_ = true;
    bool held_ = false;
    TimeUs retry_at_ = 0;
    std::vector<uint8_t> rx_;
};

/** The USB serial line as fr_serial carries it: `@fr1:` ENV lines, here on stdout (out) and stdin (in). */
class SerialLink final : public fr::net::Link
{
public:
    explicit SerialLink(HostCore &core) : core_(core) {}

    LinkKind kind() const override { return LinkKind::serial; }
    bool up() const override { return host_present_; }
    fr::Status send(std::span<const uint8_t> envelope) override
    {
        if (!host_present_) {
            return std::unexpected(fr::Err::busy);
        }
        char line[fr::wire::kMaxLine + 1];
        const size_t n = fr::wire::encode_line(fr::wire::kSerialEnv, envelope, std::span<char>(line, fr::wire::kMaxLine));
        if (n == 0) {
            return std::unexpected(fr::Err::invalid_args);
        }
        std::fwrite(line, 1, n, stdout);
        std::fputc('\n', stdout);
        std::fflush(stdout);
        return {};
    }

    void bind(fr::net::Net &net) { net_ = &net; }
    /** `usb 0|1`: the host appears or goes away (fr_core polls usb_serial_jtag_is_connected). */
    void set_host(bool present)
    {
        if (present != host_present_) {
            host_present_ = present;
            fr::net::Net *net = net_;
            core_.post([net] { net->link_changed(LinkKind::serial); });
        }
    }
    /** `hub_mute 0|1`: the hub's lines stop reaching the node while the USB host stays, so the link stays up (a hub
     * process that died with the port still enumerated: design m2-c1-hil D11 item 3). */
    void set_mute(bool on) { muted_ = on; }
    /** One line the hub wrote. */
    void on_line(std::string_view line)
    {
        uint8_t scratch[fr::wire::kMaxLineFrame];
        auto f = fr::wire::decode_line(line, scratch);
        if (f && f->type == fr::wire::kSerialEnv && host_present_ && !muted_) {
            rx(LinkKind::serial, f->body);
        }
    }

    std::function<void(LinkKind, std::span<const uint8_t>)> rx;

private:
    HostCore &core_;
    fr::net::Net *net_ = nullptr;
    bool host_present_ = true;
    bool muted_ = false;
};

/** One datagram per envelope to the hub; the node never listens on UDP (05 §5.10). */
class UdpLink final : public fr::net::Link
{
public:
    UdpLink(const std::string &host, uint16_t port)
    {
        fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
        to_.sin_family = AF_INET;
        to_.sin_port = htons(port);
        ::inet_pton(AF_INET, host.c_str(), &to_.sin_addr);
    }
    ~UdpLink() { ::close(fd_); }
    LinkKind kind() const override { return LinkKind::udp; }
    bool up() const override { return fd_ >= 0 && enabled_; }
    fr::Status send(std::span<const uint8_t> envelope) override
    {
        if (!enabled_) {
            return std::unexpected(fr::Err::busy);
        }
        const ssize_t n = ::sendto(fd_, envelope.data(), envelope.size(), 0, reinterpret_cast<const sockaddr *>(&to_), sizeof(to_));
        if (n != static_cast<ssize_t>(envelope.size())) {
            return std::unexpected(fr::Err::busy);
        }
        return {};
    }

    /** `wifi_down`: no route to the hub while Wi-Fi is away. */
    void enable(bool on) { enabled_ = on; }

private:
    int fd_ = -1;
    bool enabled_ = true;
    sockaddr_in to_{};
};

struct Options {
    std::string host = "127.0.0.1";
    uint16_t hub_tcp = 0;
    uint16_t hub_udp = 0;
    std::array<uint8_t, 6> mac{};
    uint16_t addr = fr::proto::kAddrUnassigned;
    uint16_t net = 0;
    uint16_t epoch = 1;
    uint32_t hb_ms = 1000;
    std::string alias;
    uint32_t alias_rev = 0;
    std::array<uint8_t, 8> fw{0x3f, 0x2a, 0x9c, 0x01, 0xb2, 0xd4, 0x00, 0x11};
    bool serial = false;
    // OTA (design c4 §5).
    std::optional<ota_fake::Digest> fw_id;  // the running image's full fw_id; else `fw` padded with zeros
    uint16_t hub_http = fr::ota::kHttpPort;
    std::string ota_dir;
    std::string version = "0.1.0";
    uint32_t health_ms = fr::ota::kHealthDeadlineMs;
    bool fault_health = false;
    // The fake air medium (design c5 §5).
    std::string air_dir;
    uint32_t air_loss = 0;  // percent of received datagrams dropped
    uint32_t air_seed = 1;
    int8_t air_rssi = -50;
    uint8_t air_channel = 6;
    /** A unicast without its ACK this long failed: 250 B at 1 Mbps is about 2 ms, plus the ACK. Interop tests
     * on a loaded host give the receiving process more time to answer. */
    uint32_t air_ack_ms = 3;
    // The T-LAT wire on loopback (design c6 §6 S6).
    uint16_t pin_target = 0;  // pin_pulse sends here (0: no test pin)
    bool pin_listen = false;
    uint16_t pin_listen_port = 0;  // 0 with pin_listen: any free port
    // M2-C1 (design m2-c1-hil §4 S2).
    fr::proto::Role role = fr::proto::Role::node;
    bool role_set = false;  // --role given: --fixture keeps it
    std::string board = "esp32c6-supermini";
    std::string profile = "c6-pad";
    uint8_t chip = 13;  // the image chip id: C3 5, S3 9, C6 13
    bool board_set = false;
    bool profile_set = false;
    bool chip_set = false;
    LedKind led_kind = LedKind::mono;
    uint16_t led_tap = 0;       // LedService writes go here as the LED pin carries them (0: no tap)
    uint16_t test_pin_tap = 0;  // pin_pulse also goes here (0: no tap)
    bool fixture = false;
    std::vector<std::pair<std::string, uint16_t>> lines;  // --line <ch>=<port>
    bool net_log = false;  // M2-C2: LOG frames over TCP (design m2-c2 D20)

    /** TCP and UDP to the hub; without them the node is serial only (a radio-off build). */
    bool ip() const { return hub_tcp != 0; }
};

/**
 * The fake air medium (design c5 §5 interop): ESP-NOW as UDP datagrams on loopback. Each node binds a port
 * and registers it as `<air-dir>/<mac>.port`; a broadcast is one datagram to every registered port but its
 * own, a unicast one to the destination MAC's port, whose node answers with an ACK datagram: the MAC ACK. Loss
 * drops received datagrams, data and ACKs alike (a lost ACK makes the sender retry, so the receiver sees the
 * duplicate a real link would give it). On top runs the target driver's send discipline (air_sched.hpp) and
 * receive filter (channel C, magic, net), so Net meets the air as on target.
 *
 * A datagram: `type ('D' data, 'A' ack) | src mac 6 | dst mac 6 | channel | id u32 LE | envelope`.
 */
class FakeAir final : public fr::net::AirLink, public fr::net::air::Radio
{
public:
    /** The registry is read again at most this often (and when a unicast's MAC is not in it). */
    static constexpr TimeUs kRefreshUs = 250'000;
    static constexpr size_t kHead = 1 + 6 + 6 + 1 + 4;

    struct Counters {
        uint32_t tx = 0;      // datagrams sent (a broadcast counts once per receiver)
        uint32_t rx = 0;      // frames handed to Net
        uint32_t rx_bad = 0;  // dropped by the receive filter (channel C, magic, net, size)
        uint32_t lost = 0;    // dropped by --air-loss
        uint32_t acks = 0;    // MAC ACKs sent
    };

    FakeAir(HostCore &core, const Options &o) : core_(core), o_(o), loss_(o.air_loss), rng_(o.air_seed != 0 ? o.air_seed : 1)
    {
        std::copy(o.mac.begin(), o.mac.end(), mac_.begin());
    }
    FakeAir(const FakeAir &) = delete;
    FakeAir &operator=(const FakeAir &) = delete;
    ~FakeAir()
    {
        if (fd_ >= 0) {
            ::close(fd_);
            std::remove(registration().c_str());
        }
    }

    /** Binds a loopback port and registers it (creating --air-dir, so the first node of a medium can). */
    bool open()
    {
        if (::mkdir(o_.air_dir.c_str(), 0700) != 0 && errno != EEXIST) {
            return false;
        }
        fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t len = sizeof(a);
        if (fd_ < 0 || ::bind(fd_, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 ||
            ::getsockname(fd_, reinterpret_cast<sockaddr *>(&a), &len) != 0) {
            return false;
        }
        ::fcntl(fd_, F_SETFL, ::fcntl(fd_, F_GETFL, 0) | O_NONBLOCK);
        port_ = ntohs(a.sin_port);
        ota_fake::write_file(registration(), std::to_string(port_));
        if (!ota_fake::read_file(registration())) {
            return false;  // unregistered, it would hear nothing and reach no one
        }
        emit(R"({"ev":"air","up":true,"port":%u,"channel":%u})", unsigned{port_}, unsigned{o_.air_channel});
        return true;
    }

    void bind(fr::net::Net &net) { net_ = &net; }
    int fd() const { return fd_; }
    void set_loss(uint32_t pct) { loss_ = std::min<uint32_t>(pct, 100); }
    const Counters &counters() const { return n_; }
    const fr::net::air::Scheduler &scheduler() const { return sched_; }

    // fr::net::AirLink
    bool up() const override { return fd_ >= 0; }
    fr::Status send(const fr::net::Mac &dst, std::span<const uint8_t> envelope, fr::net::AirPrio prio,
                    uint32_t token) override
    {
        return sched_.send(dst, envelope, prio, token, core_.now());
    }
    bool pin_peer(const fr::net::Mac *mac) override { return sched_.pin(mac, core_.now()); }
    void bridge_peers() override { sched_.set_bridge(true); }

    // fr::net::air::Radio: peers need no setup here; the verdict comes from poll(), never from inside transmit().
    bool add_peer(const fr::net::Mac &) override { return true; }
    void del_peer(const fr::net::Mac &) override {}
    bool transmit(const fr::net::Mac &dst, std::span<const uint8_t> frame) override
    {
        const uint32_t id = ++tx_id_;
        const TimeUs now = core_.now();
        if (fr::net::air::is_broadcast(dst)) {
            refresh(now, false);
            for (const auto &[mac, port] : peers_) {
                if (mac != mac_) {
                    datagram('D', dst, id, frame, port);
                }
            }
            verdict(now, true);  // a broadcast is never ACKed: out is all it can say
            return true;
        }
        uint16_t port = lookup(dst, now);
        if (port != 0) {
            datagram('D', dst, id, frame, port);
        }
        awaiting_ = id;
        verdict(now + static_cast<TimeUs>(o_.air_ack_ms) * 1000, false);  // unless the ACK comes first
        return true;
    }
    void arm(uint32_t delay_us) override { timer_at_ = core_.now() + delay_us; }
    void disarm() override { timer_at_ = kNever; }
    void done(uint32_t token, bool ok) override { net_->air_sent(token, ok); }

    /** The socket is readable: frames to Net (after the filter, ACKing unicasts), ACKs to the verdict. */
    void on_readable()
    {
        uint8_t buf[kHead + fr::net::air::kMtu + 64];
        for (;;) {
            const ssize_t got = ::recv(fd_, buf, sizeof(buf), 0);
            if (got <= 0) {
                return;
            }
            const size_t len = static_cast<size_t>(got);
            if (len < kHead || lose()) {
                n_.lost += len >= kHead ? 1 : 0;
                continue;
            }
            fr::net::Mac src{};
            fr::net::Mac dst{};
            std::copy_n(buf + 1, 6, src.begin());
            std::copy_n(buf + 7, 6, dst.begin());
            const uint8_t channel = buf[13];
            const uint32_t id = buf[14] | buf[15] << 8 | buf[16] << 16 | static_cast<uint32_t>(buf[17]) << 24;
            const bool to_broadcast = fr::net::air::is_broadcast(dst);
            if ((dst != mac_ && !to_broadcast) || channel != o_.air_channel) {
                continue;  // not heard: another node's unicast, or another channel
            }
            if (buf[0] == 'A') {
                if (!to_broadcast && awaiting_ != 0 && id == awaiting_) {
                    awaiting_ = 0;
                    verdict(core_.now(), true);
                }
                continue;
            }
            if (!to_broadcast) {
                // The MAC ACK comes from the radio, before (and whatever) the driver's filter decides.
                ++n_.acks;
                datagram('A', src, id, {}, lookup(src, core_.now()));
            }
            const std::span<const uint8_t> env(buf + kHead, len - kHead);
            if (env.size() < fr::wire::kHeaderSize || env.size() > fr::net::air::kMtu || env[0] != fr::wire::kMagicVer ||
                static_cast<uint16_t>(env[8] | env[9] << 8) != o_.net) {
                ++n_.rx_bad;
                continue;
            }
            ++n_.rx;
            const fr::net::RxMeta meta{.src_mac = src, .to_broadcast = to_broadcast, .rssi = o_.air_rssi, .channel = channel};
            net_->receive_air(env, meta);
            if (fd_ < 0) {
                return;
            }
        }
    }

    /** The send callback's verdict and the driver timer, when due. */
    void poll()
    {
        const TimeUs now = core_.now();
        if (awaiting_ != 0 && now >= verdict_at_) {
            // A process the host did not schedule for a while finds its ACK waiting in the socket: the radio
            // would have taken it in time, so it counts before the wait is called lost.
            on_readable();
        }
        if (verdict_at_ != kNever && now >= verdict_at_) {
            verdict_at_ = kNever;
            awaiting_ = 0;
            sched_.sent(verdict_ok_, now);
        }
        if (timer_at_ != kNever && now >= timer_at_) {
            timer_at_ = kNever;
            sched_.timer(now);
        }
    }

    TimeUs next_deadline() const { return std::min(verdict_at_, timer_at_); }

private:
    std::string registration() const { return o_.air_dir + "/" + ota_fake::hex(mac_) + ".port"; }

    bool lose()
    {
        if (loss_ == 0) {
            return false;
        }
        rng_ ^= rng_ << 13;
        rng_ ^= rng_ >> 17;
        rng_ ^= rng_ << 5;
        if (rng_ % 100 < loss_) {
            return true;
        }
        return false;
    }

    void verdict(TimeUs at, bool ok)
    {
        verdict_at_ = at;
        verdict_ok_ = ok;
    }

    void datagram(char type, const fr::net::Mac &dst, uint32_t id, std::span<const uint8_t> envelope, uint16_t port)
    {
        if (port == 0) {
            return;
        }
        uint8_t buf[kHead + fr::net::air::kMtu];
        buf[0] = static_cast<uint8_t>(type);
        std::copy(mac_.begin(), mac_.end(), buf + 1);
        std::copy(dst.begin(), dst.end(), buf + 7);
        buf[13] = o_.air_channel;
        for (int i = 0; i < 4; ++i) {
            buf[14 + i] = static_cast<uint8_t>(id >> (8 * i));
        }
        std::copy(envelope.begin(), envelope.end(), buf + kHead);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = htons(port);
        ::sendto(fd_, buf, kHead + envelope.size(), 0, reinterpret_cast<const sockaddr *>(&a), sizeof(a));
        ++n_.tx;
    }

    uint16_t lookup(const fr::net::Mac &mac, TimeUs now)
    {
        for (int pass = 0; pass < 2; ++pass) {
            for (const auto &[m, port] : peers_) {
                if (m == mac) {
                    return port;
                }
            }
            if (pass == 0) {
                refresh(now, true);
            }
        }
        return 0;
    }

    /** Reads `<mac>.port` registrations (at most every kRefreshUs unless `force`). */
    void refresh(TimeUs now, bool force)
    {
        if (!force && now - refreshed_ < kRefreshUs && refreshed_ != 0) {
            return;
        }
        refreshed_ = now;
        peers_.clear();
        DIR *d = ::opendir(o_.air_dir.c_str());
        if (d == nullptr) {
            return;
        }
        while (const dirent *e = ::readdir(d)) {
            const std::string_view name = e->d_name;
            fr::net::Mac m{};
            if (name.size() != 17 || !name.ends_with(".port") || !parse_hex(name.substr(0, 12), m)) {
                continue;
            }
            if (auto text = ota_fake::read_file(o_.air_dir + "/" + std::string(name))) {
                const unsigned long port = std::strtoul(text->c_str(), nullptr, 10);
                if (port > 0 && port <= 65535) {
                    peers_.emplace_back(m, static_cast<uint16_t>(port));
                }
            }
        }
        ::closedir(d);
    }

    static bool parse_hex(std::string_view s, std::span<uint8_t> out) { return ota_fake::unhex(s, out); }

    HostCore &core_;
    const Options &o_;
    fr::net::Mac mac_{};
    fr::net::Net *net_ = nullptr;
    fr::net::air::Scheduler sched_{*this};
    int fd_ = -1;
    uint16_t port_ = 0;
    uint32_t loss_ = 0;
    uint32_t rng_ = 1;
    uint32_t tx_id_ = 0;
    uint32_t awaiting_ = 0;  // the unicast whose ACK is awaited (its datagram id)
    TimeUs verdict_at_ = kNever;
    bool verdict_ok_ = false;
    TimeUs timer_at_ = kNever;
    TimeUs refreshed_ = 0;
    std::vector<std::pair<fr::net::Mac, uint16_t>> peers_;
    Counters n_;
};

/**
 * One fixture line on loopback (design m2-c1-hil D4, §4 S2), under FixtureService as fixture_gpio and
 * fixture_ws2812_rx are on target. A driving line (open_drain, nfet_gate) runs its segments from core timers and
 * sends its wire's level to a pad's --pin-listen port (`level 0` while it pulls the pad's BOOT low), reading its
 * own line back: each change is a captured edge. The line is released min(total, cap) + 5 ms after a press
 * started, whatever happens. An input line listens on its own port for a pad's taps: `level 0|1` (an LED pin;
 * an edge when it changes), `<us>` (a test_pin pulse: low now, and released `us` later, stamped at that time so
 * the width is exact on a loaded host) and, on a decode ws2812 line only, `frame <grb> <bits>`. Edges carry the
 * core clock's low 32 bits, as the ISR stamps esp_timer; captures reach the service through drain(), posted to
 * the core task. An unwired input line reads high (pulled up, or an LED off); a WS2812 line reads low. A pwm line
 * (M2-C3) holds a duty: set_duty and release change it, and it reads duty > 0; it never presses or captures.
 */
class FakeFixtureLine final : public fr::hal::FixtureLine
{
public:
    /** Edges held between drains, as fixture_gpio's ring; more count as dropped. */
    static constexpr size_t kRing = 256;

    FakeFixtureLine(HostCore &core, std::string name) : core_(core), name_(std::move(name)) {}
    FakeFixtureLine(const FakeFixtureLine &) = delete;
    FakeFixtureLine &operator=(const FakeFixtureLine &) = delete;
    ~FakeFixtureLine()
    {
        if (fd_ >= 0) {
            ::close(fd_);
        }
    }

    const std::string &name() const { return name_; }
    bool driving() const { return mode_.drive != fr::hal::FixtureDrive::none; }
    int fd() const { return fd_; }
    /** The wired port: a driving line's target, an input line's own. */
    uint16_t port() const { return driving() ? out_.port() : in_port_; }
    /** A driving line: the pad's --pin-listen port its wire goes to (0: not wired). */
    void wire_to(uint16_t port) { out_.retarget(port); }
    /** An input line: listens on `port` (0: any free one); false when it cannot. */
    bool listen(uint16_t port)
    {
        fd_ = open_udp(true, port);
        in_port_ = fd_ >= 0 ? port : 0;
        return fd_ >= 0;
    }

    /** The socket is readable: each tap datagram, as the pin would show it, stamped at its arrival (recv_stamped:
     * the capture ISR's time on target, not this process's late wake on a loaded host). */
    void on_readable()
    {
        char buf[64];
        for (;;) {
            TimeUs at = 0;
            const ssize_t got = recv_stamped(fd_, buf, sizeof(buf), core_, at);
            if (got <= 0) {
                return;
            }
            const std::optional<WireMsg> m = parse_wire(std::string_view(buf, static_cast<size_t>(got)));
            const bool ws2812 = mode_.decode == fr::hal::FixtureDecode::ws2812;
            if (!m || driving()) {
                continue;
            }
            if (m->kind == WireMsg::frame && ws2812) {
                frames_.push_back({.start_us = static_cast<uint32_t>(at), .bits = m->bits, .grb = m->grb});
                schedule_drain();
            } else if (m->kind == WireMsg::level && !ws2812 && m->high != level_) {
                capture(m->high, at);
            } else if (m->kind == WireMsg::pulse && !ws2812) {
                // A pulse while one runs moves its release, as on the pad's own wire.
                if (level_) {
                    capture(false, at);
                }
                pulse_end_at_ = at + m->us;
                pulse_end_->start(static_cast<uint32_t>(std::max<TimeUs>(0, pulse_end_at_ - core_.now())));
            }
        }
    }

    // fr::hal::FixtureLine
    fr::Status init(fr::Core &core, const fr::hal::FixtureLineMode &mode, fr::hal::EdgeSink &sink) override
    {
        mode_ = mode;
        sink_ = &sink;
        step_ = core.timer([this] { step(); });
        cap_ = core.timer([this] { (void)release(); });
        pulse_end_ = core.timer([this] {
            if (!level_) {
                capture(true, pulse_end_at_);
            }
        });
        if (step_ == nullptr || cap_ == nullptr || pulse_end_ == nullptr) {
            return std::unexpected(fr::Err::failed);
        }
        level_ = released_level();
        return {};
    }

    std::expected<fr::hal::FixturePress, fr::Err> press(std::span<const uint32_t> segments_us, uint32_t cap_us) override
    {
        if (!driving()) {
            return std::unexpected(fr::Err::unsupported);
        }
        if (pressing_ || level_ != released_level()) {
            return std::unexpected(fr::Err::busy);
        }
        if (segments_us.empty() || segments_us.size() > segs_.size()) {
            return std::unexpected(fr::Err::invalid_args);
        }
        uint64_t sum = 0;
        for (const uint32_t seg : segments_us) {
            sum += seg;
        }
        nsegs_ = segments_us.size();
        std::copy(segments_us.begin(), segments_us.end(), segs_.begin());
        total_us_ = static_cast<uint32_t>(std::min<uint64_t>(sum, cap_us));
        seg_ = 0;
        planned_us_ = 0;
        pressing_ = true;
        const TimeUs now = core_.now();
        drive(true, now);
        arm_segment();
        cap_->start(total_us_ + 5'000);
        return fr::hal::FixturePress{.at_us = static_cast<uint32_t>(now), .total_us = total_us_};
    }

    fr::Status release() override
    {
        if (mode_.drive == fr::hal::FixtureDrive::pwm) {
            apply_duty(0);  // design m2-c3-inputs §3: a pwm line's release is duty 0
            return {};
        }
        step_->stop();
        cap_->stop();
        pressing_ = false;
        if (driving() && level_ != released_level()) {
            drive(false, core_.now());
        }
        return {};
    }

    bool pressing() const override { return pressing_; }
    bool level() const override { return mode_.drive == fr::hal::FixtureDrive::pwm ? duty_ > 0 : level_; }

    std::expected<uint32_t, fr::Err> set_duty(uint16_t duty) override
    {
        if (mode_.drive != fr::hal::FixtureDrive::pwm) {
            return std::unexpected(fr::Err::unsupported);
        }
        if (duty > fr::hal::kFixtureDutyMax) {
            return std::unexpected(fr::Err::invalid_args);
        }
        return apply_duty(duty);
    }

    void drain() override
    {
        drain_posted_ = false;
        if (!edges_.empty() || dropped_ != 0) {
            const std::vector<fr::hal::FixtureEdge> edges = std::move(edges_);
            edges_.clear();
            const uint32_t dropped = std::exchange(dropped_, 0);
            sink_->on_edges(edges, dropped);
        }
        for (const fr::hal::FixtureFrame &f : std::exchange(frames_, {})) {
            sink_->on_frame(f);
        }
    }

    fr::hal::Selftest selftest() override
    {
        const bool idle = pressing_ || level_ == released_level();
        return {idle, idle ? "line reads released" : "line does not read released"};
    }

private:
    /** The level the pin reads at rest: an open-drain line pulled up by the DUT, a MOSFET gate low. */
    bool released_level() const
    {
        if (mode_.drive == fr::hal::FixtureDrive::nfet_gate || mode_.decode == fr::hal::FixtureDecode::ws2812) {
            return false;
        }
        return true;
    }

    /** Drives the line pressed or released at `at`: the pin's own edge (readback, or nfet_gate's write stamp) and
     * the DUT's BOOT wire (`level 0` while pressed: wired-AND through the open drain or the MOSFET). */
    void drive(bool pressed, TimeUs at)
    {
        const bool pin = mode_.drive == fr::hal::FixtureDrive::nfet_gate ? pressed : !pressed;
        capture(pin, at);
        out_.send(pressed ? "level 0" : "level 1");
    }

    /** The current segment's timer, clamped so that the run ends at total_us_. */
    void arm_segment()
    {
        const uint32_t left = total_us_ - planned_us_;
        const uint32_t d = std::min(segs_[seg_], left);
        planned_us_ += d;
        step_->start(d);
    }

    /** Segment seg_ ended: the next one (press on even, release on odd), or the end of the run. */
    void step()
    {
        ++seg_;
        if (seg_ >= nsegs_ || planned_us_ >= total_us_) {
            (void)release();
            return;
        }
        drive(seg_ % 2 == 0, core_.now());
        arm_segment();
    }

    void capture(bool level, TimeUs at)
    {
        level_ = level;
        if (edges_.size() == kRing) {
            ++dropped_;
        } else {
            edges_.push_back({.t_us = static_cast<uint32_t>(at), .level = level});
        }
        schedule_drain();
    }

    /** A pwm line's duty is `duty` from now: `duty` {name, duty, at_us} when it changed. */
    uint32_t apply_duty(uint16_t duty)
    {
        const auto at = static_cast<uint32_t>(core_.now());
        if (duty != duty_) {
            duty_ = duty;
            emit(R"({"ev":"duty","name":"%s","duty":%u,"at_us":%u})", name_.c_str(), unsigned{duty}, unsigned{at});
        }
        return at;
    }

    /** As the driver: drain() runs on the core task soon after a capture, never inside it. */
    void schedule_drain()
    {
        if (!drain_posted_) {
            drain_posted_ = true;
            core_.post([this] { drain(); });
        }
    }

    HostCore &core_;
    std::string name_;
    fr::hal::FixtureLineMode mode_{};
    fr::hal::EdgeSink *sink_ = nullptr;
    UdpOut out_;
    int fd_ = -1;
    uint16_t in_port_ = 0;
    fr::Timer *step_ = nullptr;
    fr::Timer *cap_ = nullptr;
    fr::Timer *pulse_end_ = nullptr;
    bool level_ = true;
    bool pressing_ = false;
    uint16_t duty_ = 0;  // a pwm line's (M2-C3)
    std::array<uint32_t, 16> segs_{};
    size_t nsegs_ = 0;
    size_t seg_ = 0;
    uint32_t total_us_ = 0;
    uint32_t planned_us_ = 0;
    TimeUs pulse_end_at_ = 0;
    std::vector<fr::hal::FixtureEdge> edges_;
    uint32_t dropped_ = 0;
    std::vector<fr::hal::FixtureFrame> frames_;
    bool drain_posted_ = false;
};

/** One channel of the virtual fixture's s3k-fixture table (design m2-c1-hil §2.2, S3's profile). */
struct FixtureChannel {
    const char *name;
    fr::cap::FixtureConfig cfg;
};

constexpr fr::cap::FixtureConfig kBootLine{.drive = fr::cap::FixtureDrive::open_drain};
constexpr fr::cap::FixtureConfig kLedLine{};
constexpr fr::cap::FixtureConfig kWs2812Line{.decode = fr::cap::FixtureDecode::ws2812};
constexpr fr::cap::FixtureConfig kTestPinLine{.pull = fr::cap::FixturePull::up};
// M2-C3 (design m2-c3-inputs §3): the analog lines' LEDC outputs, which take set_duty.
constexpr fr::cap::FixtureConfig kPwmLine{.drive = fr::cap::FixtureDrive::pwm};
constexpr std::array<FixtureChannel, 14> kFixtureChannels{{{"ch0", kBootLine},
                                                          {"ch1", kBootLine},
                                                          {"ch2", kBootLine},
                                                          {"ch3", kBootLine},
                                                          {"ch4", kLedLine},
                                                          {"ch5", kLedLine},
                                                          {"ch6", kWs2812Line},
                                                          {"ch7", kWs2812Line},
                                                          {"ch8", kTestPinLine},
                                                          {"ch9", kTestPinLine},
                                                          {"ch10", kTestPinLine},
                                                          {"ch11", kTestPinLine},
                                                          {"ch12", kPwmLine},
                                                          {"ch13", kPwmLine}}};


[[noreturn]] void usage(const char *why)
{
    std::fprintf(stderr, "fr_net_node: %s\nusage: fr_net_node {--hub-tcp P --hub-udp P [--serial 1] | --serial 1} --mac 12hex "
                         "[--host H] [--addr N] [--net N] [--epoch N] [--hb-ms N] [--alias A] [--alias-rev N] "
                         "[--fw 16hex | --fw-id 64hex] [--hub-http P] [--ota-dir D] [--version V] [--health-ms N] "
                         "[--fault health] [--air-dir D [--air-loss PCT] [--air-seed N] [--air-rssi DBM] [--air-channel N] "
                         "[--air-ack-ms N]] [--pin-target UDPPORT] [--pin-listen UDPPORT] [--role node|gateway|fixture] "
                         "[--board B] [--profile P] [--chip N] [--led-kind mono|gpio_low|ws2812] [--led-tap UDPPORT] "
                         "[--test-pin-tap UDPPORT] [--fixture 1 [--line CH=UDPPORT]...] [--net-log 1]\n"
                         "       fr_net_node --make-image PATH [--version V] [--size N] [--board B] [--profile P] "
                         "[--part X] [--chip N] [--min-rev N] [--max-rev N] [--fault 0|1] [--seed N]\n", why);
    std::exit(64);
}

Options parse(int argc, char **argv)
{
    Options o;
    bool have_mac = false;
    for (int i = 1; i < argc; ++i) {
        const std::string_view k = argv[i];
        if (i + 1 >= argc) {
            usage("missing value");
        }
        const char *v = argv[++i];
        const unsigned long n = std::strtoul(v, nullptr, 0);
        if (k == "--host") {
            o.host = v;
        } else if (k == "--hub-tcp") {
            o.hub_tcp = static_cast<uint16_t>(n);
        } else if (k == "--hub-udp") {
            o.hub_udp = static_cast<uint16_t>(n);
        } else if (k == "--mac") {
            have_mac = parse_hex(v, o.mac);
        } else if (k == "--addr") {
            o.addr = static_cast<uint16_t>(n);
        } else if (k == "--net") {
            o.net = static_cast<uint16_t>(n);
        } else if (k == "--epoch") {
            o.epoch = static_cast<uint16_t>(n);
        } else if (k == "--hb-ms") {
            o.hb_ms = static_cast<uint32_t>(n);
        } else if (k == "--alias") {
            o.alias = v;
        } else if (k == "--alias-rev") {
            o.alias_rev = static_cast<uint32_t>(n);
        } else if (k == "--serial") {
            o.serial = n != 0;
        } else if (k == "--fw") {
            if (!parse_hex(v, o.fw)) {
                usage("--fw takes 16 hex digits");
            }
        } else if (k == "--fw-id") {
            ota_fake::Digest d{};
            if (!parse_hex(v, d)) {
                usage("--fw-id takes 64 hex digits");
            }
            o.fw_id = d;
        } else if (k == "--hub-http") {
            o.hub_http = static_cast<uint16_t>(n);
        } else if (k == "--ota-dir") {
            o.ota_dir = v;
        } else if (k == "--version") {
            o.version = v;
        } else if (k == "--health-ms") {
            o.health_ms = static_cast<uint32_t>(n);
        } else if (k == "--fault") {
            if (std::string_view(v) != "health") {
                usage("--fault takes `health`");
            }
            o.fault_health = true;
        } else if (k == "--air-dir") {
            o.air_dir = v;
        } else if (k == "--air-loss") {
            o.air_loss = static_cast<uint32_t>(std::min<unsigned long>(n, 100));
        } else if (k == "--air-seed") {
            o.air_seed = static_cast<uint32_t>(n);
        } else if (k == "--air-rssi") {
            o.air_rssi = static_cast<int8_t>(std::clamp<long>(std::strtol(v, nullptr, 10), -127, 0));
        } else if (k == "--air-channel") {
            o.air_channel = static_cast<uint8_t>(n);
        } else if (k == "--air-ack-ms") {
            o.air_ack_ms = static_cast<uint32_t>(std::clamp<unsigned long>(n, 1, 90));  // under the driver's 100 ms guard
        } else if (k == "--pin-target") {
            o.pin_target = static_cast<uint16_t>(n);
        } else if (k == "--pin-listen") {
            o.pin_listen = true;
            o.pin_listen_port = static_cast<uint16_t>(n);
        } else if (k == "--role") {
            const std::string_view r = v;
            if (!fr::proto::from_name(r, o.role)) {
                if (r.empty() || r.find_first_not_of("0123456789") != std::string_view::npos || n > 255 ||
                    !fr::proto::is_known(static_cast<fr::proto::Role>(n))) {
                    usage("--role takes node, gateway, fixture or their number");
                }
                o.role = static_cast<fr::proto::Role>(n);
            }
            o.role_set = true;
        } else if (k == "--board") {
            o.board = v;
            o.board_set = true;
        } else if (k == "--profile") {
            o.profile = v;
            o.profile_set = true;
        } else if (k == "--chip") {
            o.chip = static_cast<uint8_t>(n);
            o.chip_set = true;
        } else if (k == "--led-kind") {
            const std::string_view kind = v;
            if (kind == "mono") {
                o.led_kind = LedKind::mono;
            } else if (kind == "gpio_low") {
                o.led_kind = LedKind::gpio_low;
            } else if (kind == "ws2812") {
                o.led_kind = LedKind::ws2812;
            } else {
                usage("--led-kind takes mono, gpio_low or ws2812");
            }
        } else if (k == "--led-tap") {
            o.led_tap = static_cast<uint16_t>(n);
        } else if (k == "--test-pin-tap") {
            o.test_pin_tap = static_cast<uint16_t>(n);
        } else if (k == "--fixture") {
            o.fixture = n != 0;
        } else if (k == "--net-log") {
            o.net_log = n != 0;
        } else if (k == "--line") {
            const std::string_view spec = v;
            const size_t eq = spec.find('=');
            const std::string_view port = eq == std::string_view::npos ? std::string_view{} : spec.substr(eq + 1);
            if (eq == 0 || port.empty() || port.find_first_not_of("0123456789") != std::string_view::npos ||
                std::strtoul(std::string(port).c_str(), nullptr, 10) > 65535) {
                usage("--line takes <channel>=<udp port>");
            }
            o.lines.emplace_back(spec.substr(0, eq), static_cast<uint16_t>(std::strtoul(std::string(port).c_str(), nullptr, 10)));
        } else {
            usage("unknown option");
        }
    }
    if (!have_mac) {
        usage("--mac is required");
    }
    if ((o.hub_tcp == 0) != (o.hub_udp == 0)) {
        usage("--hub-tcp and --hub-udp go together");
    }
    if (!o.ip() && !o.serial) {
        usage("--hub-tcp and --hub-udp, or --serial 1 (serial only), are required");
    }
    if (o.fixture) {
        // s3k-fixture on its board (design m2-c1-hil D5, D6), unless the flags say otherwise.
        o.role = o.role_set ? o.role : fr::proto::Role::fixture;
        o.board = o.board_set ? o.board : "esp32s3-devkitc1-n16r8";
        o.profile = o.profile_set ? o.profile : "s3k-fixture";
        o.chip = o.chip_set ? o.chip : 9;
        if (o.pin_listen || o.pin_target != 0 || o.test_pin_tap != 0 || o.led_tap != 0) {
            usage("--fixture has no boot button, test pin or LED tap of its own");
        }
    } else if (!o.lines.empty()) {
        usage("--line needs --fixture 1");
    }
    return o;
}

/** `lines`: the virtual fixture's lines as they read now. */
void print_lines(const std::vector<std::unique_ptr<FakeFixtureLine>> &lines)
{
    std::string items;
    for (const auto &l : lines) {
        char one[160];
        std::snprintf(one, sizeof(one), R"(%s{"name":"%s","level":%s,"pressing":%s,"port":%u})", items.empty() ? "" : ",",
                      l->name().c_str(), l->level() ? "true" : "false", l->pressing() ? "true" : "false", unsigned{l->port()});
        items += one;
    }
    emit(R"({"ev":"lines","items":[%s]})", items.c_str());
}


/**
 * NodeLinks over this process's own links (design m2-c2 D2): its blocking TcpLink and UdpLink, the stdin/stdout
 * SerialLink, FakeAir and the test pin's wires. Its `wifi_down` closes the TCP socket (the hub sees a FIN), as
 * fr_net_node always did; the fleet's never does (D7).
 */
class NetNodeLinks final : public frsim::NodeLinks
{
public:
    NetNodeLinks(HostCore &core, const Options &o, fr::net::Net &net, std::optional<TcpLink> &tcp,
                 std::optional<UdpLink> &udp, SerialLink &serial, std::optional<FakeAir> &air)
        : core_(core), o_(o), net_(net), tcp_(tcp), udp_(udp), serial_(serial), air_(air), pin_target_(o.pin_target),
          test_pin_tap_(o.test_pin_tap)
    {
    }

    // As `net wifi_down` on target: TCP and UDP go, ESP-NOW and serial stay; 0 ends it (stdin and fr.diag.exec).
    void wifi_down(uint32_t secs) override
    {
        if (secs == 0) {
            if (wifi_back_at_ != kNever) {
                wifi_back_at_ = kNever;
                set_wifi(true);
            }
            return;
        }
        if (wifi_back_at_ == kNever) {
            set_wifi(false);
        }
        wifi_back_at_ = core_.now() + static_cast<TimeUs>(secs) * 1'000'000;
    }
    void tcp_enable(bool on) override
    {
        if (tcp_) {
            tcp_->enable(on);
        }
    }
    void air_loss(uint32_t pct) override
    {
        if (air_) {
            air_->set_loss(pct);
        }
    }
    bool air_counters(frsim::AirCounters &out) const override
    {
        if (!air_) {
            return false;
        }
        const FakeAir::Counters &c = air_->counters();
        const fr::net::air::SchedStats &d = air_->scheduler().stats();
        out = {.tx = d.sent,
               .tx_fail = d.failed,
               .retries = d.retries,
               .refused = d.refused,
               .rx = c.rx,
               .rx_bad = c.rx_bad,
               .rx_lost = c.lost,
               .peers = static_cast<uint32_t>(air_->scheduler().peers()),
               .datagrams = c.tx,
               .acks = c.acks};
        return true;
    }
    fr::net::LinkInfo wifi() const override
    {
        if (wifi_up_ && o_.ip()) {
            return {.wifi_up = true, .channel = o_.air_channel, .bssid = {0x10, 0x20, 0x30, 0x40, 0x50, 0x60}, .rssi = -48};
        }
        return {};
    }
    void serial_host(bool present) override { serial_.set_host(present); }
    void hub_mute(bool on) override { serial_.set_mute(on); }
    bool test_pin_wired() const override { return pin_target_.on() || test_pin_tap_.on(); }
    void test_pin_pulse(uint32_t us) override
    {
        // One wire, two ends: the pulse is `<us>` on each (low now, released `us` later).
        const std::string text = std::to_string(us);
        pin_target_.send(text);
        test_pin_tap_.send(text);
    }

    /** When `wifi_down` ends (kNever: not down). */
    TimeUs wifi_back_at() const { return wifi_back_at_; }
    /** The main loop, each round: Wi-Fi back once `wifi_down` ran out. */
    void poll(TimeUs now)
    {
        if (wifi_back_at_ != kNever && now >= wifi_back_at_) {
            wifi_back_at_ = kNever;
            set_wifi(true);
        }
    }

private:
    void set_wifi(bool up)
    {
        tcp_->enable(up);
        udp_->enable(up);
        wifi_up_ = up;
        fr::net::Net *net = &net_;
        core_.post([net] { net->link_changed(LinkKind::udp); });
        emit(R"({"ev":"wifi","up":%s})", up ? "true" : "false");
    }

    HostCore &core_;
    const Options &o_;
    fr::net::Net &net_;
    std::optional<TcpLink> &tcp_;
    std::optional<UdpLink> &udp_;
    SerialLink &serial_;
    std::optional<FakeAir> &air_;
    UdpOut pin_target_;
    UdpOut test_pin_tap_;
    bool wifi_up_ = true;
    TimeUs wifi_back_at_ = kNever;  // `wifi_down` ends then
};

/** The kit's NodeSpec from the options (design m2-c2 D2): what Device, NodeDiag and NodeOtaHost read. */
frsim::NodeSpec spec_of(const Options &o)
{
    frsim::NodeSpec s;
    s.alias = o.alias;
    s.mac = o.mac;
    s.addr = o.addr;
    s.net = o.net;
    s.epoch = o.epoch;
    s.alias_rev = o.alias_rev;
    s.hb_ms = o.hb_ms;
    s.health_ms = o.health_ms;
    s.usb = o.serial;
    s.profile = o.profile;
    s.board = o.board;
    s.chip = o.chip;
    s.role = o.role;
    s.fw = o.fw;
    s.version = o.version;
    s.radio.channel = o.air_channel;
    s.ip = o.ip();
    s.host = o.host;
    s.hub_http = o.hub_http;
    s.fault_health = o.fault_health;
    s.net_log = o.net_log;
    return s;
}

/** `--make-image PATH ...`: an image this node's CHECK accepts, for the hub's interop tests. */
int make_image_main(int argc, char **argv)
{
    ota_fake::ImageOptions io;
    const std::string path = argv[2];
    for (int i = 3; i + 1 < argc; i += 2) {
        const std::string_view k = argv[i];
        const char *v = argv[i + 1];
        const unsigned long n = std::strtoul(v, nullptr, 0);
        if (k == "--version") {
            io.version = v;
        } else if (k == "--size") {
            io.size = static_cast<uint32_t>(n);
        } else if (k == "--board") {
            io.board = v;
        } else if (k == "--profile") {
            io.profile = v;
        } else if (k == "--part") {
            io.part = v;
        } else if (k == "--chip") {
            io.chip = static_cast<uint16_t>(n);
        } else if (k == "--min-rev") {
            io.min_rev = static_cast<uint16_t>(n);
        } else if (k == "--max-rev") {
            io.max_rev = static_cast<uint16_t>(n);
        } else if (k == "--fault") {
            io.fault = static_cast<uint8_t>(n);
        } else if (k == "--seed") {
            io.seed = static_cast<uint32_t>(n);
        } else {
            usage("unknown --make-image option");
        }
    }
    const std::vector<uint8_t> img = ota_fake::make_image(io);
    ota_fake::write_file(path, std::string_view(reinterpret_cast<const char *>(img.data()), img.size()));
    emit(R"({"ev":"image","fw_id":"%s","size":%zu})",
         ota_fake::hex(std::span<const uint8_t>(img.data() + img.size() - 32, 32)).c_str(), img.size());
    return 0;
}

/** The process's node, for fr::core::link_info(). */
frsim::Device *g_node = nullptr;

}  // namespace

// fr_core's runtime answers these on target (fr/core/node_net.hpp), and FixtureService reads them: here the Device.
fr::net::LinkInfo fr::core::link_info()
{
    return g_node != nullptr ? g_node->link_info() : fr::net::LinkInfo{};
}

bool fr::core::hub_session()
{
    return g_node != nullptr && g_node->hub_session();
}

int main(int argc, char **argv)
{
    if (argc >= 3 && std::string_view(argv[1]) == "--make-image") {
        return make_image_main(argc, argv);
    }
    Options o = parse(argc, argv);
    if (!o.ota_dir.empty()) {
        // fr_boot (05 §5.5): every boot a new epoch, so a restarted process is a new boot to the hub too.
        const auto stored = ota_fake::read_file(o.ota_dir + "/epoch.txt");
        const unsigned long last = stored ? std::strtoul(stored->c_str(), nullptr, 10) : 0;
        o.epoch = static_cast<uint16_t>(std::max<unsigned long>(last + 1, o.epoch));
        ota_fake::write_file(o.ota_dir + "/epoch.txt", std::to_string(o.epoch));
    }
    HostCore core;
    // The running image (its fw_id prefix is in HELLO and the descriptor): --ota-dir's boot state, else
    // --fw-id, else --fw padded with zeros. MemFlash does what the bootloader does at this reset first.
    ota_fake::Digest running{};
    if (o.fw_id) {
        running = *o.fw_id;
    } else {
        std::copy(o.fw.begin(), o.fw.end(), running.begin());
    }
    ota_fake::MemFlash flash(o.ota_dir, running, o.version, g_out);
    std::copy_n(flash.state().running.begin(), o.fw.size(), o.fw.begin());
    const frsim::NodeSpec spec = spec_of(o);
    ota_fake::MemStore store(o.ota_dir);
    ota_fake::HttpFetch fetch(g_out);
    ota_fake::HostWorker worker;
    WiredButton button_src(core);
    // The status LED as the profile has it: s3k-fixture's is a WS2812 capped at 32, a WS2812 pad's (c6-pad,
    // s3l-pad) at 64.
    const LedKind led_kind = o.fixture ? LedKind::ws2812 : o.led_kind;
    const uint8_t max_brightness = o.fixture ? 32 : led_kind == LedKind::ws2812 ? 64 : 255;
    PadLight light(core, led_kind, o.led_tap);
    fr::ButtonService button(button_src, fr::cap::ButtonConfig{});
    fr::LedService led(light, fr::cap::LedConfig{.max_brightness = max_brightness});
    frsim::NodeDiag diag(core, spec, g_out);
    // The virtual fixture (design m2-c1-hil §4 S2): S1's FixtureService on a fake line per channel, as the
    // generated glue builds them on target.
    std::vector<std::unique_ptr<FakeFixtureLine>> lines;
    std::vector<std::unique_ptr<fr::FixtureService>> fixture;
    std::vector<fr::PortEntry> ports{{0, "node", nullptr, true}};
    if (o.fixture) {
        // s3k-fixture's table, in its profile's (and slots.lock's) order: status on 1, ch0-ch13 on 2-15.
        ports.push_back({1, "status", &led, true});
        uint8_t port = 2;
        for (const FixtureChannel &ch : kFixtureChannels) {
            lines.push_back(std::make_unique<FakeFixtureLine>(core, ch.name));
            fixture.push_back(std::make_unique<fr::FixtureService>(*lines.back(), ch.cfg));
            ports.push_back({port++, ch.name, fixture.back().get(), true});
        }
    } else {
        // The c6-pad board table (schema/vectors Descriptor.c6_pad): boot button on 1, status LED on 2.
        ports.push_back({1, "boot", &button, true});
        ports.push_back({2, "status", &led, true});
    }
    // fr.diag on 241 is a system port, outside the descriptor, as on target.
    ports.push_back({241, "diag", &diag, true});
    frsim::Device node(core, spec, ports, g_out);
    ports[0].cap = &node.node_cap();
    g_node = &node;

    fr::net::Config cfg;
    cfg.heartbeat_ms = o.hb_ms;
    fr::net::Net net(core, node, cfg);
    node.set_net(net);
    // nvs:fr_dir and nvs:fr_bind (design c5 §3): in --ota-dir across boots, written through the worker fake.
    frsim::FileBlob dir_blob(o.ota_dir.empty() ? std::string() : o.ota_dir + "/fr_dir.bin");
    frsim::FileBlob bind_blob(o.ota_dir.empty() ? std::string() : o.ota_dir + "/fr_bind.bin");
    fr::core::NetStores stores(core, worker, dir_blob, bind_blob);
    net.attach_stores(stores.directory(), stores.bindings());
    for (fr::PortEntry &p : ports) {
        p.cap->attach(p.port, p.name, net);
    }
    bool services_ok = static_cast<bool>(led.init(core)) && (o.fixture || static_cast<bool>(button.init(core)));
    for (const std::unique_ptr<fr::FixtureService> &f : fixture) {
        services_ok = services_ok && static_cast<bool>(f->init(core));
    }
    if (!services_ok) {
        std::fprintf(stderr, "fr_net_node: service init failed\n");
        return 1;
    }
    // The fixture's wires, now that each line knows its mode: a driving line's target, an input line's port.
    for (const auto &[name, port] : o.lines) {
        const auto it = std::find_if(lines.begin(), lines.end(), [&](const auto &l) { return l->name() == name; });
        if (it == lines.end()) {
            std::fprintf(stderr, "fr_net_node: --line %s: no such channel (ch0-ch13)\n", name.c_str());
            return 64;
        }
        if ((*it)->driving()) {
            (*it)->wire_to(port);
        } else if (!(*it)->listen(port)) {
            std::fprintf(stderr, "fr_net_node: --line %s: cannot listen on UDP %u\n", name.c_str(), unsigned{port});
            return 1;
        }
    }
    for (size_t i = 0; i < lines.size(); ++i) {
        const fr::cap::FixtureConfig &c = kFixtureChannels[i].cfg;
        emit(R"({"ev":"line","name":"%s","port":%u,"drive":"%s","decode":"%s","pull":"%s"})", lines[i]->name().c_str(),
             unsigned{lines[i]->port()}, fr::cap::to_name(c.drive), fr::cap::to_name(c.decode), fr::cap::to_name(c.pull));
    }
    // Serial only (a radio-off build, design m2-c1-hil D6): no TCP or UDP link.
    std::optional<TcpLink> tcp;
    std::optional<UdpLink> udp;
    SerialLink serial(core);
    serial.bind(net);
    if (o.serial) {
        net.attach(serial);
    }
    if (o.ip()) {
        tcp.emplace(core, o.host, o.hub_tcp);
        udp.emplace(o.host, o.hub_udp);
        tcp->bind(net);
        net.attach(*tcp);
        net.attach(*udp);
    }
    std::optional<FakeAir> air;
    if (!o.air_dir.empty()) {
        air.emplace(core, o);
        if (!air->open()) {
            std::fprintf(stderr, "fr_net_node: cannot join the air medium in %s\n", o.air_dir.c_str());
            return 1;
        }
        air->bind(net);
        net.attach_air(*air);
        node.set_air(true);
        core.post([&net] { net.link_changed(LinkKind::espnow); });  // as the driver posts it once up
    }
    NetNodeLinks links(core, o, net, tcp, udp, serial, air);
    node.set_links(links);
    diag.bind(net, links, ports);
    // The node's ESP_LOG lines (design m2-c2 D20): on the USB line with --serial; with --net-log also LOG over TCP.
    frsim::KitLogs logs(core, o.serial ? frsim::KitLogs::SerialOut([](std::string_view l) { g_out.line(l); })
                                       : frsim::KitLogs::SerialOut());
    if (o.net_log) {
        logs.attach(net);
        flash.set_log([&logs](char level, std::string_view tag, std::string_view text) { logs.log(level, tag, text); });
    }

    // fr_core's OTA wiring (design c4 §3) on the fake sink; its OTA decision lines through the node's log source.
    fr::ota::Ota ota;
    frsim::NodeOtaHost ota_host(net, node, spec, g_out);
    ota_host.set_logs(&logs);
    fr::ota::Deps deps;
    deps.core = &core;
    deps.worker = &worker;
    deps.flash = &flash;
    deps.fetch = &fetch;
    deps.store = &store;
    deps.host = &ota_host;
    std::snprintf(deps.ident.board, sizeof(deps.ident.board), "%s", o.board.c_str());
    std::snprintf(deps.ident.profile, sizeof(deps.ident.profile), "%s", o.profile.c_str());
    std::snprintf(deps.ident.part_profile, sizeof(deps.ident.part_profile), "%s", "fr-4mb-v1");
    // A fault build: the flag, or the installed image's fr_app_desc (`--make-image --fault 1`).
    deps.fault_health = o.fault_health || flash.state().fault;
    deps.health_deadline_ms = o.health_ms;
    if (!ota.bind(deps)) {
        std::fprintf(stderr, "fr_net_node: no timer for fr_ota\n");
        return 1;
    }
    node.set_ota(ota, flash);
    // HUB_ACK on a WELCOME that gave the link its session, as fr_core's on_envelope; serial only (a radio-off
    // build, design m2-c1-hil D6), the serial session's WELCOME is NET as well.
    const bool serial_only = !o.ip();
    auto rx = [&net, &ota, serial_only](LinkKind k, std::span<const uint8_t> env) {
        const auto h = fr::wire::unpack_header(env);
        net.receive(k, env);
        if (h && h->cls == fr::wire::kClsNet && h->kind == fr::proto::kKindNetWelcome && net.state().link(k).session) {
            ota.health_set(fr::ota::kHealthHubAck | (serial_only && k == LinkKind::serial ? fr::ota::kHealthNet : 0));
        }
    };
    if (tcp) {
        tcp->rx = rx;
    }
    serial.rx = rx;
    ota.on_boot();
    // CORE and CAPS: the services are up (a fault build drops CAPS inside Ota).
    ota.health_set(fr::ota::kHealthCore | fr::ota::kHealthCaps);
    emit(R"({"ev":"started","descriptor_hash":%u,"fw":"%s","version":"%s","pending":%s})", node.hello_info().descriptor_hash,
         ota_fake::hex(flash.state().running).c_str(), flash.state().version.c_str(), ota.pending_verify() ? "true" : "false");
    if (o.net_log &&
        !logs.start(spec, flash.state().running, node.hello_info().caps | fr::net::kCapNetLog, o.ip(),
                    flash.state().slot == 0 ? "ota_0" : "ota_1", flash.running().crashed ? "PANIC" : "POWERON")) {
        std::fprintf(stderr, "fr_net_node: no timer for the log source\n");
        return 1;
    }
    // The T-LAT wire in (design c6 §6 S6): a datagram is another node's test pin pulsing this node's boot input;
    // M2-C1: or a fixture's open-drain line holding it down (`level 0|1`).
    int pin_fd = -1;
    if (o.pin_listen) {
        uint16_t port = o.pin_listen_port;
        pin_fd = open_udp(true, port);
        if (pin_fd < 0) {
            std::fprintf(stderr, "fr_net_node: cannot listen for pin pulses on UDP %u\n", unsigned{o.pin_listen_port});
            return 1;
        }
        emit(R"({"ev":"pin_listen","port":%u})", unsigned{port});
    }
    // The stdin table (sim/commands.cpp), on this node.
    frsim::NodeCtx ctx{.spec = spec,
                       .core = core,
                       .net = net,
                       .links = links,
                       .out = g_out,
                       .device = node,
                       .diag = diag,
                       .ota = &ota,
                       .button = o.fixture ? nullptr : &button,
                       .logs = &logs};

    std::string line;
    bool quit = false;
    bool udp_ok = false;
    bool net_up = false;
    std::vector<pollfd> fds;
    while (!quit) {
        if (tcp) {
            tcp->try_connect();
        }
        core.run_ready();
        if (air) {
            air->poll();
            core.run_ready();
        }
        stores.retry();
        light.tap(core.now());
        light.log_sent();
        links.poll(core.now());
        if (!net_up && tcp && tcp->fd() >= 0) {
            net_up = true;
            ota.health_set(fr::ota::kHealthNet);  // NET: the network is there (Wi-Fi up on target)
        }
        // fr_worker: one job per round, between the sockets (a download chunk blocks for one read at most).
        if (worker.run_one()) {
            core.run_ready();
        }
        if (const bool ok = net.state().link(LinkKind::udp).udp_ok; ok != udp_ok) {
            udp_ok = ok;
            emit(R"({"ev":"udp_ok","on":%s})", ok ? "true" : "false");
        }
        if (flash.reboot_requested) {
            // esp_ota_mark_app_invalid_rollback_and_reboot: no BYE, the reset follows at once.
            emit(R"({"ev":"reboot","reason":"rollback"})");
            break;
        }
        if (node.rebooting()) {
            if (const char *why = node.reboot_reason()) {
                emit(R"({"ev":"reboot","reason":"%s"})", why);
            } else {
                emit(R"({"ev":"reboot"})");
            }
            break;
        }
        const TimeUs now = core.now();
        const TimeUs next = worker.idle() ? std::min({core.next_deadline(), tcp ? tcp->retry_at() : kNever, node.reboot_at(),
                                                      now + 100'000, air ? air->next_deadline() : kNever, links.wifi_back_at()})
                                          : now;
        // The driver's timers run in microseconds (link retries 2 and 4 ms): poll() rounds up to the ms.
        const int timeout_ms = static_cast<int>(std::max<TimeUs>(0, (next - now + 999) / 1000));
        // stdin, TCP, the air, the pin wire in, then the fixture's input lines.
        fds.assign({{STDIN_FILENO, POLLIN, 0}, {tcp ? tcp->fd() : -1, POLLIN, 0}, {air ? air->fd() : -1, POLLIN, 0}, {pin_fd, POLLIN, 0}});
        for (const auto &l : lines) {
            fds.push_back({l->fd(), POLLIN, 0});
        }
        if (::poll(fds.data(), fds.size(), timeout_ms) < 0 && errno != EINTR) {
            return 1;
        }
        if (pin_fd >= 0 && (fds[3].revents & POLLIN) != 0) {
            char buf[32];
            // The edge is stamped at the datagram's arrival, as the GPIO ISR stamps the pin's edge (recv_stamped):
            // neither a late wake from poll() nor the log line (stdout, a pipe the test may drain late) moves it.
            TimeUs at = 0;
            const ssize_t got = recv_stamped(pin_fd, buf, sizeof(buf), core, at);
            const std::optional<WireMsg> m = got > 0 ? parse_wire(std::string_view(buf, static_cast<size_t>(got))) : std::nullopt;
            if (m && m->kind == WireMsg::pulse) {
                button_src.pulse(m->us, at);
                emit(R"({"ev":"pin_in","us":%u,"at_us":%lld})", m->us, static_cast<long long>(at));
                core.run_ready();
            } else if (m && m->kind == WireMsg::level) {
                button_src.hold(!m->high, at);
                emit(R"({"ev":"pin_in","level":%d,"at_us":%lld})", m->high ? 1 : 0, static_cast<long long>(at));
                core.run_ready();
            }
        }
        for (size_t i = 0; i < lines.size(); ++i) {
            if (lines[i]->fd() >= 0 && (fds[4 + i].revents & POLLIN) != 0) {
                lines[i]->on_readable();
                core.run_ready();
            }
        }
        if (tcp && tcp->fd() >= 0 && (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
            tcp->on_readable();
        }
        if (air && (fds[2].revents & POLLIN) != 0) {
            air->on_readable();
        }
        if ((fds[0].revents & (POLLIN | POLLHUP)) != 0) {
            char buf[4096];
            const ssize_t n = ::read(STDIN_FILENO, buf, sizeof(buf));
            if (n <= 0) {
                break;  // the test closed stdin: done
            }
            line.append(buf, static_cast<size_t>(n));
            size_t nl;
            while ((nl = line.find('\n')) != std::string::npos) {
                const std::string cmd = line.substr(0, nl);
                line.erase(0, nl + 1);
                if (cmd.starts_with(fr::wire::kLinePrefix)) {
                    serial.on_line(cmd);
                } else if (const std::optional<std::string_view> id = frsim::serial_diag_id(cmd)) {
                    // fr_diag's serial command channel (`#<id> <line>` in, `#<id> <json>` out on the USB line, as
                    // the hub's diag_exec writes it to a port it holds open): the same answers as fr.diag.exec.
                    g_out.line(frsim::serial_diag_answer(diag, *id, cmd));
                } else if (cmd.starts_with("line ")) {
                    // `line <ch> <port>`: a driving fixture line's wire to a pad started after the fixture.
                    char name[16] = "";
                    unsigned port = 0;
                    const bool parsed = std::sscanf(cmd.c_str() + 5, "%15s %u", name, &port) == 2 && port <= 65535;
                    const auto it = std::find_if(lines.begin(), lines.end(), [&](const auto &l) { return l->name() == name; });
                    const bool ok = parsed && it != lines.end() && (*it)->driving();
                    if (ok) {
                        (*it)->wire_to(static_cast<uint16_t>(port));
                    }
                    emit(R"({"ev":"line","name":"%s","port":%u,"ok":%s})", name, port, ok ? "true" : "false");
                } else if (cmd == "lines") {
                    print_lines(lines);
                } else if (cmd == "crash") {
                    // A panic: no BYE, nothing flushed but what is already written; the next start's
                    // reset reason says so (a rollback's `crash`).
                    flash.note_crash();
                    emit(R"({"ev":"crash"})");
                    std::_Exit(3);
                } else if (cmd == "quit") {
                    quit = true;
                } else {
                    frsim::Commands::run(ctx, cmd);  // the shared table; any other line is ignored
                }
            }
        }
    }
    frsim::AirCounters c;
    frsim::print_state(g_out, net, links.air_counters(c) ? &c : nullptr, ota.health());
    if (pin_fd >= 0) {
        ::close(pin_fd);
    }
    return 0;
}
