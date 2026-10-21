// Boot and runtime wiring (spec 03 §3.4-3.5, design c2 §5, c3 §3): identity and epoch, the hub link
// (fr_net's Net over the serial, TCP and UDP links), fr_serial and the diag channel, the port table with
// the system capabilities, HELLO's facts, the C1 banner and the liveness log.
#include "fr/core.hpp"

#include <array>
#include <atomic>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <optional>

#include "catalog.hpp"  // generated cap::catalog_hash
#include "diag.hpp"     // generated fr::cap::Diag
#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_core.hpp"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "fr/core/descriptor.hpp"
#include "fr/diag.hpp"
#include "fr/envelope.hpp"
#include "fr/hash.hpp"
#include "fr/net/esp.hpp"
#include "fr/net/net.hpp"
#include "fr/serial.hpp"
#include "fr/serial_line.hpp"
#include "led.hpp"       // generated fr::cap::Led (identify blinks the first LED)
#include "messages.hpp"  // generated fr::proto::Descriptor
#include "node.hpp"      // generated fr::cap::Node
#include "nvs_flash.h"
#include "sdkconfig.h"

namespace fr::core {
namespace {

using net::LinkKind;

constexpr const char *TAG = "fr";
constexpr uint32_t kAlivePeriodMs = 10000;
// Long enough for the RESULT or diag response (and a BYE) to leave through fr_serial or TCP first.
constexpr uint32_t kRebootDelayUs = 250'000;
// USB host presence is what makes the serial ENV channel a hub link (design c3 §3); a host that went
// away is noticed within this.
constexpr uint32_t kSerialPollUs = 250'000;
constexpr size_t kMaxPorts = kMaxInstances + 2;  // node + instances + diag
constexpr size_t kLineBufs = 2;
constexpr size_t kLineBytes = 512;  // diag request lines (fr.diag.exec carries at most 200)
// Received envelopes: hub frames are realtime-sized (WELCOME, DIRECTORY, TIME, CMDs, ACKs); a couple of
// bulk buffers take anything up to the MTU (spec 03 §3.4: a static pool, e.g. 16 x 256 + 2 x 1500).
constexpr size_t kRxSmall = 12;
constexpr size_t kRxSmallBytes = 256;
constexpr size_t kRxBig = 2;
constexpr size_t kRxBigBytes = proto::kMtuBulk;

fr_identity_t s_identity;
char s_fw_id[13] = "unknown";
uint8_t s_fw_prefix[8] = {};
EspCore s_core;
// Net is the Sink, so it exists before fr::board::attach; built in start() (Kconfig, timers).
std::optional<net::Net> s_net;

PortEntry s_ports[kMaxPorts];
diag::PortInfo s_diag_ports[kMaxPorts];
size_t s_nports = 0;
SelftestFn s_selftest = nullptr;

Timer *s_reboot_timer = nullptr;
bool s_reboot_bootloader = false;
Timer *s_serial_timer = nullptr;

// HELLO's facts (05 §5.7), fixed once the ports are known; `caps` gains `wifi` when Wi-Fi starts.
net::HelloInfo s_hello;
std::atomic<uint32_t> s_hello_caps{0};
uint8_t s_descriptor[proto::Descriptor::kMaxSize];
size_t s_descriptor_len = 0;

// Counters for diag `stats`; the reader and fr_net tasks write rx_dropped, the core task env_bad.
std::atomic<uint32_t> s_rx_dropped{0};
uint32_t s_env_bad = 0;

net::Config net_config()
{
    // Field by field: fr_net may add fields with their own defaults.
    net::Config c;
    c.heartbeat_ms = CONFIG_FR_HEARTBEAT_MS;
    c.offline_x10 = CONFIG_FR_OFFLINE_X10;
    c.offline_min_ms = CONFIG_FR_OFFLINE_MIN_MS;
    c.ack_base_ms = CONFIG_FR_ACK_BASE_MS;
    c.max_attempts = CONFIG_FR_MAX_ATTEMPTS;
    c.event_max_age_ms = CONFIG_FR_EVENT_MAX_AGE_MS;
    c.tcp_delivery_ms = CONFIG_FR_TCP_DELIVERY_MS;
    c.hello_retry_ms = CONFIG_FR_HELLO_RETRY_MS;
    c.ttl_default = CONFIG_FR_TTL_DEFAULT;
    return c;
}

void load_fw_id()
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    uint8_t sha[32];
    if (running && esp_partition_get_sha256(running, sha) == ESP_OK) {
        snprintf(s_fw_id, sizeof(s_fw_id), "%02x%02x%02x%02x%02x%02x", sha[0], sha[1], sha[2], sha[3], sha[4],
                 sha[5]);
        std::memcpy(s_fw_prefix, sha, sizeof(s_fw_prefix));
    }
}

const PortEntry *find_port(uint8_t port)
{
    for (size_t i = 0; i < s_nports; ++i) {
        if (s_ports[i].port == port) {
            return &s_ports[i];
        }
    }
    return nullptr;
}

void report_all_ports()
{
    for (size_t i = 0; i < s_nports; ++i) {
        if (s_ports[i].cap != nullptr && s_ports[i].ok) {
            s_ports[i].cap->report_all();
        }
    }
}

/** BYE on every hub session (05 §5.11), then the restart once the answers have left. */
void schedule_reboot(bool bootloader)
{
    s_net->bye(bootloader ? net::kByeMaintenance : net::kByeReboot);
    s_reboot_bootloader = bootloader;
    if (s_reboot_timer == nullptr) {
        diag::restart(bootloader);
    }
    s_reboot_timer->start(kRebootDelayUs);
}

proto::OtaState ota_state()
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (running == nullptr || esp_ota_get_state_partition(running, &st) != ESP_OK) {
        return proto::OtaState::undefined;  // a factory or never-OTAed image has no otadata record
    }
    switch (st) {
    case ESP_OTA_IMG_NEW:
        return proto::OtaState::new_;
    case ESP_OTA_IMG_PENDING_VERIFY:
        return proto::OtaState::pending_verify;
    case ESP_OTA_IMG_VALID:
        return proto::OtaState::valid;
    case ESP_OTA_IMG_INVALID:
        return proto::OtaState::invalid;
    case ESP_OTA_IMG_ABORTED:
        return proto::OtaState::aborted;
    default:
        return proto::OtaState::undefined;
    }
}

/** HELLO's fields and the descriptor behind its hash; needs the port table. */
void build_hello()
{
    s_descriptor_len = build_descriptor({.fw_id_prefix = s_fw_prefix,
                                         .catalog_hash = cap::catalog_hash(),
                                         .profile = s_identity.profile,
                                         .board = s_identity.board},
                                        {s_ports, s_nports}, s_descriptor);
    if (s_descriptor_len == 0) {
        ESP_LOGE(TAG, "descriptor does not fit; describe answers FAILED");
    }
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    net::HelloInfo &h = s_hello;
    std::memcpy(h.mac.data(), s_identity.mac, h.mac.size());
    h.chip = static_cast<uint8_t>(CONFIG_IDF_FIRMWARE_CHIP_ID);  // the image chip id: C3 5, S3 9, C6 13
    h.chip_rev = chip.revision;
    std::memcpy(h.fw_id_prefix.data(), s_fw_prefix, h.fw_id_prefix.size());
    h.descriptor_hash = wire::descriptor_hash({s_descriptor, s_descriptor_len});
    h.board_hash = wire::board_hash(s_identity.board);
    h.role = proto::Role::node;
    h.hb_interval_ms = CONFIG_FR_HEARTBEAT_MS;
    h.reset_reason = static_cast<uint8_t>(esp_reset_reason());
    h.ota_state = ota_state();  // fixed for the boot until fr_ota (C4) marks the image valid
    uint32_t caps = 0;
    if (FR_TEST_HOOKS) {
        caps |= net::kCapInjectEnabled;
    }
    if (s_identity.state == FR_ID_PROVISIONED) {
        caps |= net::kCapProvisioned;
    }
    s_hello_caps.store(caps, std::memory_order_relaxed);
}

// ---- links ----

/**
 * The serial ENV channel as a hub link (05 §5.12.3): up while a USB host is attached, so a node on a
 * charger does not HELLO into a port nobody reads. There is no connection to drop: after a lost session
 * Net simply HELLOs again. Core task.
 */
class SerialLink final : public net::Link
{
public:
    LinkKind kind() const override { return LinkKind::serial; }
    bool up() const override { return host_; }
    Status send(std::span<const uint8_t> envelope) override
    {
        // A full frame ring (the host stopped reading) drops it, as fr_serial counts.
        return serial::write_frame(wire::kSerialEnv, envelope) ? Status{} : Status{std::unexpected(Err::busy)};
    }

    /** Samples USB host presence without telling anyone: before Net has the link. */
    void sample() { host_ = serial::connected(); }

    /** Samples USB host presence (core task timer); tells Net when it changed. */
    void poll()
    {
        bool was = host_;
        host_ = serial::connected();
        if (host_ != was) {
            s_net->link_changed(LinkKind::serial);
        }
    }

private:
    bool host_ = false;
};

SerialLink s_serial;

/** Received envelopes: lent to the core task with each post, never more in flight than the pool. */
struct RxBuf {
    bool busy;
    uint16_t len;
    uint16_t cap;
    uint8_t *bytes;
};

portMUX_TYPE s_buf_mux = portMUX_INITIALIZER_UNLOCKED;
uint8_t s_rx_small_mem[kRxSmall][kRxSmallBytes];
uint8_t s_rx_big_mem[kRxBig][kRxBigBytes];
RxBuf s_rx[kRxSmall + kRxBig];

void init_rx_pool()
{
    for (size_t i = 0; i < kRxSmall; ++i) {
        s_rx[i] = {.busy = false, .len = 0, .cap = kRxSmallBytes, .bytes = s_rx_small_mem[i]};
    }
    for (size_t i = 0; i < kRxBig; ++i) {
        s_rx[kRxSmall + i] = {.busy = false, .len = 0, .cap = kRxBigBytes, .bytes = s_rx_big_mem[i]};
    }
}

/** The first free buffer that holds `size` (small ones come first). */
RxBuf *acquire_rx(size_t size)
{
    RxBuf *b = nullptr;
    portENTER_CRITICAL(&s_buf_mux);
    for (RxBuf &candidate : s_rx) {
        if (!candidate.busy && candidate.cap >= size) {
            candidate.busy = true;
            b = &candidate;
            break;
        }
    }
    portEXIT_CRITICAL(&s_buf_mux);
    return b;
}

void release_rx(RxBuf *b)
{
    portENTER_CRITICAL(&s_buf_mux);
    b->busy = false;
    portEXIT_CRITICAL(&s_buf_mux);
}

/** Core task: one received envelope into Net. */
void on_envelope(LinkKind kind, RxBuf *b)
{
    std::span<const uint8_t> env{b->bytes, b->len};
    if (!wire::unpack_header(env)) {
        ++s_env_bad;  // Net drops it too; counted here for diag `stats` env_bad
    }
    s_net->receive(kind, env);
    release_rx(b);
}

/** Any task (fr_serial reader, fr_net): copies the envelope and queues it for the core task. */
bool deliver(LinkKind kind, std::span<const uint8_t> envelope)
{
    RxBuf *b = acquire_rx(envelope.size());
    if (b == nullptr) {
        s_rx_dropped.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    std::memcpy(b->bytes, envelope.data(), envelope.size());
    b->len = static_cast<uint16_t>(envelope.size());
    if (!s_core.post_net([kind, b] { on_envelope(kind, b); })) {
        release_rx(b);
        s_rx_dropped.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    return true;
}

/** fr_net task: a TCP or UDP link went up or down. */
bool post_link_changed(LinkKind kind)
{
    return s_core.post([kind] { s_net->link_changed(kind); });
}

// ---- system capabilities ----

/** True when `s` has a NUL in it, which the C-string APIs below would cut short. */
bool has_nul(std::string_view s)
{
    return s.find('\0') != std::string_view::npos;
}

/** WPA: an 8-63 character passphrase or 64 hex digits; empty for an open network. */
bool passphrase_ok(std::string_view p)
{
    if (p.empty() || (p.size() >= 8 && p.size() <= 63)) {
        return true;
    }
    if (p.size() != 64) {
        return false;
    }
    for (char c : p) {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
            return false;
        }
    }
    return true;
}

template <size_t N>
void copy_cstr(char (&dst)[N], std::string_view s)
{
    size_t n = s.size() < N - 1 ? s.size() : N - 1;
    std::memcpy(dst, s.data(), n);
    dst[n] = '\0';
}

/** fr.node on port 0 (07 §7.3, design c3 §3). bind_* and set_groups arrive with C5/M2. */
class NodeService final : public cap::Node
{
public:
    Status identify(const cap::NodeIdentifyArgs &args) override
    {
        // Blink the first working LED for about `ms`; a node without one just logs.
        ESP_LOGI(TAG, "identify %u ms", static_cast<unsigned>(args.ms));
        for (size_t i = 0; i < s_nports; ++i) {
            const PortEntry &p = s_ports[i];
            if (p.ok && p.cap != nullptr && p.cap->cap_id() == cap::Led::kId) {
                cap::LedBlinkArgs b;
                b.on_ms = 100;
                b.off_ms = 100;
                b.count = static_cast<uint16_t>(args.ms / 200 > 0 ? args.ms / 200 : 1);
                return static_cast<cap::Led *>(p.cap)->blink(b);
            }
        }
        return {};
    }

    std::expected<cap::NodeDescribeResult, Err> describe() override
    {
        // BULK (~90 B per two instances): over UDP the realtime Reply may not hold it, and dispatch says
        // FAILED; the hub asks over TCP or serial.
        if (s_descriptor_len == 0) {
            return std::unexpected(Err::failed);
        }
        return cap::NodeDescribeResult{.descriptor = {s_descriptor, s_descriptor_len}};
    }

    Status reboot(const cap::NodeRebootArgs &args) override
    {
        if (args.bootloader && !diag::can_enter_bootloader()) {
            return std::unexpected(Err::unsupported);
        }
        // design c3 §3: this RESULT, then BYE `reboot` (Net sends a BYE asked for inside a request after
        // its RESULT), then the restart.
        schedule_reboot(args.bootloader);
        return {};
    }

    Status set_alias(const cap::NodeSetAliasArgs &args) override
    {
        char alias[FR_ID_ALIAS_MAX + 1];
        if (has_nul(args.alias) || args.alias.size() > FR_ID_ALIAS_MAX) {
            return std::unexpected(Err::invalid_args);
        }
        copy_cstr(alias, args.alias);
        // A rare admin command: the NVS write runs here rather than on a worker, and the new alias is
        // in the next HELLO and every diag answer at once.
        esp_err_t err = fr_id_set_alias(&s_identity, alias, args.rev);
        if (err == ESP_ERR_INVALID_ARG) {
            return std::unexpected(Err::invalid_args);
        }
        if (err != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        ESP_LOGI(TAG, "alias %s (rev %" PRIu32 ")", s_identity.alias, s_identity.alias_rev);
        return {};
    }

    Status set_groups(const cap::NodeSetGroupsArgs &) override { return std::unexpected(Err::unsupported); }

    Status net_set(const cap::NodeNetSetArgs &args) override
    {
        if (args.ssid.empty() || has_nul(args.ssid) || has_nul(args.pass) || !passphrase_ok(args.pass) ||
            (args.has_bssid && args.bssid.size() != 6) ||
            (args.has_hub_host && (args.hub_host.empty() || has_nul(args.hub_host)))) {
            return std::unexpected(Err::invalid_args);
        }
        fr_net_creds_t c{};
        copy_cstr(c.ssid, args.ssid);
        copy_cstr(c.pass, args.pass);
        c.has_bssid = args.has_bssid;
        if (args.has_bssid) {
            std::memcpy(c.bssid, args.bssid.data(), sizeof(c.bssid));
        }
        if (args.has_hub_host) {
            copy_cstr(c.hub_host, args.hub_host);
        }
        Status st = net::esp::net_set(c);
        std::memset(&c, 0, sizeof(c));  // the passphrase now lives with fr_net only
        return st;
    }

    Status get_state() override
    {
        report_all_ports();
        return {};
    }
    Status bind_set() override { return std::unexpected(Err::unsupported); }
    Status bind_clear(const cap::NodeBindClearArgs &) override { return std::unexpected(Err::unsupported); }
    Status bind_list() override { return std::unexpected(Err::unsupported); }
};

/** fr.diag on port 241: the serial command channel's commands as a capability, over any hub link. */
class DiagService final : public cap::Diag
{
public:
    std::expected<cap::DiagExecResult, Err> exec(const cap::DiagExecArgs &args) override;

private:
    char out_[cap::DiagExecResult::kMaxSize];
};

NodeService s_node;
DiagService s_diag;

// ---- hosts ----

/** What Net needs from the node (design c3 §3). Core task. */
class NetHost final : public net::Host
{
public:
    Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, cap::Reply &reply) override
    {
        const PortEntry *p = find_port(port);
        if (p == nullptr || p->cap == nullptr) {
            return std::unexpected(Err::not_found);
        }
        if (!p->ok) {
            return std::unexpected(Err::failed);
        }
        return p->cap->dispatch(cmd, args, reply);
    }

    void report_all() override { report_all_ports(); }

    net::HelloInfo hello_info() override
    {
        net::HelloInfo h = s_hello;
        h.caps = s_hello_caps.load(std::memory_order_relaxed);
        return h;
    }

    net::Identity identity() override
    {
        net::Identity id;
        id.addr = s_identity.state == FR_ID_PROVISIONED ? s_identity.addr : proto::kAddrUnassigned;
        id.net = s_identity.state == FR_ID_PROVISIONED ? s_identity.net : 0;
        std::snprintf(id.alias, sizeof(id.alias), "%s", s_identity.alias);
        id.alias_rev = s_identity.alias_rev;
        id.epoch = s_identity.epoch;
        return id;
    }

    net::LinkInfo link_info() override { return net::esp::link_info(); }

    net::Vitals vitals() override
    {
        net::Vitals v;
        v.free_heap_kb = esp_get_free_heap_size() / 1024;
        return v;
    }
};

NetHost s_net_host;

/**
 * Counters diag `stats` shows that Net does not keep (Net has reset_stats()): the links' and fr_core's,
 * by index. `stats reset` keeps a copy and later answers the difference, since they count from boot.
 */
enum Ctr : size_t {
    kWifiDisconnects,
    kTcpConnects,
    kTcpCloses,
    kTcpClosePeer,
    kTcpCloseKeepalive,
    kTcpCloseError,
    kTcpCloseSession,
    kTcpCloseWifi,
    kTcpTxDropped,
    kTcpRxBad,
    kUdpTxFail,
    kEnvBad,
    kRxDropped,
    kCounters,
};
using Counters = std::array<uint32_t, kCounters>;

Counters s_base{};

Counters counters_now(const net::esp::Status &es)
{
    Counters c{};
    c[kWifiDisconnects] = es.wifi_disconnects;
    c[kTcpConnects] = es.tcp_connects;
    c[kTcpCloses] = es.tcp_closes;
    c[kTcpClosePeer] = es.tcp_close_peer;
    c[kTcpCloseKeepalive] = es.tcp_close_keepalive;
    c[kTcpCloseError] = es.tcp_close_error;
    c[kTcpCloseSession] = es.tcp_close_session;
    c[kTcpCloseWifi] = es.tcp_close_wifi;
    c[kTcpTxDropped] = es.tcp_tx_dropped;
    c[kTcpRxBad] = es.tcp_rx_bad;
    c[kUdpTxFail] = es.udp_tx_fail;
    c[kEnvBad] = s_env_bad;
    // deliver() counts every envelope the core could not take, whichever link brought it.
    c[kRxDropped] = s_rx_dropped.load(std::memory_order_relaxed);
    return c;
}

/** Counts since the last `stats reset` (unsigned wrap-around keeps the difference right). */
Counters counters_since_reset(const net::esp::Status &es)
{
    Counters c = counters_now(es);
    for (size_t i = 0; i < c.size(); ++i) {
        c[i] -= s_base[i];
    }
    return c;
}

/** What the serial command channel needs from the runtime. Core task. */
class DiagHost final : public diag::Host
{
public:
    const fr_identity_t &identity() const override { return s_identity; }
    const char *fw_id() const override { return s_fw_id; }
    std::span<const diag::PortInfo> ports() const override { return {s_diag_ports, s_nports}; }
    bool selftest(const char *name, diag::SelftestResult &out) override
    {
        for (size_t i = 0; i < s_nports; ++i) {
            if (std::strcmp(s_ports[i].name, name) == 0) {
                if (s_selftest == nullptr) {
                    out = {false, "no self-test"};
                } else {
                    hal::Selftest r = s_selftest(name);
                    out = {r.ok, r.detail};
                }
                return true;
            }
        }
        return false;
    }
    cap::Sink &sink() override { return *s_net; }

    diag::RuntimeStats runtime_stats() const override
    {
        net::State st = s_net->state();
        Counters c = counters_since_reset(net::esp::status());
        uint32_t ignored = 0;
        for (const net::LinkState &l : st.links) {
            ignored += l.rx_drop;
        }
        // Net's rx_drop counts undecodable envelopes too (env_bad reports those apart), and the ones a
        // debug hook swallowed.
        ignored = ignored > c[kEnvBad] ? ignored - c[kEnvBad] : 0;
        return {.cmds = st.cmds,
                .env_ignored = ignored,
                .env_bad = c[kEnvBad],
                .rx_dropped = c[kRxDropped],
                .posts_dropped = s_core.posts_dropped()};
    }

    void reset_runtime_stats() override
    {
        s_net->reset_stats();
        s_base = counters_now(net::esp::status());
        s_core.reset_posts_dropped();
    }

    diag::NetStatus net_status() const override
    {
        net::State st = s_net->state();
        net::esp::Status es = net::esp::status();
        Counters c = counters_since_reset(es);
        diag::NetStatus n;
        static_assert(diag::kLinks == net::kLinkKinds);
        for (size_t i = 0; i < net::kLinkKinds; ++i) {
            const net::LinkState &l = st.links[i];
            n.links[i] = {.attached = l.attached,
                          .up = l.up,
                          .session = l.session,
                          .udp_ok = l.udp_ok,
                          .time_synced = l.time_synced,
                          .tx = l.tx,
                          .tx_fail = l.tx_fail,
                          .rx = l.rx,
                          .rx_drop = l.rx_drop,
                          .retries = l.retries};
        }
        n.hub_link = st.hub_link();
        n.hub_epoch = st.hub_epoch;
        n.events_dropped = st.events_dropped;
        n.delivery_failed = st.delivery_failed;
        n.cmds_refused = st.cmds_refused;
        n.dup = st.dup;
        n.old = st.old;
        n.cached_replies = st.cached_replies;
        n.sessions_lost = st.sessions_lost;
        n.sessions_timed_out = st.sessions_timed_out;
        n.wifi_started = es.started;
        n.wifi_up = es.ip_up;
        std::memcpy(n.ssid, es.ssid, sizeof(n.ssid));
        n.channel = es.channel;
        std::memcpy(n.bssid, es.bssid, sizeof(n.bssid));
        n.rssi = es.rssi;
        std::memcpy(n.ip, es.ip, sizeof(n.ip));
        n.net_override = es.override_active;
        n.net_trial = es.override_trial;
        std::snprintf(n.hub_host, sizeof(n.hub_host), "%s", es.hub_host);
        std::memcpy(n.hub_ip, es.hub_ip, sizeof(n.hub_ip));
        n.wifi_disconnects = c[kWifiDisconnects];
        n.wifi_last_reason = es.wifi_last_reason;
        n.tcp_connects = c[kTcpConnects];
        n.tcp_closes = c[kTcpCloses];
        n.tcp_close_peer = c[kTcpClosePeer];
        n.tcp_close_keepalive = c[kTcpCloseKeepalive];
        n.tcp_close_error = c[kTcpCloseError];
        n.tcp_close_session = c[kTcpCloseSession];
        n.tcp_close_wifi = c[kTcpCloseWifi];
        n.tcp_last_errno = es.tcp_last_errno;
        n.tcp_tx_dropped = c[kTcpTxDropped];
        n.tcp_rx_bad = c[kTcpRxBad];
        n.udp_tx_fail = c[kUdpTxFail];
        n.hook_dropped = st.hook_drops;
        n.hub_link_dropped = st.hub_link_dropped;
        n.udp_blocked = st.udp_blocked;
        return n;
    }

    Status net_hook(diag::NetHook hook, uint32_t seconds) override
    {
        // Net defers a hook asked for inside its receive() until that request's RESULT has gone out.
        bool drop = hook == diag::NetHook::drop_hub_link;
        if (drop) {
            s_net->drop_hub_link(seconds);
        } else {
            s_net->udp_block(seconds);
        }
        ESP_LOGW(TAG, "debug hook %s %" PRIu32 " s", drop ? "drop_hub_link" : "udp_block", seconds);
        return {};
    }

    void reboot(bool bootloader) override { schedule_reboot(bootloader); }
};

DiagHost s_diag_host;

std::expected<cap::DiagExecResult, Err> DiagService::exec(const cap::DiagExecArgs &args)
{
    // `call diag.exec` inside an exec line would recurse through execute() on the core task's stack
    // (and reuse out_), one level per nested line. One level is all the channel needs.
    static bool s_in_exec = false;  // core task only
    if (s_in_exec) {
        return std::unexpected(Err::busy);
    }
    s_in_exec = true;
    size_t n = diag::execute(args.line, s_diag_host, out_);
    s_in_exec = false;
    if (n == 0) {
        return std::unexpected(Err::invalid_args);  // a blank line has no answer
    }
    return cap::DiagExecResult{.json = {out_, n}};
}

// ---- serial input (fr_serial reader task) ----

/** Fixed buffers lent to the core task with each posted diag line. */
struct LineBuf {
    bool busy = false;
    size_t len = 0;
    char bytes[kLineBytes];
};

LineBuf s_line_bufs[kLineBufs];

LineBuf *acquire_line()
{
    LineBuf *b = nullptr;
    portENTER_CRITICAL(&s_buf_mux);
    for (LineBuf &candidate : s_line_bufs) {
        if (!candidate.busy) {
            candidate.busy = true;
            b = &candidate;
            break;
        }
    }
    portEXIT_CRITICAL(&s_buf_mux);
    return b;
}

void release_line(LineBuf *b)
{
    portENTER_CRITICAL(&s_buf_mux);
    b->busy = false;
    portEXIT_CRITICAL(&s_buf_mux);
}

bool on_frame_line(std::string_view line)
{
    static uint8_t scratch[wire::kMaxLineFrame];  // the reader task is the only caller
    auto frame = wire::decode_line(line, scratch);
    if (!frame) {
        return false;
    }
    if (frame->type == wire::kSerialEnv) {
        deliver(LinkKind::serial, frame->body);
    }
    return true;  // GW_* and LINK_* frames are for a gateway (M2)
}

/** Answers a request the core task never saw (no buffer, queue full), keeping its `#<id>`. */
void reject_line(std::string_view line, const char *error, const char *detail)
{
    size_t id_len = 0;
    if (!line.empty() && line.front() == '#') {
        while (id_len + 1 < line.size() && id_len < 8 && line[id_len + 1] >= '0' && line[id_len + 1] <= '9') {
            ++id_len;
        }
    }
    char out[128];
    int n = id_len > 0 ? snprintf(out, sizeof(out), "#%.*s {\"ok\":false,\"error\":\"%s\",\"detail\":\"%s\"}",
                                  static_cast<int>(id_len), line.data() + 1, error, detail)
                       : snprintf(out, sizeof(out), "{\"ok\":false,\"error\":\"%s\",\"detail\":\"%s\"}", error, detail);
    if (n > 0) {
        serial::write_line({out, static_cast<size_t>(n) < sizeof(out) ? static_cast<size_t>(n) : sizeof(out) - 1});
    }
}

void on_text_line(std::string_view line)
{
    if (line.size() > kLineBytes) {
        s_rx_dropped.fetch_add(1, std::memory_order_relaxed);
        reject_line(line, "invalid_args", "request line too long");
        return;
    }
    LineBuf *b = acquire_line();
    if (b == nullptr) {
        s_rx_dropped.fetch_add(1, std::memory_order_relaxed);
        reject_line(line, "busy", "previous requests still running");
        return;
    }
    std::memcpy(b->bytes, line.data(), line.size());
    b->len = line.size();
    bool posted = s_core.post([b] {
        static char out[wire::kMaxLine];  // core task only
        size_t n = diag::execute({b->bytes, b->len}, s_diag_host, out);
        release_line(b);
        if (n > 0) {
            serial::write_line({out, n});
        }
    });
    if (!posted) {
        release_line(b);
        s_rx_dropped.fetch_add(1, std::memory_order_relaxed);
        reject_line(line, "busy", "core queue full");
    }
}

// ---- Wi-Fi ----

/** fr_ident's network, or the dev fallback (06 §6.4: an UNASSIGNED node uses CONFIG_FR_DEV_WIFI_*). */
net::esp::Settings wifi_settings()
{
    net::esp::Settings ws;
    fr_net_config_t nc;
    if (fr_id_load_net(&nc) == ESP_OK) {
        ws.creds = nc.creds;
        std::memcpy(ws.country, nc.country, sizeof(ws.country));
        std::memcpy(ws.hub_ip, nc.hub_ip, sizeof(ws.hub_ip));
        ws.prov_ts = nc.prov_ts;
    } else if (CONFIG_FR_DEV_WIFI_SSID[0] != '\0') {
        ESP_LOGW(TAG, "no provisioned network: using the dev Wi-Fi from sdkconfig");
        std::snprintf(ws.creds.ssid, sizeof(ws.creds.ssid), "%s", CONFIG_FR_DEV_WIFI_SSID);
        std::snprintf(ws.creds.pass, sizeof(ws.creds.pass), "%s", CONFIG_FR_DEV_WIFI_PASS);
        std::snprintf(ws.creds.hub_host, sizeof(ws.creds.hub_host), "%s", CONFIG_FR_DEV_HUB_HOST);
    }
    std::memset(&nc, 0, sizeof(nc));
    std::snprintf(ws.hostname, sizeof(ws.hostname), "%s", s_identity.alias);
    std::memcpy(ws.mac, s_identity.mac, sizeof(ws.mac));
    ws.hub_port = CONFIG_FR_HUB_PORT;
    return ws;
}

void start_wifi()
{
    net::esp::Settings ws = wifi_settings();
    bool ok = net::esp::start(ws, {.link_changed = post_link_changed, .deliver = deliver});
    std::memset(&ws.creds, 0, sizeof(ws.creds));
    if (ok) {
        s_hello_caps.fetch_or(net::kCapWifi, std::memory_order_relaxed);
    } else {
        ESP_LOGE(TAG, "Wi-Fi did not start: the hub is reachable over serial only");
    }
}

[[noreturn]] void alive_loop()
{
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(kAlivePeriodMs));
        ESP_LOGI(TAG, "alive id=%s uptime_s=%" PRId64 " heap=%" PRIu32, s_identity.device_id,
                 esp_timer_get_time() / 1000000, static_cast<uint32_t>(esp_get_free_heap_size()));
    }
}

}  // namespace

Core &start()
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // Unusable as it is. Erasing loses the stored epoch; epoch_floor and the hub's epoch_regressed
        // handling (05 §5.8) cover that.
        ESP_LOGW(TAG, "nvs: %s, erasing", esp_err_to_name(err));
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_flash_init: %s", esp_err_to_name(err));
    }
    fr_id_load(&s_identity);
    // Before anything can transmit (05 §5.5): frames only start once the core task runs.
    fr_id_commit_boot_epoch(&s_identity);
    load_fw_id();
    init_rx_pool();
    // The runtime's timers are taken before fr::board::init can drain the pool, so `reboot` always
    // answers before it restarts. Without the wake-up alarm no timer would fire: reboot then restarts
    // at once and the serial link stays down.
    if (s_core.begin()) {
        s_reboot_timer = s_core.timer([] { diag::restart(s_reboot_bootloader); });
        s_serial_timer = s_core.timer([] {
            s_serial.poll();
            s_serial_timer->start(kSerialPollUs);
        });
    }
    s_net.emplace(s_core, s_net_host, net_config());
    // Attached now, so Net takes its timer before the board's services drain the pool; nothing is sent
    // before the core task runs (Net's timer sends the first HELLO, once run_ports has the HELLO facts).
    s_serial.sample();
    s_net->attach(s_serial);
    s_net->attach(net::esp::tcp_link());
    s_net->attach(net::esp::udp_link());
    if (!serial::start({.frame = on_frame_line, .text = on_text_line})) {
        ESP_LOGE(TAG, "fr_serial did not start: no frames and no diag channel this boot");
    }
    return s_core;
}

cap::Sink &sink()
{
    return *s_net;
}

void run_ports(std::span<const PortEntry> instances, SelftestFn selftest, size_t left_out)
{
    s_selftest = selftest;
    size_t n = 0;
    s_ports[n++] = {diag::kPortNode, "node", &s_node, true};
    for (const PortEntry &p : instances) {
        if (n == kMaxPorts - 1) {
            ++left_out;
            continue;
        }
        s_ports[n++] = p;
    }
    s_ports[n++] = {diag::kPortDiag, "diag", &s_diag, true};
    size_t caps = n - 2;
    for (size_t i = 0; i < n; ++i) {
        PortEntry &p = s_ports[i];
        // fr::board::attach normally did this already; a capability left unattached would drop its
        // emissions (Capability::port() is 0xFF until attached).
        if (p.cap != nullptr && p.cap->port() == 0xFF) {
            p.cap->attach(p.port, p.name, *s_net);
        }
        s_diag_ports[i] = {p.port, p.name, p.cap, p.ok};
        if (!p.ok) {
            ESP_LOGE(TAG, "port %u (%s) failed init; its commands answer FAILED", p.port, p.name);
        }
    }
    if (left_out > 0) {
        ESP_LOGE(TAG, "%u instances beyond the %u-port table were left out", static_cast<unsigned>(left_out),
                 static_cast<unsigned>(kMaxInstances));
    }
    s_nports = n;
    build_hello();

    // The core task's first round: every property once (C2 behaviour; with no session yet Net drops
    // them, and get_state resends them after WELCOME).
    s_core.post([] { report_all_ports(); });
    if (s_serial_timer != nullptr) {
        s_serial_timer->start(kSerialPollUs);
    }

    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    // The banner is the C1 contract with the hub and agents (`fr wait log "fr: ready id=<id>"`): fields
    // may be appended, never removed or reordered.
    ESP_LOGI(TAG,
             "ready id=%s fw=%s state=%s addr=%04x alias=%s board=%s profile=%s part=%s app=%s ver=%s idf=%s "
             "reset=%s slot=%s caps=%u epoch=%u",
             s_identity.device_id, s_fw_id, fr_id_state_name(s_identity.state), s_identity.addr, s_identity.alias,
             s_identity.board, s_identity.profile, CONFIG_FR_PART_PROFILE, app->project_name, app->version,
             app->idf_ver, diag::reset_reason(), running ? running->label : "?", static_cast<unsigned>(caps),
             static_cast<unsigned>(s_identity.epoch));
    if (!s_core.run()) {
        ESP_LOGE(TAG, "no core task: capabilities will not run");
    }
    // 03 §3.5 step 5: the TCP and UDP links come up from here.
    start_wifi();
    alive_loop();
}

const fr_identity_t &identity()
{
    return s_identity;
}

const char *fw_id()
{
    return s_fw_id;
}

}  // namespace fr::core
