// The seam between one node's shared code and the process hosting it (design m2-c2 D2). Stream S2 moved the node
// classes out of tools/net_node.cpp into this kit (Device, NodeCap, NodeDiag, NodeOtaHost, the blobs, the state
// printers and the stdin command table as Commands::run(NodeCtx &, line), commands.hpp); they work on a NodeCtx,
// and reach the links only through NodeLinks, which fr_net_node implements over its own sockets and FakeAir and
// FleetNode over SimTcp, SimUdp, SimSerial, SimAir and the AP model. The two differ on purpose in one place:
// fr_net_node's wifi_down closes its TCP socket (the hub sees a FIN), while the fleet's wifi_down, `tcp 0`, AP down
// and `power off` leave the hub's socket open and silent, as on RF no FIN arrives (D7).
//
// NodeSpec is one node of the fleet spec (FleetSpecSchema, packages/protocol/src/sim.ts) and fr_net_node's options
// in one; a FleetNode owns its NodeSpec behind a unique_ptr, so the references the node classes keep to it survive
// the fleet's vectors growing. Every line a node prints goes through its Out (out.hpp): fr_net_node's untagged
// stdout, a fleet node's tagged one. Test code: it may allocate.
#pragma once

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "diag.hpp"  // generated fr::cap::Diag: fr.diag.exec on port 241
#include "fr/core/core.hpp"
#include "fr/core/node_net.hpp"
#include "fr/core/port.hpp"
#include "fr/core/worker.hpp"
#include "fr/net/air.hpp"
#include "fr/net/log_source.hpp"
#include "fr/net/net.hpp"
#include "fr/hal/analog.hpp"
#include "fr/ota/ota.hpp"
#include "fr/services/analog_in_service.hpp"
#include "fr/services/button_service.hpp"
#include "protocol.hpp"  // generated fr::proto constants (kAddrUnassigned, Role)
#include "sim/executor.hpp"
#include "sim/medium.hpp"
#include "sim/out.hpp"
#include "sim/sim_core.hpp"

namespace ota_fake {
class MemFlash;
class HttpFetch;
}

namespace frsim {

/** One node: its registry row and how the host runs it (the fleet spec's nodes[], fr_net_node's options). */
struct NodeSpec {
    std::string alias;
    fr::net::Mac mac{};
    uint16_t addr = fr::proto::kAddrUnassigned;
    uint16_t net = 0;
    /** This boot's epoch: the row's epoch_floor first, then +1 at every reboot or power-on. */
    uint16_t epoch = 1;
    /** The registry row's (1 for a fresh one), so the first handshake pushes no set_alias. */
    uint32_t alias_rev = 0;
    /** Net::Config::rng_seed: mix(scenario seed, MAC) in the fleet (0: the MAC alone). */
    uint32_t rng_seed = 0;
    uint32_t hb_ms = 1000;
    /** The OTA health deadline; T2-OTA-30 sets 10 s. */
    uint32_t health_ms = 60'000;
    /** On the fleet's serial bridge: a USB port the hub can open. */
    bool usb = false;
    /** UDP to the hub over the fleet's one shared socket, or a socket of its own (D7). */
    enum class Udp : uint8_t { shared, own } udp = Udp::shared;
    /** Runs the real fr_ota core on a memory flash. */
    bool ota = true;
    /** What its HELLO, descriptor and OTA CHECK say (fr_net_node's defaults). */
    std::string profile = "c6-pad";
    std::string board = "esp32c6-supermini";
    uint8_t chip = 13;
    fr::proto::Role role = fr::proto::Role::node;
    std::array<uint8_t, 8> fw{0x3f, 0x2a, 0x9c, 0x01, 0xb2, 0xd4, 0x00, 0x11};
    std::string version = "0.1.0";
    /** A spare row: started only by `fleet spawn <alias>` (T2-CHURN-30's joins). */
    bool spare = false;
    struct Radio {
        uint8_t channel = 6;
        Rate bcast_rate = Rate::r1m;
        Rate ucast_rate = Rate::r1m;
    } radio;

    // Completed by S2 (D2): what fr_net_node's options added.
    /** TCP and UDP to the hub; false is a serial-only node (a radio-off build, design m2-c1-hil D6). */
    bool ip = true;
    /** The hub's address and node HTTP port, where an OFFER's image is fetched from (fr_ota's endpoint). */
    std::string host = "127.0.0.1";
    uint16_t hub_http = fr::ota::kHttpPort;
    /** A fault build (`--fault health`): fr_ota never sets CAPS. */
    bool fault_health = false;
    /** LOG frames over TCP (design m2-c2 D20): a LogSource attached, so HELLO caps say net_log. */
    bool net_log = false;
    /** M2-C3 (design m2-c3-inputs §8): c3o-analog's fr.analog_in report_hz (07 §7.3's provisional default 20); the
     * fleet's `analog report_hz <n>` sets it and reboots the node into it. */
    uint16_t analog_report_hz = 20;
};

/**
 * A profile the kit can play (design m2-c3-inputs §8): its board and chip id (what HELLO, the descriptor and fr_ota's
 * CHECK say), and its port table. c6-pad: boot (fr.button) 1, status (fr.led) 2. c3o-analog: the same plus analog
 * (fr.analog_in) 3, as c3o-analog.slots.lock has them. fr.diag on 241 is a system port in both, outside the descriptor.
 */
struct KitProfile {
    std::string_view name;
    std::string_view board;
    uint8_t chip;  // the image chip id: C3 5, C6 13
    bool analog;   // fr.analog_in `analog` on port 3
};
/** The kit profile `name`, or null for one the kit cannot play. */
const KitProfile *kit_profile(std::string_view name);
/** The kit's profile names, for an error message ("c6-pad, c3o-analog"). */
std::string kit_profile_names();
/** c3o-analog's fr.analog_in config (its profile: thresholds 16384, 32768, 49152; the cap defaults else), at `report_hz`. */
fr::cap::AnalogInConfig kit_analog_config(uint16_t report_hz);

/** The driver's counters, as `stats espnow` and `state`'s `medium` report them (diag::EspnowStatus). */
struct AirCounters {
    uint32_t tx = 0;  // the Scheduler's sent
    uint32_t tx_fail = 0;
    uint32_t retries = 0;
    uint32_t refused = 0;
    uint32_t rx = 0;
    uint32_t rx_bad = 0;
    uint32_t rx_lost = 0;
    uint32_t peers = 0;
    // `state`'s medium part (fr_net_node's FakeAir): datagrams sent and MAC ACKs answered.
    uint32_t datagrams = 0;
    uint32_t acks = 0;
};

/**
 * What the node's commands and diag hooks do to its links, each host in its own way. udp_block, ip_block,
 * drop_hub_link and loss are Net's own hooks (Net::udp_block ...), the same everywhere, so they are not here.
 */
class NodeLinks
{
public:
    /** `wifi_down <s>` and `net wifi_down <s>`: TCP and UDP away for `s` seconds (0 ends it); ESP-NOW and serial stay. */
    virtual void wifi_down(uint32_t seconds) = 0;
    /** `tcp 0|1`: TCP off and staying off, or back and reconnecting. */
    virtual void tcp_enable(bool on) = 0;
    /** `air_loss <pct>`: the share of received air frames dropped. */
    virtual void air_loss(uint32_t pct) = 0;
    /** False without a radio (counters then all 0). */
    virtual bool air_counters(AirCounters &out) const = 0;

    // Completed by S2.
    /** The Wi-Fi association Device::link_info() reports (wifi_up false while Wi-Fi is down or absent). */
    virtual fr::net::LinkInfo wifi() const = 0;
    /** `usb 0|1`: the serial link's USB host appears or goes away. */
    virtual void serial_host(bool present) = 0;
    /** `hub_mute 0|1`: the hub's serial lines stop reaching the node, the USB host staying. */
    virtual void hub_mute(bool on) = 0;
    /** The board's test pin is wired somewhere (pin_pulse; fr_net_node's --pin-target or --test-pin-tap). */
    virtual bool test_pin_wired() const { return false; }
    /** One pulse of `us` on the test pin. */
    virtual void test_pin_pulse(uint32_t us) { static_cast<void>(us); }

protected:
    ~NodeLinks() = default;
};

/** The board manifest's test_pin (spec 04 §4.3) of the boards a pad plays; -1 for none (the fixture board). */
int board_test_pin(std::string_view board);

/**
 * The analog input of a c3o-analog fleet node (design m2-c3-inputs §8) in place of its ADC channel: a waveform on the
 * core's clock. It is the world outside the node, so the FleetNode keeps it across boots. `wave` is a sine from lo to
 * hi whose phase is drawn from the node's seed (30 nodes are not in step), `ramp` a triangle with the same phase,
 * `hold` a constant (the start: 0 mV). A reading's raw is its mV on a 12-bit scale over full_scale_mv, the C3's
 * 2,500 mV at 12 dB (design D3). No noise: the deadband never has to hide any. Core task only.
 */
class WaveAnalog final : public fr::hal::AnalogSource
{
public:
    enum class Mode : uint8_t { hold, sine, ramp };
    static constexpr uint16_t kFullScaleMv = 2500;
    static constexpr uint32_t kMinPeriodMs = 10;
    static constexpr uint32_t kMaxPeriodMs = 600'000;
    static constexpr uint16_t kMaxMv = 3300;

    WaveAnalog(fr::Core &core, uint32_t seed);

    void hold(uint16_t mv);
    /** A sine or ramp from now on; false (nothing changed) for a period outside 10..600,000 ms, lo > hi or hi > 3,300. */
    bool wave(Mode m, uint32_t period_ms, uint16_t lo_mv, uint16_t hi_mv);
    /** The input at `t`, in mV. */
    uint16_t mv_at(fr::TimeUs t) const;
    Mode mode() const { return mode_; }
    uint32_t period_ms() const { return period_ms_; }
    uint16_t lo_mv() const { return lo_; }
    uint16_t hi_mv() const { return hi_; }
    /** The phase drawn from the seed, in [0, 1) of a period. */
    double phase() const { return phase_; }
    /** Conversions the service asked for, since the node was made. */
    uint32_t reads() const { return reads_; }

    // fr::hal::AnalogSource
    fr::Status init(fr::Core &) override { return {}; }
    fr::Status read(fr::hal::AnalogReading &out) override;
    uint8_t resolution_bits() const override { return 12; }
    uint16_t full_scale_mv() const override { return kFullScaleMv; }
    fr::hal::Selftest selftest() override { return {true, "waveform"}; }

private:
    fr::Core &core_;
    double phase_;
    Mode mode_ = Mode::hold;
    uint32_t period_ms_ = 0;
    uint16_t lo_ = 0;
    uint16_t hi_ = 0;
    fr::TimeUs t0_ = 0;  // the wave's start: its phase counts from here
    uint32_t reads_ = 0;
};

/**
 * Counts the STATE reports of one port on their way to Net (T2-ANALOG-30's delivery share: what the node reported
 * against what an SDK client got), everything else passed through as is.
 */
class CountingSink final : public fr::cap::Sink
{
public:
    explicit CountingSink(fr::cap::Sink &next) : next_(next) {}

    void event(uint8_t port, uint8_t event_id, fr::cap::Priority prio, std::span<const uint8_t> fields, fr::TimeUs at,
               bool ordered) override
    {
        ++events_;
        next_.event(port, event_id, prio, fields, at, ordered);
    }
    void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, fr::TimeUs at) override
    {
        ++states_;
        next_.property(port, prop_id, value, at);
    }
    uint32_t states() const { return states_; }
    uint32_t events() const { return events_; }

private:
    fr::cap::Sink &next_;
    uint32_t states_ = 0;
    uint32_t events_ = 0;
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
    static constexpr fr::TimeUs kNever = INT64_MAX;

    Device(fr::Core &core, const NodeSpec &spec, std::span<fr::PortEntry> ports, Out &out);

    void set_net(fr::net::Net &net) { net_ = &net; }
    fr::net::Net &net() { return *net_; }
    /** Where link_info()'s Wi-Fi part comes from. */
    void set_links(NodeLinks &links) { links_ = &links; }
    std::span<uint8_t> bind_buf() { return bind_buf_; }
    /** The air medium joined: HELLO caps espnow_v2. */
    void set_air(bool on) { air_ = on; }
    void set_ota(fr::ota::Ota &ota, const ota_fake::MemFlash &flash)
    {
        ota_ = &ota;
        flash_ = &flash;
    }
    bool rebooting() const { return reboot_at_ != kNever && core_.now() >= reboot_at_; }
    fr::TimeUs reboot_at() const { return reboot_at_; }
    /** Why the restart: nullptr for fr.node.reboot (its event stays `{"ev":"reboot"}`). */
    const char *reboot_reason() const { return reboot_reason_; }
    NodeCap &node_cap() { return node_cap_; }
    Out &out() { return out_; }

    std::span<const uint8_t> descriptor() const { return {desc_, desc_len_}; }
    /** As fr_core: BYE (after this RESULT, inside a request), then the restart a little later. */
    void reboot(bool bootloader);
    /** fr_ota installed an image: BYE ota, then the restart (fr_core's OtaHost::restart). */
    void reboot_into_ota();
    void store_alias(std::string_view a, uint32_t rev);
    const std::string &alias() const { return alias_; }
    uint32_t alias_rev() const { return alias_rev_; }
    void report_board();
    /** A hub session on serial or TCP now (fr::core::hub_session). */
    bool hub_session() const { return net_ != nullptr && net_->hub_link(); }

    // fr::net::Host
    fr::Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, fr::cap::Reply &reply) override;
    void report_all() override { report_board(); }
    fr::net::HelloInfo hello_info() override;
    fr::net::Identity identity() override;
    fr::net::LinkInfo link_info() override;
    fr::net::Vitals vitals() override;
    void ota_frame(fr::net::LinkKind from, const fr::wire::Header &h, std::span<const uint8_t> body,
                   fr::net::OtaReply &reply) override;
    void msg(uint16_t src, std::string_view topic, std::span<const uint8_t> data) override;

private:
    fr::Core &core_;
    const NodeSpec &spec_;
    std::span<fr::PortEntry> ports_;
    Out &out_;
    NodeCap node_cap_{*this};
    fr::net::Net *net_ = nullptr;
    NodeLinks *links_ = nullptr;
    fr::ota::Ota *ota_ = nullptr;
    const ota_fake::MemFlash *flash_ = nullptr;
    std::string alias_;
    uint32_t alias_rev_ = 0;
    uint8_t desc_[fr::proto::Descriptor::kMaxSize];
    size_t desc_len_ = 0;
    fr::TimeUs reboot_at_ = kNever;
    const char *reboot_reason_ = nullptr;
    uint8_t bind_buf_[fr::core::kBindListMax];
    bool air_ = false;
};

/**
 * fr.diag on port 241 (design c6 §6 S6): the fr.diag.exec lines T-INPUT and T-LAT send over the hub link, with
 * fr_diag's answers: `pin_pulse <us>` (the board's test pin, where NodeLinks wires it), `net` (Net's hooks, `loss`
 * and `wifi_down` included), `stats [section]` and `info`; M2-C2 (D11) adds `inject <inst> <gesture>` and `neighbors
 * [from]` in fr_diag's shapes, M2-C3 (design m2-c3-inputs §5) `inject <inst> value=<n> [hold_ms=<n>]` (an
 * fr.analog_in instance's inject) and `stats`' state_repeats_superseded. fr_diag's serial command channel
 * (`#<id> <line>`) answers the same (serial_line()).
 */
class NodeDiag final : public fr::cap::Diag
{
public:
    NodeDiag(fr::Core &core, const NodeSpec &spec, Out &out);
    NodeDiag(const NodeDiag &) = delete;
    NodeDiag &operator=(const NodeDiag &) = delete;

    /** The node's Net, its links, and its board ports (`inject` finds instances by name). */
    void bind(fr::net::Net &net, NodeLinks &links, std::span<const fr::PortEntry> ports);

    std::expected<fr::cap::DiagExecResult, fr::Err> exec(const fr::cap::DiagExecArgs &args) override;

    /** `net wifi_down`'s delay before the switch: fr_net's WifiSta::kApplyDelayUs (wifi_sta.hpp), so the hook's
     * RESULT leaves first, over TCP too. The stdin `wifi_down` stays immediate, as on fr_net_node. */
    static constexpr fr::TimeUs kWifiApplyDelayUs = 300'000;

    /** fr_diag's `stats` sections, in its order (diag.cpp kStatSections). */
    static constexpr std::string_view kSections[] = {"links", "bcast", "relay", "espnow", "bindings", "nodes", "msgs",
                                                     "net_logs"};

private:
    int info();
    int fail(const char *error, const char *detail);
    int pin_pulse(std::string_view args);
    int net_hook(std::string_view args);
    std::string section(std::string_view name) const;
    int stats(std::string_view args);
    int inject(std::string_view args);
    int neighbors(std::string_view args);
    int put(std::string_view json);

    fr::Core &core_;
    const NodeSpec &spec_;
    Out &out_;
    fr::net::Net *net_ = nullptr;
    NodeLinks *links_ = nullptr;
    std::span<const fr::PortEntry> ports_;
    int test_pin_;
    fr::TimeUs boot_us_;  // the core's clock at this boot: `info` uptime_ms counts from it
    fr::TimeUs low_until_ = 0;
    fr::Timer *wifi_timer_ = nullptr;  // `net wifi_down`'s deferred switch (taken at its first use)
    uint32_t wifi_secs_ = 0;
    char out_buf_[fr::cap::DiagExecResult::kMaxSize];
};

/**
 * The id of a serial command-channel line, `#<1-8 digits> <line>` (fr_diag split_id), or nullopt: any other line
 * is something else (an `@fr1:` envelope, a tool command).
 */
std::optional<std::string_view> serial_diag_id(std::string_view line);
/** `#<id> <line>` answered as fr_diag's serial channel does: `#<id> <json>`, the same answer as fr.diag.exec. */
std::string serial_diag_answer(NodeDiag &diag, std::string_view id, std::string_view line);

class KitLogs;

/**
 * fr_core's OtaHost on this node: Net::send_ota (each frame reported), the hub's HTTP port, BYE ota. With the node's
 * log source set (set_logs), each OTA decision it sends is also fr_core's log_ota line (core.cpp: `ota: ACCEPT <job>
 * (resumed)`, `ota: REJECT`, `ota: RESULT`, `ota: staged|installed`), on the USB line and in LOG frames as on target,
 * so the T-OTA cut's resume evidence (prov-ota-checks.ts node_resumed) has the node's word too.
 */
class NodeOtaHost final : public fr::ota::Host
{
public:
    NodeOtaHost(fr::net::Net &net, Device &dev, const NodeSpec &spec, Out &out) : net_(net), dev_(dev), spec_(spec), out_(out) {}

    /** fr_core's ESP_LOG lines go here (null: none). */
    void set_logs(KitLogs *logs) { logs_ = logs; }

    fr::Status send(uint8_t kind, std::span<const uint8_t> body, bool ack_req) override;
    bool endpoint(fr::ota::Endpoint &out) override;
    void restart() override { dev_.reboot_into_ota(); }

private:
    void log_ota(uint8_t kind, std::span<const uint8_t> body, bool sent);

    fr::net::Net &net_;
    Device &dev_;
    const NodeSpec &spec_;
    Out &out_;
    KitLogs *logs_ = nullptr;
};

/** nvs:fr_dir / nvs:fr_bind as a file (written whole, like an NVS commit), else memory (an empty path). */
class FileBlob final : public fr::core::Blob
{
public:
    explicit FileBlob(std::string path) : path_(std::move(path)) {}

    size_t read(std::span<uint8_t> out) override;
    bool write(std::span<const uint8_t> bytes) override;

private:
    std::string path_;
    std::optional<std::string> mem_;
};

/**
 * A blob in memory that outlives the node using it: a fleet node rebuilt in place at power-on reads back what its
 * last boot wrote, as NVS keeps it. Written on a worker strand, read on the core task: under a mutex.
 */
class MemBlob final : public fr::core::Blob
{
public:
    size_t read(std::span<uint8_t> out) override;
    bool write(std::span<const uint8_t> bytes) override;

private:
    mutable std::mutex mu_;
    std::optional<std::vector<uint8_t>> data_;
};

/**
 * The node's log lines (design m2-c2 D20, host side): the lines the hub and the gates key on, in fr_core's and
 * fr_ota's formats (the `ready id=…` banner at boot, `alive fw=…` every 10 s, `slot … open for … B at …`), plus
 * whatever `log <L> <tag> <text>` says. Each goes out on the node's serial line (where a USB port carries it) and,
 * while Net has it attached (NodeSpec::net_log), into a 4 KB drop-newest ring Net drains as LOG frames over TCP.
 * log() takes any thread: a line from a worker strand is formatted on the core task (one coalesced post).
 */
class KitLogs final : public fr::net::LogSource
{
public:
    /** The ring's budget (fr_serial's second ring, D20), in bytes of text. */
    static constexpr size_t kRingBytes = 4096;
    /** fr_core's alive period. */
    static constexpr uint32_t kAliveMs = 10'000;
    /** LOG.LINE.text's max (schema/protocol.yaml), the serial hook's kLogLine: a longer line is cut. */
    static constexpr size_t kLineMax = 384;
    // The firmware's format strings (sim_log_format_test.cpp checks them against core.cpp and esp_flash.cpp).
    static const char *const kReadyFmt;
    static const char *const kAliveFmt;
    static const char *const kSlotOpenFmt;
    // fr_core's log_ota (core.cpp), tag "fr": ACCEPT (I), REJECT (W), RESULT (I), staged / installed (I).
    static const char *const kOtaAcceptFmt;
    static const char *const kOtaRejectFmt;
    static const char *const kOtaResultFmt;
    static const char *const kOtaPhaseFmt;

    struct Stats {
        uint32_t lines = 0;      // log() calls that made a line
        uint32_t ring_drop = 0;  // lines the full ring refused
        uint32_t cut = 0;        // lines cut to kLineMax for the ring
    };

    /** `serial`: where the node's USB line prints (null: none, or its port is unplugged). */
    using SerialOut = std::function<void(std::string_view line)>;

    KitLogs(fr::Core &core, SerialOut serial);
    KitLogs(const KitLogs &) = delete;
    KitLogs &operator=(const KitLogs &) = delete;

    /** Net drains the ring from now on (HELLO caps net_log). */
    void attach(fr::net::Net &net);
    /** `level` E, W, I, D or V; false for another letter or an empty tag. Any thread. */
    bool log(char level, std::string_view tag, std::string_view text);
    /** The boot banner now and `alive` every 10 s, as fr_core logs them (the core's timer pool must have one). */
    bool start(const NodeSpec &spec, std::span<const uint8_t> running_fw, uint32_t caps, bool radio, const char *slot,
               const char *reset);
    /** The serial line's sink, changed when its port is attached or detached. */
    void set_serial(SerialOut serial) { serial_ = std::move(serial); }
    /**
     * The optional rate generator (`log_rate <lines/s>`): `I (t) fr_gen: gen <n>` lines at that rate, for the LOG
     * drain's published load figures; 0 stops it. Needs one more core timer, taken at the first call.
     */
    bool set_rate(double lines_per_s);
    Stats stats() const;

    // fr::net::LogSource
    bool pop(fr::net::LogLine &line, std::span<char> scratch) override;

private:
    struct Pending {
        char level;
        std::string tag;
        std::string text;
    };
    struct Rec {
        uint8_t level;
        uint32_t pushed_ms;
        std::string tag;
        std::string text;
    };
    void flush_pending();
    void push(char level, std::string_view tag, std::string_view text);

    fr::Core &core_;
    SerialOut serial_;
    fr::net::Net *net_ = nullptr;
    fr::Timer *alive_ = nullptr;
    fr::Timer *gen_ = nullptr;
    uint32_t gen_period_us_ = 0;
    uint32_t gen_n_ = 0;
    std::string alive_fw_;
    std::string id_;
    std::deque<Rec> ring_;
    size_t ring_bytes_ = 0;
    Stats stats_;
    Stats told_;     // what pop() last reported to Net (logs_dropped), as fr_core's SerialLogs does
    std::mutex mu_;  // pending_ and posted_: log() from a worker strand
    std::vector<Pending> pending_;
    bool posted_ = false;
};

/** One node's state as the shared code sees it; owned by the host (fr_net_node's main, a FleetNode). */
struct NodeCtx {
    const NodeSpec &spec;
    fr::Core &core;
    fr::net::Net &net;
    NodeLinks &links;
    Out &out;
    Device &device;
    NodeDiag &diag;
    /** Null when the node runs no OTA. */
    fr::ota::Ota *ota = nullptr;
    /** The boot button `inject` presses; null without one (the virtual fixture). */
    fr::ButtonService *button = nullptr;
    /** `log <L> <tag> <text>`; null without a log source. */
    KitLogs *logs = nullptr;
    /** M2-C3: a c3o-analog node's input, its service and the STATEs that service reported this boot; null without. */
    WaveAnalog *wave = nullptr;
    fr::AnalogInService *analog = nullptr;
    const CountingSink *analog_sink = nullptr;
};

// ---- the fleet (design m2-c2 D1, D7, D8) ----

/** Where the fleet's lines go: its stdout or a control connection, buffered so a slow reader never stalls the loop.
 * Any thread. */
class LineSink
{
public:
    virtual void write_line(std::string_view line) = 0;

protected:
    ~LineSink() = default;
};

/**
 * A fleet node's Out (D2, D8): each line tagged `"node":"<alias>"`. While the node answers a control command, the
 * lines it prints on the loop thread go into the answer instead (capture); other lines reach the fleet's events at
 * verbosity 1 and up, per-frame lines (Out::frames) at 2 and up. At the default 0 nothing but answers is printed.
 */
class NodeOut final : public Out
{
public:
    NodeOut(std::string alias, LineSink &events, const std::atomic<int> &verbosity)
        : alias_(std::move(alias)), events_(events), verbosity_(verbosity)
    {
    }

    void line(std::string_view text) override;
    bool frames() const override { return verbosity_.load(std::memory_order_relaxed) >= 2; }

    /** This thread's lines are the answer's until end_capture(). */
    void begin_capture();
    std::vector<std::string> end_capture();
    /** `{"x":...}` as `{"node":"<alias>","x":...}`. */
    std::string tagged(std::string_view json) const;

private:
    std::string alias_;
    LineSink &events_;
    const std::atomic<int> &verbosity_;
    std::mutex mu_;
    bool capturing_ = false;
    std::thread::id capture_thread_;
    std::vector<std::string> captured_;
};

/** The wall mode's threads for blocking OTA downloads (D1): 16, ota_deploy's highest max_parallel. */
class WorkerPool
{
public:
    explicit WorkerPool(size_t threads = 16);
    ~WorkerPool();
    WorkerPool(const WorkerPool &) = delete;
    WorkerPool &operator=(const WorkerPool &) = delete;

    /** Runs `fn` on some pool thread. */
    void submit(std::function<void()> fn);
    size_t threads() const { return threads_.size(); }

private:
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<std::function<void()>> jobs_;
    bool stop_ = false;
    std::vector<std::thread> threads_;
};

/**
 * One node's fr_worker (D1): its jobs run in post order, one at a time, as on the single fr_worker task, because
 * fr_ota relies on that (step(), mark_valid, rollback, commit and store->clear on one FIFO; MemFlash and MemStore
 * would race otherwise). In wall time the strand runs on the shared pool, so a GET blocked in a read stalls only its
 * own node; in virtual time each job is an executor event on the loop (HostWorker's one job per round). Core-bound
 * work goes back through SimCore::post (thread-safe). quiesce() is the power cut's half (D8): later posts are taken
 * and dropped, queued jobs are dropped, and the call returns once the job in flight has.
 */
class Strand final : public fr::Worker
{
public:
    struct Stats {
        uint32_t run = 0;
        uint32_t dropped = 0;  // queued when the node lost power, or posted while it was off
        uint32_t refused = 0;  // fr::worker::kQueueDepth jobs already queued
    };

    /** `pool` null: virtual time (jobs run on the executor's loop). */
    Strand(Executor &exec, WorkerPool *pool);
    ~Strand();
    Strand(const Strand &) = delete;
    Strand &operator=(const Strand &) = delete;

    bool post(fr::Callback<void(), 32> job) override;
    /** Drops what is queued, takes and drops every later post, and waits for the job in flight to return. */
    void quiesce();
    /** The node rebuilt: posts run again. */
    void resume();
    bool idle() const;
    Stats stats() const;

private:
    void run_next();
    void kick();

    Executor &exec_;
    WorkerPool *pool_;
    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::deque<fr::Callback<void(), 32>> jobs_;
    bool running_ = false;    // a job is in flight (or a pool run is scheduled)
    bool dropping_ = false;   // quiesced
    EventId event_ = 0;       // virtual time: the next job's event
    Stats stats_;
};

/** The spec's `medium` (SimMediumSchema): the pair table's layout and the medium's own knobs. */
struct MediumSpec {
    Topology topology = Topology::one_room;
    int8_t rssi_min_dbm = -85;
    int8_t rssi_max_dbm = -45;
    double asymmetry_db = 3;
    double rssi_sigma_db = 0;
    double loss_min = 0.001;
    double loss_max = 0.015;
    double dup = 0;
    uint32_t latency_min_us = 50;
    uint32_t latency_max_us = 200;
    Rate bcast_rate = Rate::r1m;
    Rate ucast_rate = Rate::r1m;
    bool collisions = true;
    double capture_db = 10;
    std::optional<double> cross_reach;
    struct PairSpec {
        std::string tx;
        std::string rx;
        double loss = 0;
        int8_t rssi_dbm = -60;
    };
    std::vector<PairSpec> pairs;
    std::vector<std::pair<std::string, std::array<double, 2>>> positions;
    double p0_dbm = -40;
    double path_n = 2.7;
};

/** `fr_fleet --spec <file>`: fractonica/fleet-spec@1 (FleetSpecSchema, packages/protocol/src/sim.ts). */
struct FleetSpec {
    uint32_t seed = 1;
    double pace = 1;
    int verbosity = 0;
    std::string state_dir;
    MediumSpec medium;
    struct Ap {
        uint8_t channel = 6;
        int8_t rssi_min_dbm = -75;
        int8_t rssi_max_dbm = -45;
        double uplink_min_ms = 0.5;
        double uplink_max_ms = 3;
        double downlink_min_ms = 0.5;
        double downlink_max_ms = 3;
        double udp_loss = 0;
        std::optional<std::pair<double, uint32_t>> gaps;  // every_s, len_ms
        double phy_rate = 24;
        double http_kbps = 0;  // each node's OTA download pace (wall time); 0: unpaced
        uint32_t assoc_min_ms = 1000;
        uint32_t assoc_max_ms = 3000;
    } ap;
    std::vector<NodeSpec> nodes;
};

/** Parses a spec file's JSON (cJSON); false with `error` set when it is not one. Defaults as the zod schema's. */
bool parse_fleet_spec(std::string_view json, FleetSpec &out, std::string &error);

class Ap;
class Bridge;
class SimAir;
class SimSerial;
class SimTcp;
class SimUdp;
class UdpSocket;
struct TcpTiming;

/** What every fleet node shares: the loop, the air, the AP, the bridge, UDP, the strands' pool and the output. */
struct FleetShared {
    Executor &exec;
    Medium &medium;
    Ap &ap;
    Bridge *bridge = nullptr;  // null: no USB nodes (host tests)
    UdpSocket &udp;
    WorkerPool *pool = nullptr;  // null: virtual time
    LineSink &events;
    const std::atomic<int> &verbosity;
    const TcpTiming &tcp;
    /** The fleet's own generators' pace (`fleet pace <x>`): a node's `log_rate` is scaled by it; null: 1. */
    const std::atomic<double> *pace = nullptr;
    /** Each envelope's arrival at a node over TCP or serial, as read (the fleet's arrival skew, D16); may be empty. */
    std::function<void(const NodeSpec &node, std::span<const uint8_t> env, fr::TimeUs at)> arrival;
};

/**
 * One node of the fleet (D1, D7, D8): its spec (behind the fleet's unique_ptr), core, radio, links and output, which
 * live as long as the fleet; and its boot, the node classes of this kit around a Net and an fr_ota core, rebuilt in
 * place at every power-on and reboot from what its state directory keeps (epoch.txt, the flash and nvs:fr_ota of
 * tools/ota_fake.hpp, nvs:fr_dir and nvs:fr_bind), as fr_net_node rebuilds across processes. power_off() is
 * crash(): no BYE, the hub's TCP socket left silent and reset at +8 s, the USB port unplugged; before anything of the
 * boot is destroyed the GET in flight is shut down, the strand quiesced, the core crashed (its posts and timers
 * dropped, its generation bumped) and the radio's queue and deliveries dropped. What is RAM on a board goes with it
 * (`wifi_down`, `tcp 0`, Net's TCP hold and backoff), so power-on is a fresh boot; and it cancels a reboot under way,
 * so an explicit power cut in the reboot gap keeps the node off. M2-C3 (design m2-c3-inputs §8): the boot builds the
 * services and the port table of the spec's kit profile (kit_profile; the descriptor follows the table), and a
 * c3o-analog node's WaveAnalog outlives its boots as the world outside a board does.
 */
class FleetNode
{
public:
    /** The answer to one control command: `ok`, and JSON members after it (`,"state":{...}`). */
    struct Answer {
        bool ok = false;
        std::string fields;
    };

    FleetNode(FleetShared &shared, std::unique_ptr<NodeSpec> spec, std::string state_dir);
    ~FleetNode();
    FleetNode(const FleetNode &) = delete;
    FleetNode &operator=(const FleetNode &) = delete;

    const NodeSpec &spec() const { return *spec_; }
    /** The hub's address (`fleet start`): its node TCP, UDP and HTTP ports. */
    void set_hub(const std::string &host, uint16_t tcp, uint16_t udp, uint16_t http);
    bool powered() const { return boot_ != nullptr; }
    /** This boot's descriptor (empty while off): its port table's, as describe answers it. */
    std::span<const uint8_t> descriptor() const;
    /** Started at least once (`fleet start` or `spawn`). */
    bool started() const { return started_; }
    void power_on();
    void power_off();
    /** `usb attach|detach`: the bridge port plugged in or out (a USB node only). */
    bool usb(bool attach);
    /** `ap off|on` reached this node. */
    void ap_changed(bool up);
    /**
     * One control command for this node (Commands' table, plus diag, power, usb, and on a c3o-analog node
     * `analog report_hz <1-200>`: the rate for the next boot, then a BYE reboot into it).
     */
    Answer command(std::string_view line);

    SimCore &core() { return *core_; }
    SimAir &air() { return *air_; }
    const SimTcp &tcp() const { return *tcp_; }
    NodeOut &out() { return out_; }
    /** A hub session over TCP / serial now (for the fleet's counters). */
    bool tcp_session() const;
    bool serial_session() const;
    uint32_t boots() const { return boots_; }

private:
    struct Boot;
    class Links;

    void boot();
    void tick();
    void update_ip(bool associate);
    void set_ip(bool up);
    void restart(const char *reason, bool bye);

    FleetShared &shared_;
    std::unique_ptr<NodeSpec> spec_;
    std::string dir_;
    std::string mac_hex_;
    NodeOut out_;
    std::unique_ptr<SimCore> core_;
    std::unique_ptr<Strand> strand_;
    std::unique_ptr<SimAir> air_;
    std::unique_ptr<SimTcp> tcp_;
    std::unique_ptr<SimUdp> udp_;
    std::unique_ptr<SimSerial> serial_;
    std::unique_ptr<WaveAnalog> wave_;  // a c3o-analog node's input (across boots); null on another profile
    std::unique_ptr<Links> links_;
    std::unique_ptr<Boot> boot_;
    bool started_ = false;
    bool usb_plugged_ = true;  // `usb detach` unplugs it until `usb attach`
    bool ip_ = false;
    bool wifi_off_ = false;  // `wifi_down` in force
    bool tcp_off_ = false;   // `tcp 0`
    bool associating_ = false;
    uint64_t assoc_draws_ = 0;
    EventId assoc_event_ = 0;
    EventId wifi_event_ = 0;
    EventId tick_event_ = 0;
    EventId restart_event_ = 0;
    uint32_t boots_ = 0;
    bool net_up_ = false;  // NET health set this boot
    bool udp_ok_ = false;
    std::vector<std::pair<RadioId, double>> loss_saved_;  // `air_loss`: the pairs' own loss, to restore
};

}  // namespace frsim
