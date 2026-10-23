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
//   fr_net_node --hub-tcp <port> --hub-udp <port> --mac <12 hex> [--host 127.0.0.1] [--addr <n>] [--net <n>]
//               [--epoch <n>] [--hb-ms <n>] [--alias <a>] [--alias-rev <n>] [--fw <16 hex> | --fw-id <64 hex>]
//               [--serial 1] [--hub-http <port>] [--ota-dir <dir>] [--version <label>] [--health-ms <n>]
//               [--fault health] [--air-dir <dir> [--air-loss <pct>] [--air-seed <n>] [--air-rssi <dBm>]
//               [--air-channel <n>] [--air-ack-ms <n>]] [--pin-target <udp port>] [--pin-listen <udp port>]
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
// (the serial link's USB host), `crash` (end like a panic: no BYE,
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
// loss <pct> <s> [both|tx|rx]`, `net drop_hub_link|udp_block|ip_block <s>`, `stats` (the C6 counters) and `info`.
// A hub CMD with exec_at runs at its time through the real Net scheduler (D22). --pin-target is the T-LAT wire
// out: `pin_pulse` sends one UDP datagram (the pulse length in µs, as text) to that loopback port and answers
// {ok, pin 20, us, at_us} as the board's test pin would. --pin-listen is the wire in: a datagram on that port
// (0: any free one, printed as `{"ev":"pin_listen","port":N}`) presses the boot button through its input slot,
// as the GPIO ISR would, and releases it after the pulse, so down, up and click follow the real debounce path.
// Their lines are `pin_pulse` {us, at_us} and `pin_in` {us, at_us}; `state` adds loss_*, cmds_scheduled, exec_*
// and rx_queue_us_max.
// Test code: it may allocate.
#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
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
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "catalog.hpp"
#include "diag.hpp"  // generated fr::cap::Diag: fr.diag.exec on port 241
#include "fr/core/core.hpp"
#include "fr/core/descriptor.hpp"
#include "fr/core/node_net.hpp"
#include "fr/core/port.hpp"
#include "fr/hash.hpp"
#include "fr/net/net.hpp"
#include "fr/serial_line.hpp"
#include "fr/services/button_service.hpp"
#include "fr/services/led_service.hpp"
#include "messages.hpp"  // generated fr::proto::Descriptor
#include "node.hpp"
#include "tools/ota_fake.hpp"
// The ESP-NOW driver's IDF-free send discipline; not on the include path, as it is private to fr_net/src/esp.
#include "../../../components/fr_net/src/esp/air_sched.hpp"

void ota_fake::emit(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    std::vprintf(fmt, ap);
    va_end(ap);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

namespace {

using fr::TimeUs;
using fr::net::LinkKind;
using ota_fake::emit;

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
    std::array<HostTimer, 16> timers_{};
    size_t timers_used_ = 0;
    std::array<HostSlot, 4> slots_{};
    size_t slots_used_ = 0;
    std::deque<fr::Callback<void(), 32>> posts_;
};

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
        release_ = core.timer([this] { edge(false); });
        if (slot_ == nullptr || release_ == nullptr) {
            return std::unexpected(fr::Err::failed);
        }
        return {};
    }
    bool level_pressed() const override { return low_; }
    fr::hal::Selftest selftest() override { return {!low_, low_ ? "pressed at rest" : "idle level ok"}; }

    /** The wire went low for `us`; a pulse while one runs moves its release. */
    void pulse(uint32_t us)
    {
        if (!low_) {
            edge(true);
        }
        release_->start(us);
    }

private:
    void edge(bool low)
    {
        low_ = low;
        slot_->update_from_isr(low, core_.now());
    }

    HostCore &core_;
    fr::hal::ButtonSink *sink_ = nullptr;
    fr::InputSlot *slot_ = nullptr;
    fr::Timer *release_ = nullptr;
    bool low_ = false;
};

/** A mono LED that prints what it shows. */
class PrintLight final : public fr::hal::LightOutput
{
public:
    fr::Status init(fr::Core &) override { return {}; }
    fr::hal::LightFeatures features() const override { return {}; }
    fr::Status write(const fr::hal::LightLevel &l) override
    {
        emit(R"({"ev":"led","on":%s})", l.on ? "true" : "false");
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "ok"}; }
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
    /** One line the hub wrote. */
    void on_line(std::string_view line)
    {
        uint8_t scratch[fr::wire::kMaxLineFrame];
        auto f = fr::wire::decode_line(line, scratch);
        if (f && f->type == fr::wire::kSerialEnv && host_present_) {
            rx(LinkKind::serial, f->body);
        }
    }

    std::function<void(LinkKind, std::span<const uint8_t>)> rx;

private:
    HostCore &core_;
    fr::net::Net *net_ = nullptr;
    bool host_present_ = true;
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
};

/** A JSON string body: quotes, backslashes and control characters escaped. */
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

/** nvs:fr_dir / nvs:fr_bind: a file in --ota-dir (written whole, like an NVS commit), else memory. */
class FileBlob final : public fr::core::Blob
{
public:
    explicit FileBlob(std::string path) : path_(std::move(path)) {}

    size_t read(std::span<uint8_t> out) override
    {
        const std::optional<std::string> data = path_.empty() ? mem_ : ota_fake::read_file(path_);
        if (!data || data->size() > out.size()) {
            return 0;
        }
        std::memcpy(out.data(), data->data(), data->size());
        return data->size();
    }
    bool write(std::span<const uint8_t> bytes) override
    {
        const std::string data(reinterpret_cast<const char *>(bytes.data()), bytes.size());
        if (path_.empty()) {
            mem_ = data;
        } else {
            ota_fake::write_file(path_, data);
        }
        return true;
    }

private:
    std::string path_;
    std::optional<std::string> mem_;
};

/** One loopback UDP socket, bound to `port` (0: any) when `listen`, else unbound for sending. */
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
    port = ntohs(a.sin_port);
    return fd;
}

/**
 * fr.diag on port 241 (design c6 §6 S6): the fr.diag.exec lines T-INPUT and T-LAT send over the hub link, with
 * fr_diag's answers. `pin_pulse` is the board's test pin (GPIO20 on the c6 Super Mini this node plays) as a
 * datagram to --pin-target; `net` drives Net's hooks, `loss` included.
 */
class NodeDiag final : public fr::cap::Diag
{
public:
    NodeDiag(HostCore &core, const Options &o) : core_(core), o_(o)
    {
        if (o.pin_target != 0) {
            uint16_t unused = 0;
            fd_ = open_udp(false, unused);
        }
    }
    ~NodeDiag()
    {
        if (fd_ >= 0) {
            ::close(fd_);
        }
    }
    NodeDiag(const NodeDiag &) = delete;
    NodeDiag &operator=(const NodeDiag &) = delete;

    void bind(fr::net::Net &net) { net_ = &net; }

    std::expected<fr::cap::DiagExecResult, fr::Err> exec(const fr::cap::DiagExecArgs &args) override
    {
        std::string_view line = args.line;
        const std::string_view cmd = word(line);
        int n = 0;
        if (cmd == "pin_pulse") {
            n = pin_pulse(line);
        } else if (cmd == "net") {
            n = net_hook(line);
        } else if (cmd == "stats") {
            const fr::net::State s = net_->state();
            n = std::snprintf(out_, sizeof(out_),
                              R"({"ok":true,"cmds":%u,"cmds_refused":%u,"hook_dropped":%u,"loss_tx":%u,"loss_rx":%u,)"
                              R"("cmds_scheduled":%u,"exec_late":%u,"exec_cancelled":%u,"exec_late_us_max":%u,)"
                              R"("rx_queue_us_max":%u})",
                              s.cmds, s.cmds_refused, s.hook_drops, s.loss_tx, s.loss_rx, s.cmds_scheduled, s.exec_late,
                              s.exec_cancelled, s.exec_late_us_max, s.rx_queue_us_max);
        } else if (cmd == "info") {
            n = std::snprintf(out_, sizeof(out_), R"({"ok":true,"id":"%s","inject_enabled":true,"test_pin":%d})",
                              ota_fake::hex(o_.mac).c_str(), o_.pin_target != 0 ? kTestPin : -1);
        } else {
            n = std::snprintf(out_, sizeof(out_), R"({"ok":false,"error":"unknown_command"})");
        }
        return fr::cap::DiagExecResult{.json = {out_, std::min(static_cast<size_t>(std::max(n, 0)), sizeof(out_) - 1)}};
    }

private:
    static constexpr int kTestPin = 20;  // esp32c6-supermini test_pin

    static std::string_view word(std::string_view &s)
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

    static bool number(std::string_view s, uint32_t lo, uint32_t hi, uint32_t &out)
    {
        if (s.empty() || s.size() > 9 || s.find_first_not_of("0123456789") != std::string_view::npos) {
            return false;
        }
        out = static_cast<uint32_t>(std::strtoul(std::string(s).c_str(), nullptr, 10));
        return out >= lo && out <= hi;
    }

    int fail(const char *error, const char *detail)
    {
        return std::snprintf(out_, sizeof(out_), R"({"ok":false,"error":"%s","detail":"%s"})", error, detail);
    }

    /** `pin_pulse <us>` as fr_diag answers it (design c6 D24). */
    int pin_pulse(std::string_view args)
    {
        uint32_t us = 0;
        if (!number(word(args), 10, 100000, us) || !args.empty()) {
            return fail("invalid_args", "usage: pin_pulse <us> (10-100000)");
        }
        if (fd_ < 0) {
            return fail("unsupported", "no test_pin on this board");
        }
        const fr::TimeUs now = core_.now();
        if (now < low_until_) {
            return std::snprintf(out_, sizeof(out_), R"({"ok":false,"error":"busy"})");
        }
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = htons(o_.pin_target);
        const std::string text = std::to_string(us);
        ::sendto(fd_, text.data(), text.size(), 0, reinterpret_cast<const sockaddr *>(&a), sizeof(a));
        low_until_ = now + us;
        emit(R"({"ev":"pin_pulse","us":%u,"at_us":%lld})", us, static_cast<long long>(now));
        return std::snprintf(out_, sizeof(out_), R"({"ok":true,"pin":%d,"us":%u,"at_us":%lld})", kTestPin, us,
                             static_cast<long long>(now));
    }

    /** `net loss <pct> <s> [both|tx|rx]` and `net drop_hub_link|udp_block|ip_block <s>`, as fr_diag's `net`. */
    int net_hook(std::string_view args)
    {
        const std::string_view name = word(args);
        if (name == "loss") {
            uint32_t pct = 0;
            uint32_t secs = 0;
            const bool ok_pct = number(word(args), 0, 100, pct);
            const bool ok_s = number(word(args), 0, 86400, secs);
            const std::string_view d = word(args);
            fr::net::LossDir dir = fr::net::LossDir::both;
            bool ok_dir = d.empty() || d == "both";
            if (d == "tx" || d == "rx") {
                dir = d == "tx" ? fr::net::LossDir::tx : fr::net::LossDir::rx;
                ok_dir = true;
            }
            if (!ok_pct || !ok_s || !ok_dir || !args.empty()) {
                return fail("invalid_args", "usage: net loss <pct 0-100> <seconds 0-86400> [both|tx|rx] (0 ends it)");
            }
            net_->loss(static_cast<uint8_t>(pct), secs, dir);  // after this RESULT: Net defers it
            const char *dir_name = dir == fr::net::LossDir::tx ? "tx" : dir == fr::net::LossDir::rx ? "rx" : "both";
            emit(R"({"ev":"loss","ok":true,"pct":%u,"s":%u,"dir":"%s"})", pct, secs, dir_name);  // as from stdin
            return std::snprintf(out_, sizeof(out_), R"({"ok":true,"hook":"loss","pct":%u,"s":%u,"dir":"%s"})", pct,
                                 secs, dir_name);
        }
        uint32_t secs = 0;
        if (!number(word(args), 0, 86400, secs) || !args.empty()) {
            return fail("invalid_args", "usage: net drop_hub_link|udp_block|ip_block <seconds> | loss <pct> <seconds>");
        }
        if (name == "drop_hub_link") {
            net_->drop_hub_link(secs);
        } else if (name == "udp_block") {
            net_->udp_block(secs);
        } else if (name == "ip_block") {
            net_->ip_block(secs);
        } else if (name == "wifi_down") {
            return fail("unsupported", "fr_net_node takes wifi_down on stdin");
        } else {
            return fail("invalid_args", "usage: net drop_hub_link|udp_block|ip_block <seconds> | loss <pct> <seconds>");
        }
        return std::snprintf(out_, sizeof(out_), R"({"ok":true,"hook":"%.*s","s":%u})", static_cast<int>(name.size()),
                             name.data(), secs);
    }

    HostCore &core_;
    const Options &o_;
    fr::net::Net *net_ = nullptr;
    int fd_ = -1;
    fr::TimeUs low_until_ = 0;
    char out_[fr::cap::DiagExecResult::kMaxSize];
};

class Device;

/** fr.node on port 0: what the hub's handshake and the registry use (describe, get_state, set_alias, reboot). */
class NodeCap final : public fr::cap::Node
{
public:
    explicit NodeCap(Device &d) : d_(d) {}

    fr::Status identify(const fr::cap::NodeIdentifyArgs &) override { return {}; }
    std::expected<fr::cap::NodeDescribeResult, fr::Err> describe() override;
    fr::Status reboot(const fr::cap::NodeRebootArgs &args) override;
    fr::Status set_alias(const fr::cap::NodeSetAliasArgs &args) override;
    fr::Status set_groups(const fr::cap::NodeSetGroupsArgs &) override { return std::unexpected(fr::Err::unsupported); }
    fr::Status net_set(const fr::cap::NodeNetSetArgs &) override { return std::unexpected(fr::Err::unsupported); }
    fr::Status get_state() override;
    // Bindings (07 §7.11), as fr_core's NodeService: Net's table, saved through the stores.
    fr::Status bind_set(const fr::cap::NodeBindSetArgs &args) override;
    fr::Status bind_clear(const fr::cap::NodeBindClearArgs &args) override;
    std::expected<fr::cap::NodeBindListResult, fr::Err> bind_list() override;

private:
    Device &d_;
};

/** What Net asks of the node (fr_core's role on target): dispatch by port, identity and HELLO facts. */
class Device final : public fr::net::Host
{
public:
    Device(HostCore &core, const Options &o, std::span<fr::PortEntry> ports) : core_(core), o_(o), ports_(ports)
    {
        store_alias(o.alias, o.alias_rev);
        const fr::core::DescriptorSource src{
            .fw_id_prefix = o.fw, .catalog_hash = fr::cap::catalog_hash(), .profile = "c6-pad", .board = "esp32c6-supermini"};
        desc_len_ = fr::core::build_descriptor(src, ports, desc_);
    }

    void set_net(fr::net::Net &net) { net_ = &net; }
    fr::net::Net &net() { return *net_; }
    std::span<uint8_t> bind_buf() { return bind_buf_; }
    /** The fake air medium joined: HELLO caps espnow_v2. */
    void set_air(bool on) { air_ = on; }
    /** `wifi_down`: link_info() says Wi-Fi is away. */
    void set_wifi(bool up) { wifi_up_ = up; }
    void set_ota(fr::ota::Ota &ota, const ota_fake::MemFlash &flash)
    {
        ota_ = &ota;
        flash_ = &flash;
    }
    bool rebooting() const { return reboot_at_ != kNever && core_.now() >= reboot_at_; }
    TimeUs reboot_at() const { return reboot_at_; }
    /** Why the restart: nullptr for fr.node.reboot (its event stays `{"ev":"reboot"}`). */
    const char *reboot_reason() const { return reboot_reason_; }
    NodeCap &node_cap() { return node_cap_; }

    std::span<const uint8_t> descriptor() const { return {desc_, desc_len_}; }
    void reboot(bool bootloader)
    {
        // As fr_core: BYE (after this RESULT, inside a request), then the restart a little later.
        net_->bye(bootloader ? fr::net::kByeMaintenance : fr::net::kByeReboot);
        reboot_at_ = core_.now() + 200'000;
    }
    /** fr_ota installed an image: BYE ota, then the restart (fr_core's OtaHost::restart). */
    void reboot_into_ota()
    {
        net_->bye(fr::net::kByeOta);
        reboot_at_ = core_.now() + 200'000;
        reboot_reason_ = "ota";
    }
    void store_alias(std::string_view a, uint32_t rev)
    {
        alias_.assign(a.substr(0, fr::net::Identity::kAliasMax));
        alias_rev_ = rev;
    }
    const std::string &alias() const { return alias_; }
    uint32_t alias_rev() const { return alias_rev_; }
    void report_board()
    {
        for (const fr::PortEntry &p : ports_) {
            if (p.cap != nullptr && p.ok && p.port != 0) {
                p.cap->report_all();
            }
        }
    }

    // fr::net::Host
    fr::Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, fr::cap::Reply &reply) override
    {
        emit(R"({"ev":"dispatch","port":%u,"cmd":%u,"capacity":%zu})", unsigned{port}, unsigned{cmd}, reply.capacity());
        for (const fr::PortEntry &p : ports_) {
            if (p.port == port && p.cap != nullptr) {
                return p.ok ? p.cap->dispatch(cmd, args, reply) : std::unexpected(fr::Err::failed);
            }
        }
        return std::unexpected(fr::Err::not_found);
    }
    void report_all() override { report_board(); }
    fr::net::HelloInfo hello_info() override
    {
        fr::net::HelloInfo h;
        h.mac = o_.mac;
        h.chip = 13;
        h.chip_rev = 1;
        h.fw_id_prefix = o_.fw;
        h.descriptor_hash = fr::wire::descriptor_hash(descriptor());
        h.board_hash = fr::wire::board_hash("esp32c6-supermini");
        h.caps = fr::net::kCapWifi | fr::net::kCapInjectEnabled |
                 (o_.addr != fr::proto::kAddrUnassigned ? fr::net::kCapProvisioned : 0) | (air_ ? fr::net::kCapEspnowV2 : 0);
        h.hb_interval_ms = o_.hb_ms;
        h.reset_reason = 1;
        // As fr_core: PENDING_VERIFY until the health gate marks the image valid.
        h.ota_state = flash_ != nullptr && flash_->state().pending ? fr::proto::OtaState::pending_verify
                                                                  : fr::proto::OtaState::valid;
        return h;
    }
    fr::net::Identity identity() override
    {
        fr::net::Identity id;
        id.addr = o_.addr;
        id.net = o_.net;
        std::memcpy(id.alias, alias_.data(), std::min(alias_.size(), fr::net::Identity::kAliasMax));
        id.alias_rev = alias_rev_;
        id.epoch = o_.epoch;
        return id;
    }
    fr::net::LinkInfo link_info() override
    {
        if (!wifi_up_) {
            return {};
        }
        return {.wifi_up = true, .channel = o_.air_channel, .bssid = {0x10, 0x20, 0x30, 0x40, 0x50, 0x60}, .rssi = -48};
    }
    fr::net::Vitals vitals() override
    {
        return {.free_heap_kb = 200, .vbat_mv = 0, .ota_busy = ota_ != nullptr && ota_->busy(), .low_batt = false};
    }
    void ota_frame(LinkKind from, const fr::wire::Header &h, std::span<const uint8_t> body, fr::net::OtaReply &reply) override
    {
        emit(R"({"ev":"ota_frame","link":"%s","kind":%u,"seq":%u,"ack_req":%s,"len":%zu})",
             from == LinkKind::tcp ? "tcp" : from == LinkKind::serial ? "serial" : "udp", unsigned{h.kind},
             static_cast<unsigned>(h.seq), (h.flags & fr::wire::kFlagAckReq) != 0 ? "true" : "false", body.size());
        if (ota_ != nullptr) {
            ota_->on_frame(h.kind, body, reply);  // as fr_core's NetHost
        }
    }
    void msg(uint16_t src, std::string_view topic, std::span<const uint8_t> data) override
    {
        const std::string_view text(reinterpret_cast<const char *>(data.data()), data.size());
        if (fr::wire::utf8_valid(data)) {
            emit(R"({"ev":"msg","src":%u,"topic":"%s","data":"%s","len":%zu})", unsigned{src}, json_text(topic).c_str(),
                 json_text(text).c_str(), data.size());
        } else {
            emit(R"({"ev":"msg","src":%u,"topic":"%s","data_hex":"%s","len":%zu})", unsigned{src},
                 json_text(topic).c_str(), ota_fake::hex(data).c_str(), data.size());
        }
    }

private:
    HostCore &core_;
    Options o_;
    std::span<fr::PortEntry> ports_;
    NodeCap node_cap_{*this};
    fr::net::Net *net_ = nullptr;
    fr::ota::Ota *ota_ = nullptr;
    const ota_fake::MemFlash *flash_ = nullptr;
    std::string alias_;
    uint32_t alias_rev_ = 0;
    uint8_t desc_[fr::proto::Descriptor::kMaxSize];
    size_t desc_len_ = 0;
    TimeUs reboot_at_ = kNever;
    const char *reboot_reason_ = nullptr;
    uint8_t bind_buf_[fr::core::kBindListMax];
    bool air_ = false;
    bool wifi_up_ = true;
};

/** fr_core's OtaHost on this node: Net::send_ota (each frame reported), the hub's HTTP port, BYE ota. */
class NodeOtaHost final : public fr::ota::Host
{
public:
    NodeOtaHost(fr::net::Net &net, Device &dev, const Options &o) : net_(net), dev_(dev), o_(o) {}

    fr::Status send(uint8_t kind, std::span<const uint8_t> body, bool ack_req) override
    {
        const fr::Status st = net_.send_ota(kind, body, ack_req);
        const char *sent = st ? "true" : "false";
        const char *ack = ack_req ? "true" : "false";
        if (kind == fr::proto::kKindOtaAccept || kind == fr::proto::kKindOtaReject) {
            auto a = kind == fr::proto::kKindOtaAccept ? fr::proto::decode_ota_accept(body)
                                                       : fr::proto::decode_ota_reject(body).transform([](const auto &r) {
                                                             return fr::proto::OtaAccept{.job_id = r.job_id, .code = r.code};
                                                         });
            if (a) {
                emit(R"({"ev":"ota_tx","kind":"%s","job":"%.*s","code":%u,"ack_req":%s,"sent":%s})",
                     kind == fr::proto::kKindOtaAccept ? "accept" : "reject", static_cast<int>(a->job_id.size()),
                     a->job_id.data(), unsigned{a->code}, ack, sent);
            }
        } else if (kind == fr::proto::kKindOtaStatus) {
            if (auto m = fr::proto::decode_ota_status(body)) {
                emit(R"({"ev":"ota_tx","kind":"status","job":"%.*s","state":%u,"bytes":%u,"ack_req":%s,"sent":%s})",
                     static_cast<int>(m->job_id.size()), m->job_id.data(), unsigned{m->state},
                     static_cast<unsigned>(m->bytes), ack, sent);
            }
        } else if (kind == fr::proto::kKindOtaResult) {
            if (auto m = fr::proto::decode_ota_result(body)) {
                emit(R"({"ev":"ota_tx","kind":"result","job":"%.*s","outcome":%u,"reason":%u,"ack_req":%s,"sent":%s})",
                     static_cast<int>(m->job_id.size()), m->job_id.data(), unsigned{m->outcome}, unsigned{m->reason},
                     ack, sent);
            }
        }
        return st;
    }
    bool endpoint(fr::ota::Endpoint &out) override
    {
        // design c4 §3: the address of the TCP session, the hub's node HTTP port.
        if (!net_.state().link(LinkKind::tcp).session) {
            return false;
        }
        std::snprintf(out.host, sizeof(out.host), "%s", o_.host.c_str());
        out.port = o_.hub_http;
        return true;
    }
    void restart() override { dev_.reboot_into_ota(); }

private:
    fr::net::Net &net_;
    Device &dev_;
    const Options &o_;
};

std::expected<fr::cap::NodeDescribeResult, fr::Err> NodeCap::describe()
{
    if (d_.descriptor().empty()) {
        return std::unexpected(fr::Err::failed);
    }
    return fr::cap::NodeDescribeResult{.descriptor = d_.descriptor()};
}

fr::Status NodeCap::reboot(const fr::cap::NodeRebootArgs &args)
{
    d_.reboot(args.bootloader);
    return {};
}

fr::Status NodeCap::set_alias(const fr::cap::NodeSetAliasArgs &args)
{
    d_.store_alias(args.alias, args.rev);
    emit(R"({"ev":"set_alias","alias":"%s","rev":%u})", d_.alias().c_str(), d_.alias_rev());
    return {};
}

fr::Status NodeCap::get_state()
{
    d_.report_board();
    return {};
}

fr::Status NodeCap::bind_set(const fr::cap::NodeBindSetArgs &args)
{
    const fr::Status st = fr::core::bind_set(d_.net(), args);
    emit(R"({"ev":"bind_set","slot":%u,"on_port":%u,"on_cls":%u,"to_addr":%u,"to_port":%u,"to_cls":%u,"ok":%s})",
         unsigned{args.slot}, unsigned{args.on_port}, unsigned{args.on_cls}, unsigned{args.to_addr},
         unsigned{args.to_port}, unsigned{args.to_cls}, st ? "true" : "false");
    return st;
}

fr::Status NodeCap::bind_clear(const fr::cap::NodeBindClearArgs &args)
{
    const fr::Status st = fr::core::bind_clear(d_.net(), args);
    emit(R"({"ev":"bind_clear","slot":%u,"ok":%s})", unsigned{args.slot}, st ? "true" : "false");
    return st;
}

std::expected<fr::cap::NodeBindListResult, fr::Err> NodeCap::bind_list()
{
    return fr::core::bind_list(d_.net(), d_.bind_buf());
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

[[noreturn]] void usage(const char *why)
{
    std::fprintf(stderr, "fr_net_node: %s\nusage: fr_net_node --hub-tcp P --hub-udp P --mac 12hex [--host H] [--addr N] "
                         "[--net N] [--epoch N] [--hb-ms N] [--alias A] [--alias-rev N] [--fw 16hex | --fw-id 64hex] "
                         "[--serial 1] [--hub-http P] [--ota-dir D] [--version V] [--health-ms N] [--fault health] "
                         "[--air-dir D [--air-loss PCT] [--air-seed N] [--air-rssi DBM] [--air-channel N] [--air-ack-ms N]] "
                         "[--pin-target UDPPORT] [--pin-listen UDPPORT]\n"
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
        } else {
            usage("unknown option");
        }
    }
    if (!have_mac || o.hub_tcp == 0 || o.hub_udp == 0) {
        usage("--mac, --hub-tcp and --hub-udp are required");
    }
    return o;
}

/** The C5 part of `state`: Net's ESP-NOW link and counters, the medium's, the tables. */
std::string c5_state(const fr::net::Net &net, const FakeAir *air)
{
    const fr::net::State s = net.state();
    const fr::net::LinkState &l = s.link(LinkKind::espnow);
    size_t bindings = 0;
    for (const fr::net::BindingSlot &b : net.bindings()) {
        bindings += b.used ? 1 : 0;
    }
    char head[1024];
    std::snprintf(head, sizeof(head),
                  R"("air_up":%s,"air_tx":%u,"air_tx_fail":%u,"air_rx":%u,"air_rx_drop":%u,"air_retries":%u,)"
                  R"("relay_seeded":%u,"relay_relayed":%u,"relay_cancelled":%u,"relay_dropped":%u,)"
                  R"("bcast_delivered":%u,"bcast_dup":%u,"bcast_old":%u,"bcast_watermark":%u,)"
                  R"("bind_fired":%u,"bind_failed":%u,"bind_rtt_p50_us":%u,"bindings":%zu,"directory":%zu,"neighbors":%zu,)"
                  R"("nodes":{"delivered":%u,"dup":%u,"old":%u,"sent":%u,"via_espnow":%u,"via_hub":%u,"via_flood":%u,"failed":%u,"resolves":%u})",
                  l.up ? "true" : "false", l.tx, l.tx_fail, l.rx, l.rx_drop, l.retries, s.relay.seeded, s.relay.relayed,
                  s.relay.cancelled, s.relay.dropped, s.bcast.delivered, s.bcast.dup, s.bcast.old, s.bcast.watermark,
                  s.bindings.fired, s.bindings.failed, s.bindings.rtt_p50_us, bindings, net.directory().count,
                  net.neighbors().count, s.nodes.delivered, s.nodes.dup, s.nodes.old, s.nodes.sent, s.nodes.via_espnow,
                  s.nodes.via_hub, s.nodes.via_flood, s.nodes.failed, s.nodes.resolves);
    std::string out = head;
    if (air != nullptr) {
        const FakeAir::Counters &c = air->counters();
        const fr::net::air::SchedStats &d = air->scheduler().stats();
        char medium[512];
        std::snprintf(medium, sizeof(medium),
                      R"(,"medium":{"tx":%u,"rx":%u,"rx_bad":%u,"lost":%u,"acks":%u,"sent":%u,"failed":%u,"link_retries":%u,"refused":%u,"peers":%zu})",
                      c.tx, c.rx, c.rx_bad, c.lost, c.acks, d.sent, d.failed, d.retries, d.refused,
                      air->scheduler().peers());
        out += medium;
    }
    out += R"(,"msgs":{)";
    for (const fr::net::MsgStats::Topic &t : net.msg_stats().topics) {
        if (t.name[0] != '\0') {
            out += "\"" + json_text(t.name) + "\":" + std::to_string(t.n) + ",";
        }
    }
    out += R"("other":)" + std::to_string(net.msg_stats().other) + "}";
    return out;
}

/** The C6 part of `state` (design c6 D21-D23): `net loss` and its counts, exec_at's table, the receive queue. */
std::string c6_state(const fr::net::State &s)
{
    const char *dir = s.loss_dir == fr::net::LossDir::tx ? "tx" : s.loss_dir == fr::net::LossDir::rx ? "rx" : "both";
    char out[512];
    std::snprintf(out, sizeof(out),
                  R"("loss_pct":%u,"loss_dir":"%s","loss_tx":%u,"loss_rx":%u,"cmds_refused":%u,"cmds_scheduled":%u,)"
                  R"("exec_late":%u,"exec_cancelled":%u,"exec_late_us_max":%u,"rx_queue_us_max":%u)",
                  unsigned{s.loss_pct}, dir, s.loss_tx, s.loss_rx, s.cmds_refused, s.cmds_scheduled, s.exec_late,
                  s.exec_cancelled, s.exec_late_us_max, s.rx_queue_us_max);
    return out;
}

void print_state(const fr::net::Net &net, const FakeAir *air)
{
    const fr::net::State s = net.state();
    const auto &tcp = s.link(LinkKind::tcp);
    const auto &udp = s.link(LinkKind::udp);
    const auto &ser = s.link(LinkKind::serial);
    emit(R"({"ev":"state","serial_session":%s,"serial_tx":%u,"serial_rx":%u,"session":%s,"udp_ok":%s,"time_synced":%s,"hub_epoch":%u,"tcp_tx":%u,"tcp_rx":%u,"udp_tx":%u,)"
         R"("udp_retries":%u,"rx_drop":%u,"cmds":%u,"dup":%u,"old":%u,"cached_replies":%u,"sessions_lost":%u,)"
         R"("events_dropped":%u,"delivery_failed":%u,"udp_blocked":%s,"ip_blocked":%s,"hook_drops":%u,%s,%s})",
         ser.session ? "true" : "false", ser.tx, ser.rx, tcp.session ? "true" : "false", udp.udp_ok ? "true" : "false", s.time_synced() ? "true" : "false", unsigned{s.hub_epoch},
         tcp.tx, tcp.rx, udp.tx, udp.retries, tcp.rx_drop + udp.rx_drop, s.cmds, s.dup, s.old, s.cached_replies,
         s.sessions_lost, s.events_dropped, s.delivery_failed, s.udp_blocked ? "true" : "false",
         s.ip_blocked ? "true" : "false", s.hook_drops, c5_state(net, air).c_str(), c6_state(s).c_str());
}

/** `msg <dst|broadcast> <topic> [data…]`: fr::msg::send from stdin. */
void stdin_msg(fr::net::Net &net, std::string_view args, bool reliable)
{
    auto word = [&args]() {
        while (!args.empty() && args.front() == ' ') {
            args.remove_prefix(1);
        }
        const size_t sp = std::min(args.find(' '), args.size());
        const std::string_view w = args.substr(0, sp);
        args.remove_prefix(sp);
        return w;
    };
    const std::string_view dst_text = word();
    const std::string_view topic = word();
    if (!args.empty() && args.front() == ' ') {
        args.remove_prefix(1);
    }
    const uint16_t dst = dst_text == "broadcast"
                             ? fr::msg::kBroadcast
                             : static_cast<uint16_t>(std::strtoul(std::string(dst_text).c_str(), nullptr, 0));
    const fr::Status st = fr::core::msg_send(
        net, dst, topic, std::span<const uint8_t>(reinterpret_cast<const uint8_t *>(args.data()), args.size()), reliable);
    emit(R"({"ev":"msg_sent","dst":%u,"topic":"%s","ok":%s,"error":"%s"})", unsigned{dst}, json_text(topic).c_str(),
         st ? "true" : "false", st ? "" : fr::err_name(st.error()));
}

/** `neighbors`: the neighbour table. */
void print_neighbors(const fr::net::Net &net, TimeUs now)
{
    const fr::net::Neighbors nb = net.neighbors();
    std::string items;
    for (size_t i = 0; i < nb.count && i < nb.items.size(); ++i) {
        const fr::net::Neighbor &e = nb.items[i];
        char one[192];
        std::snprintf(one, sizeof(one), R"(%s{"mac":"%s","addr":%u,"rssi":%d,"age_ms":%lld,"ack_ok":%u,"ack_fail":%u})",
                      i == 0 ? "" : ",", ota_fake::hex(e.mac).c_str(), unsigned{e.addr}, int{e.rssi},
                      static_cast<long long>((now - e.last_heard) / 1000), e.ack_ok, e.ack_fail);
        items += one;
    }
    emit(R"({"ev":"neighbors","items":[%s]})", items.c_str());
}

/** `directory`: the directory as NET/DIRECTORY (or a RESOLVE answer) left it, by addr. */
void print_directory(const fr::net::Net &net)
{
    const fr::net::Directory &d = net.directory();
    const auto end = d.entries.begin() + static_cast<std::ptrdiff_t>(std::min(d.count, d.entries.size()));
    std::vector<fr::net::DirEntry> sorted(d.entries.begin(), end);
    std::sort(sorted.begin(), sorted.end(),
              [](const fr::net::DirEntry &a, const fr::net::DirEntry &b) { return a.addr < b.addr; });
    std::string items;
    for (const fr::net::DirEntry &e : sorted) {
        char one[64];
        std::snprintf(one, sizeof(one), R"(%s{"addr":%u,"mac":"%s"})", items.empty() ? "" : ",", unsigned{e.addr},
                      ota_fake::hex(e.mac).c_str());
        items += one;
    }
    emit(R"({"ev":"directory","items":[%s]})", items.c_str());
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

}  // namespace

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
    ota_fake::MemFlash flash(o.ota_dir, running, o.version);
    std::copy_n(flash.state().running.begin(), o.fw.size(), o.fw.begin());
    ota_fake::MemStore store(o.ota_dir);
    ota_fake::HttpFetch fetch;
    ota_fake::HostWorker worker;
    WiredButton button_src(core);
    PrintLight light;
    fr::ButtonService button(button_src, fr::cap::ButtonConfig{});
    fr::LedService led(light, fr::cap::LedConfig{});
    NodeDiag diag(core, o);
    // The c6-pad board table (schema/vectors Descriptor.c6_pad): boot button on 1, status LED on 2. fr.diag on 241
    // is a system port, outside the descriptor, as on target.
    std::array<fr::PortEntry, 4> ports{
        {{0, "node", nullptr, true}, {1, "boot", &button, true}, {2, "status", &led, true}, {241, "diag", &diag, true}}};
    Device node(core, o, ports);
    ports[0].cap = &node.node_cap();

    fr::net::Config cfg;
    cfg.heartbeat_ms = o.hb_ms;
    fr::net::Net net(core, node, cfg);
    node.set_net(net);
    diag.bind(net);
    // nvs:fr_dir and nvs:fr_bind (design c5 §3): in --ota-dir across boots, written through the worker fake.
    FileBlob dir_blob(o.ota_dir.empty() ? std::string() : o.ota_dir + "/fr_dir.bin");
    FileBlob bind_blob(o.ota_dir.empty() ? std::string() : o.ota_dir + "/fr_bind.bin");
    fr::core::NetStores stores(core, worker, dir_blob, bind_blob);
    net.attach_stores(stores.directory(), stores.bindings());
    for (fr::PortEntry &p : ports) {
        p.cap->attach(p.port, p.name, net);
    }
    if (!button.init(core) || !led.init(core)) {
        std::fprintf(stderr, "fr_net_node: service init failed\n");
        return 1;
    }
    TcpLink tcp(core, o.host, o.hub_tcp);
    UdpLink udp(o.host, o.hub_udp);
    SerialLink serial(core);
    tcp.bind(net);
    serial.bind(net);
    if (o.serial) {
        net.attach(serial);
    }
    net.attach(tcp);
    net.attach(udp);
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

    // fr_core's OTA wiring (design c4 §3) on the fake sink.
    fr::ota::Ota ota;
    NodeOtaHost ota_host(net, node, o);
    fr::ota::Deps deps;
    deps.core = &core;
    deps.worker = &worker;
    deps.flash = &flash;
    deps.fetch = &fetch;
    deps.store = &store;
    deps.host = &ota_host;
    std::snprintf(deps.ident.board, sizeof(deps.ident.board), "%s", "esp32c6-supermini");
    std::snprintf(deps.ident.profile, sizeof(deps.ident.profile), "%s", "c6-pad");
    std::snprintf(deps.ident.part_profile, sizeof(deps.ident.part_profile), "%s", "fr-4mb-v1");
    // A fault build: the flag, or the installed image's fr_app_desc (`--make-image --fault 1`).
    deps.fault_health = o.fault_health || flash.state().fault;
    deps.health_deadline_ms = o.health_ms;
    if (!ota.bind(deps)) {
        std::fprintf(stderr, "fr_net_node: no timer for fr_ota\n");
        return 1;
    }
    node.set_ota(ota, flash);
    // HUB_ACK on a WELCOME that gave the link its session, as fr_core's on_envelope.
    auto rx = [&net, &ota](LinkKind k, std::span<const uint8_t> env) {
        const auto h = fr::wire::unpack_header(env);
        net.receive(k, env);
        if (h && h->cls == fr::wire::kClsNet && h->kind == fr::proto::kKindNetWelcome && net.state().link(k).session) {
            ota.health_set(fr::ota::kHealthHubAck);
        }
    };
    tcp.rx = rx;
    serial.rx = rx;
    ota.on_boot();
    // CORE and CAPS: the services are up (a fault build drops CAPS inside Ota).
    ota.health_set(fr::ota::kHealthCore | fr::ota::kHealthCaps);
    emit(R"({"ev":"started","descriptor_hash":%u,"fw":"%s","version":"%s","pending":%s})", node.hello_info().descriptor_hash,
         ota_fake::hex(flash.state().running).c_str(), flash.state().version.c_str(), ota.pending_verify() ? "true" : "false");
    // The T-LAT wire in (design c6 §6 S6): a datagram is another node's test pin pulsing this node's boot input.
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

    std::string line;
    bool quit = false;
    bool udp_ok = false;
    bool net_up = false;
    TimeUs wifi_back_at = kNever;  // `wifi_down` ends then
    auto set_wifi = [&](bool up) {
        tcp.enable(up);
        udp.enable(up);
        node.set_wifi(up);
        core.post([&net] { net.link_changed(LinkKind::udp); });
        emit(R"({"ev":"wifi","up":%s})", up ? "true" : "false");
    };
    while (!quit) {
        tcp.try_connect();
        core.run_ready();
        if (air) {
            air->poll();
            core.run_ready();
        }
        stores.retry();
        if (wifi_back_at != kNever && core.now() >= wifi_back_at) {
            wifi_back_at = kNever;
            set_wifi(true);
        }
        if (!net_up && tcp.fd() >= 0) {
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
        const TimeUs next = worker.idle() ? std::min({core.next_deadline(), tcp.retry_at(), node.reboot_at(), now + 100'000,
                                                      air ? air->next_deadline() : kNever, wifi_back_at})
                                          : now;
        // The driver's timers run in microseconds (link retries 2 and 4 ms): poll() rounds up to the ms.
        const int timeout_ms = static_cast<int>(std::max<TimeUs>(0, (next - now + 999) / 1000));
        std::array<pollfd, 4> fds{{{STDIN_FILENO, POLLIN, 0},
                                   {tcp.fd(), POLLIN, 0},
                                   {air ? air->fd() : -1, POLLIN, 0},
                                   {pin_fd, POLLIN, 0}}};
        if (::poll(fds.data(), fds.size(), timeout_ms) < 0 && errno != EINTR) {
            return 1;
        }
        if (pin_fd >= 0 && (fds[3].revents & POLLIN) != 0) {
            char buf[32];
            const ssize_t got = ::recv(pin_fd, buf, sizeof(buf) - 1, 0);
            if (got > 0) {
                buf[got] = '\0';
                const unsigned long us = std::strtoul(buf, nullptr, 10);
                const uint32_t pulse_us = us >= 10 && us <= 100000 ? static_cast<uint32_t>(us) : 2000;
                emit(R"({"ev":"pin_in","us":%u,"at_us":%lld})", pulse_us, static_cast<long long>(core.now()));
                button_src.pulse(pulse_us);
                core.run_ready();
            }
        }
        if (tcp.fd() >= 0 && (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
            tcp.on_readable();
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
                const uint32_t arg = static_cast<uint32_t>(std::strtoul(cmd.c_str() + std::min(cmd.find(' '), cmd.size()), nullptr, 10));
                if (cmd.starts_with(fr::wire::kLinePrefix)) {
                    serial.on_line(cmd);
                } else if (cmd == "state") {
                    print_state(net, air ? &*air : nullptr);
                } else if (cmd.starts_with("udp_block")) {
                    net.udp_block(arg);
                } else if (cmd.starts_with("drop_hub_link")) {
                    net.drop_hub_link(arg);
                } else if (cmd.starts_with("ip_block")) {
                    net.ip_block(arg);
                } else if (cmd.starts_with("tcp ")) {
                    tcp.enable(arg != 0);
                } else if (cmd.starts_with("usb ")) {
                    serial.set_host(arg != 0);
                } else if (cmd.starts_with("wifi_down")) {
                    // As `net wifi_down` on target: TCP and UDP go, ESP-NOW and serial stay.
                    if (arg == 0) {
                        if (wifi_back_at != kNever) {
                            wifi_back_at = kNever;
                            set_wifi(true);
                        }
                    } else {
                        if (wifi_back_at == kNever) {
                            set_wifi(false);
                        }
                        wifi_back_at = core.now() + static_cast<TimeUs>(arg) * 1'000'000;
                    }
                } else if (cmd.starts_with("loss ")) {
                    // `loss <pct> <s> [both|tx|rx]` (design c6 D21): from here at once, as from the serial channel.
                    std::string_view rest = std::string_view(cmd).substr(5);
                    unsigned pct = 0;
                    unsigned secs = 0;
                    char dir[8] = "both";
                    const int got = std::sscanf(std::string(rest).c_str(), "%u %u %7s", &pct, &secs, dir);
                    const std::string_view d = dir;
                    const bool ok = got >= 2 && pct <= 100 && (d == "both" || d == "tx" || d == "rx");
                    if (ok) {
                        using fr::net::LossDir;
                        const LossDir way = d == "tx" ? LossDir::tx : d == "rx" ? LossDir::rx : LossDir::both;
                        net.loss(static_cast<uint8_t>(pct), secs, way);
                    }
                    emit(R"({"ev":"loss","ok":%s,"pct":%u,"s":%u,"dir":"%s"})", ok ? "true" : "false", pct, secs, dir);
                } else if (cmd.starts_with("air_loss")) {
                    if (air) {
                        air->set_loss(arg);
                    }
                } else if (cmd.starts_with("msg_reliable ")) {
                    stdin_msg(net, std::string_view(cmd).substr(13), true);
                } else if (cmd.starts_with("msg ")) {
                    stdin_msg(net, std::string_view(cmd).substr(4), false);
                } else if (cmd.starts_with("bind ")) {
                    std::string_view h = std::string_view(cmd).substr(5);
                    std::vector<uint8_t> bytes(h.size() / 2);
                    const bool hex_ok = h.size() % 2 == 0 && ota_fake::unhex(h, bytes);
                    const fr::Status st = hex_ok ? net.set_binding(bytes) : fr::Status{std::unexpected(fr::Err::invalid_args)};
                    emit(R"({"ev":"bind","ok":%s})", st ? "true" : "false");
                } else if (cmd.starts_with("unbind ")) {
                    const bool all = cmd.ends_with(" all");
                    const fr::Status st = net.clear_binding(all ? fr::net::kBindSlotAll : static_cast<uint8_t>(arg));
                    emit(R"({"ev":"unbind","ok":%s})", st ? "true" : "false");
                } else if (cmd == "bindings") {
                    const auto list = net.encode_bindings(node.bind_buf());
                    emit(R"({"ev":"bindings","ok":%s,"hex":"%s"})", list ? "true" : "false",
                         list ? ota_fake::hex(*list).c_str() : "");
                } else if (cmd == "neighbors") {
                    print_neighbors(net, core.now());
                } else if (cmd == "directory") {
                    print_directory(net);
                } else if (cmd.starts_with("inject ")) {
                    // A gesture on the boot button, as the hub's input_simulate: its events, and the bindings
                    // they fire, go through Net like a real press (T-NN without a hub).
                    fr::cap::ButtonGesture g{};
                    const bool known = fr::cap::from_name(std::string_view(cmd).substr(7), g);
                    const fr::Status st = known ? button.inject({.gesture = g}) : fr::Status{std::unexpected(fr::Err::invalid_args)};
                    emit(R"({"ev":"inject","ok":%s})", st ? "true" : "false");
                } else if (cmd == "bye") {
                    net.bye(fr::net::kByeShutdown);
                } else if (cmd == "crash") {
                    // A panic: no BYE, nothing flushed but what is already written; the next start's
                    // reset reason says so (a rollback's `crash`).
                    flash.note_crash();
                    emit(R"({"ev":"crash"})");
                    std::_Exit(3);
                } else if (cmd == "quit") {
                    quit = true;
                }
            }
        }
    }
    print_state(net, air ? &*air : nullptr);
    if (pin_fd >= 0) {
        ::close(pin_fd);
    }
    return 0;
}
