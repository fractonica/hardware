// fr_net_node: one node on the host for interop runs against a real hub on loopback (design c3 §5). The
// real fr_net core (fr::net::Net), the real button and LED services and the descriptor builder talk to the
// hub over POSIX TCP (`len u16 LE` framing) and UDP, as fr_net/src/esp does on target, and optionally over
// a serial line on stdin/stdout (`@fr1:` ENV lines, as fr_serial); a poll() loop is the core task. It shows
// that the C++ node and the TS router agree on the wire, the handshake, keepalives, udp_ok, the response
// cache, expire_at and BYE before any board runs them.
//
//   fr_net_node --hub-tcp <port> --hub-udp <port> --mac <12 hex> [--host 127.0.0.1] [--addr <n>] [--net <n>]
//               [--epoch <n>] [--hb-ms <n>] [--alias <a>] [--alias-rev <n>] [--fw <16 hex>] [--serial 1]
//
// Stdin takes one command per line: `state`, `udp_block <s>`, `drop_hub_link <s>`, `bye`, `tcp 0|1` (close
// TCP and stay off / reconnect), `usb 0|1` (the serial link's USB host), `quit`, and with --serial the
// hub's `@fr1:` lines. Stdout gets one JSON object per line (`{"ev":"..."}`): link changes, udp_ok changes,
// dispatched commands, LED levels, `state` answers and `reboot`; with --serial also the node's `@fr1:`
// lines. Test code: it may allocate.
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstdarg>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "catalog.hpp"
#include "fr/core/core.hpp"
#include "fr/core/descriptor.hpp"
#include "fr/core/port.hpp"
#include "fr/hash.hpp"
#include "fr/net/net.hpp"
#include "fr/serial_line.hpp"
#include "fr/services/button_service.hpp"
#include "fr/services/led_service.hpp"
#include "messages.hpp"  // generated fr::proto::Descriptor
#include "node.hpp"

namespace {

using fr::TimeUs;
using fr::net::LinkKind;

constexpr TimeUs kNever = INT64_MAX;

void emit(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void emit(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    std::vprintf(fmt, ap);
    va_end(ap);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

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

/** A button nobody presses: inject drives ButtonService, the level stays released. */
class IdleButton final : public fr::hal::ButtonSource
{
public:
    fr::Status init(fr::Core &, fr::hal::ButtonSink &) override { return {}; }
    bool level_pressed() const override { return false; }
    fr::hal::Selftest selftest() override { return {true, "idle level ok"}; }
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
            net_->receive(LinkKind::tcp, env);
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
            net_->receive(LinkKind::serial, f->body);
        }
    }

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
    bool up() const override { return fd_ >= 0; }
    fr::Status send(std::span<const uint8_t> envelope) override
    {
        const ssize_t n = ::sendto(fd_, envelope.data(), envelope.size(), 0, reinterpret_cast<const sockaddr *>(&to_), sizeof(to_));
        if (n != static_cast<ssize_t>(envelope.size())) {
            return std::unexpected(fr::Err::busy);
        }
        return {};
    }

private:
    int fd_ = -1;
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
    fr::Status bind_set() override { return std::unexpected(fr::Err::unsupported); }
    fr::Status bind_clear(const fr::cap::NodeBindClearArgs &) override { return std::unexpected(fr::Err::unsupported); }
    fr::Status bind_list() override { return std::unexpected(fr::Err::unsupported); }

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
    bool rebooting() const { return reboot_at_ != kNever && core_.now() >= reboot_at_; }
    TimeUs reboot_at() const { return reboot_at_; }
    NodeCap &node_cap() { return node_cap_; }

    std::span<const uint8_t> descriptor() const { return {desc_, desc_len_}; }
    void reboot(bool bootloader)
    {
        // As fr_core: BYE (after this RESULT, inside a request), then the restart a little later.
        net_->bye(bootloader ? fr::net::kByeMaintenance : fr::net::kByeReboot);
        reboot_at_ = core_.now() + 200'000;
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
                 (o_.addr != fr::proto::kAddrUnassigned ? fr::net::kCapProvisioned : 0);
        h.hb_interval_ms = o_.hb_ms;
        h.reset_reason = 1;
        h.ota_state = fr::proto::OtaState::valid;
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
        return {.wifi_up = true, .channel = 6, .bssid = {0x10, 0x20, 0x30, 0x40, 0x50, 0x60}, .rssi = -48};
    }
    fr::net::Vitals vitals() override { return {.free_heap_kb = 200, .vbat_mv = 0, .ota_busy = false, .low_batt = false}; }

private:
    HostCore &core_;
    Options o_;
    std::span<fr::PortEntry> ports_;
    NodeCap node_cap_{*this};
    fr::net::Net *net_ = nullptr;
    std::string alias_;
    uint32_t alias_rev_ = 0;
    uint8_t desc_[fr::proto::Descriptor::kMaxSize];
    size_t desc_len_ = 0;
    TimeUs reboot_at_ = kNever;
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
                         "[--net N] [--epoch N] [--hb-ms N] [--alias A] [--alias-rev N] [--fw 16hex] [--serial 1]\n", why);
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
        } else {
            usage("unknown option");
        }
    }
    if (!have_mac || o.hub_tcp == 0 || o.hub_udp == 0) {
        usage("--mac, --hub-tcp and --hub-udp are required");
    }
    return o;
}

void print_state(const fr::net::State &s)
{
    const auto &tcp = s.link(LinkKind::tcp);
    const auto &udp = s.link(LinkKind::udp);
    const auto &ser = s.link(LinkKind::serial);
    emit(R"({"ev":"state","serial_session":%s,"serial_tx":%u,"serial_rx":%u,"session":%s,"udp_ok":%s,"time_synced":%s,"hub_epoch":%u,"tcp_tx":%u,"tcp_rx":%u,"udp_tx":%u,)"
         R"("udp_retries":%u,"rx_drop":%u,"cmds":%u,"dup":%u,"old":%u,"cached_replies":%u,"sessions_lost":%u,)"
         R"("events_dropped":%u,"delivery_failed":%u,"udp_blocked":%s,"hook_drops":%u})",
         ser.session ? "true" : "false", ser.tx, ser.rx, tcp.session ? "true" : "false", udp.udp_ok ? "true" : "false", s.time_synced() ? "true" : "false", unsigned{s.hub_epoch},
         tcp.tx, tcp.rx, udp.tx, udp.retries, tcp.rx_drop + udp.rx_drop, s.cmds, s.dup, s.old, s.cached_replies,
         s.sessions_lost, s.events_dropped, s.delivery_failed, s.udp_blocked ? "true" : "false", s.hook_drops);
}

}  // namespace

int main(int argc, char **argv)
{
    const Options o = parse(argc, argv);
    HostCore core;
    IdleButton button_src;
    PrintLight light;
    fr::ButtonService button(button_src, fr::cap::ButtonConfig{});
    fr::LedService led(light, fr::cap::LedConfig{});
    // The c6-pad board table (schema/vectors Descriptor.c6_pad): boot button on 1, status LED on 2.
    std::array<fr::PortEntry, 3> ports{{{0, "node", nullptr, true}, {1, "boot", &button, true}, {2, "status", &led, true}}};
    Device node(core, o, ports);
    ports[0].cap = &node.node_cap();

    fr::net::Config cfg;
    cfg.heartbeat_ms = o.hb_ms;
    fr::net::Net net(core, node, cfg);
    node.set_net(net);
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
    emit(R"({"ev":"started","descriptor_hash":%u})", node.hello_info().descriptor_hash);

    std::string line;
    bool quit = false;
    bool udp_ok = false;
    while (!quit) {
        tcp.try_connect();
        core.run_ready();
        if (const bool ok = net.state().link(LinkKind::udp).udp_ok; ok != udp_ok) {
            udp_ok = ok;
            emit(R"({"ev":"udp_ok","on":%s})", ok ? "true" : "false");
        }
        if (node.rebooting()) {
            emit(R"({"ev":"reboot"})");
            break;
        }
        const TimeUs now = core.now();
        const TimeUs next = std::min({core.next_deadline(), tcp.retry_at(), node.reboot_at(), now + 100'000});
        const int timeout_ms = static_cast<int>(std::max<TimeUs>(0, (next - now + 999) / 1000));
        std::array<pollfd, 2> fds{{{STDIN_FILENO, POLLIN, 0}, {tcp.fd(), POLLIN, 0}}};
        const nfds_t nfds = tcp.fd() >= 0 ? 2 : 1;
        if (::poll(fds.data(), nfds, timeout_ms) < 0 && errno != EINTR) {
            return 1;
        }
        if (nfds == 2 && (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
            tcp.on_readable();
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
                    print_state(net.state());
                } else if (cmd.starts_with("udp_block")) {
                    net.udp_block(arg);
                } else if (cmd.starts_with("drop_hub_link")) {
                    net.drop_hub_link(arg);
                } else if (cmd.starts_with("tcp ")) {
                    tcp.enable(arg != 0);
                } else if (cmd.starts_with("usb ")) {
                    serial.set_host(arg != 0);
                } else if (cmd == "bye") {
                    net.bye(fr::net::kByeShutdown);
                } else if (cmd == "quit") {
                    quit = true;
                }
            }
        }
    }
    print_state(net.state());
    return 0;
}
