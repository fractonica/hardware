// The node's hub link (design c3 §3, spec 05 §5.8-5.12): sessions on the serial and TCP links (UDP rides
// the TCP session), HELLO until WELCOME, hub-frame windows and the response cache, Q1 retries on UDP, the
// udp_ok probe, heartbeats and presence, TIME answers, event max age and BYE. IDF-free: it lives on the
// core task and sees the node only through fr::Core (clock, timers, posting) and net::Host (dispatch and
// identity), so the host suite tests every rule with FakeLink and FakeCore.
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <span>
#include <string_view>

#include "fr/base.hpp"
#include "fr/cap/capability.hpp"
#include "fr/core/core.hpp"
#include "fr/net/link.hpp"
#include "fr/net/window.hpp"
#include "protocol.hpp"  // generated fr::proto enums (Role, OtaState)

namespace fr::net {

// PRESENCE.HELLO `caps` bits (05 §5.7).
inline constexpr uint32_t kCapEspnowV2 = 1u << 0;
inline constexpr uint32_t kCapWifi = 1u << 1;
inline constexpr uint32_t kCapSleepy = 1u << 2;
inline constexpr uint32_t kCapSec = 1u << 3;
inline constexpr uint32_t kCapInjectEnabled = 1u << 4;
inline constexpr uint32_t kCapProvisioned = 1u << 5;

// PRESENCE.HEARTBEAT `state` bits (05 §5.7).
inline constexpr uint32_t kStateWifiUp = 1u << 0;
inline constexpr uint32_t kStateHubLink = 1u << 1;
inline constexpr uint32_t kStateOtaBusy = 1u << 2;
inline constexpr uint32_t kStateTimeSynced = 1u << 3;
inline constexpr uint32_t kStateLowBatt = 1u << 4;
inline constexpr uint32_t kStateSwept = 1u << 5;

// PRESENCE.BYE reasons (05 §5.11).
inline constexpr uint8_t kByeShutdown = 0;
inline constexpr uint8_t kByeReboot = 1;
inline constexpr uint8_t kByeOta = 2;
inline constexpr uint8_t kByeSleep = 3;
inline constexpr uint8_t kByeMaintenance = 4;

/** Every PRESENCE.HELLO field except alias, alias_rev, channel and bssid, which Net reads live. */
struct HelloInfo {
    std::array<uint8_t, 6> mac{};  // factory MAC (device_id)
    uint8_t chip = 0;              // image chip id: C3 5, S3 9, C6 13
    uint16_t chip_rev = 0;
    std::array<uint8_t, 8> fw_id_prefix{};
    uint32_t descriptor_hash = 0;  // fr::wire::descriptor_hash over what fr.node.describe returns
    uint32_t board_hash = 0;       // fr::wire::board_hash(board id)
    fr::proto::Role role = fr::proto::Role::node;
    uint32_t caps = 0;            // kCap* bits
    uint32_t hb_interval_ms = 0;  // informational: HELLO carries Config::heartbeat_ms, the cadence Net keeps
    uint8_t reset_reason = 0;     // esp_reset_reason_t; also the fr.node.boot field Net sends
    fr::proto::OtaState ota_state = fr::proto::OtaState::undefined;
};

/** Who this node is on the network, as fr_id resolves it (fr_ident, fr_ovr) at the time of asking. */
struct Identity {
    static constexpr size_t kAliasMax = 31;

    uint16_t addr = fr::proto::kAddrUnassigned;  // 0xFFFE while unprovisioned
    uint16_t net = 0;
    char alias[kAliasMax + 1] = {};  // NUL-terminated
    uint32_t alias_rev = 0;
    uint16_t epoch = 0;  // this boot's epoch (05 §5.5)

    /** Up to the NUL, or all 31 + 1 bytes if a host forgot it. */
    std::string_view alias_view() const
    {
        return std::string_view(alias, static_cast<size_t>(std::find(alias, std::end(alias), '\0') - alias));
    }
};

/** The Wi-Fi association, for HELLO (channel, bssid) and HEARTBEAT (rssi_ap, the wifi_up and swept bits). */
struct LinkInfo {
    bool wifi_up = false;
    uint8_t channel = 0;             // 0: not associated
    std::array<uint8_t, 6> bssid{};  // all zero: not associated
    int8_t rssi = 0;
    uint32_t sweeps = 0;  // all-channel sweeps this boot (05 §5.4): a new one sets the next HEARTBEAT's swept bit
};

/** Node-side HEARTBEAT values Net cannot see from the core task's own state. */
struct Vitals {
    uint32_t free_heap_kb = 0;
    uint32_t vbat_mv = 0;  // 0: not measured
    bool ota_busy = false;
    bool low_batt = false;
};

/**
 * The node's answer to an OTA-class request from the hub (05 §5.7, design c4 §3): an OFFER is answered by
 * an ACCEPT or REJECT frame, which is its acknowledgement (05 §5.8), not by a RESULT. Host::ota_frame fills
 * it; Net sends it from port 240 to the hub over TCP or serial and keeps it for a DUP of the request.
 */
class OtaReply
{
public:
    /** ACCEPT/REJECT are `{job_id <= 23, code}` (<= 28 B); room for a STATUS as well. */
    static constexpr size_t kCapacity = 48;

    /** Answers with an OTA frame of `kind` carrying `body`; false, and no answer, when it does not fit. */
    bool set(uint8_t kind, std::span<const uint8_t> body)
    {
        if (body.size() > kCapacity) {
            return false;
        }
        std::copy(body.begin(), body.end(), buf_);
        kind_ = kind;
        len_ = static_cast<uint8_t>(body.size());
        set_ = true;
        return true;
    }
    bool has() const { return set_; }
    uint8_t kind() const { return kind_; }
    std::span<const uint8_t> body() const { return {buf_, len_}; }

private:
    bool set_ = false;
    uint8_t kind_ = 0;
    uint8_t len_ = 0;
    uint8_t buf_[kCapacity] = {};
};

/** What Net needs from the node; implemented by fr_core. Called on the core task. */
class Host
{
public:
    /** A CMD for `port` (0 node, 241 diag, else a board instance); RESULT fields go to `reply`, whose
     * buffer Net sizes by the link the request came on (cap::Reply realtime or bulk). It may call back
     * into Net: emissions go out ahead of the RESULT, bye() and the debug hooks take effect after it. */
    virtual Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, cap::Reply &reply) = 0;
    /** fr.node.get_state: every capability re-reports its properties (fresh LATEST seqs). Net itself does
     * not call it: get_state arrives as a port-0 CMD through dispatch(). */
    virtual void report_all() = 0;
    virtual HelloInfo hello_info() = 0;
    virtual Identity identity() = 0;
    virtual LinkInfo link_info() = 0;
    virtual Vitals vitals() = 0;
    /**
     * A fresh OTA-class frame from the hub, unicast on port 240 (OFFER, COMMIT, ABORT; design c4 §3), from
     * a TCP or serial session (the hub never sends UDP). `h` is its header (ACK_REQ on an OFFER). The host
     * answers at once through `reply` (a REJECT decided from the OFFER alone), or leaves it empty and
     * answers later with Net::send_ota (an ACCEPT or REJECT once the image's first bytes are read). A
     * duplicate request never comes here: Net answers it from its response cache, or drops it. A bye()
     * asked for in here follows the reply.
     */
    virtual void ota_frame(LinkKind from, const fr::wire::Header &h, std::span<const uint8_t> body, OtaReply &reply) = 0;

protected:
    ~Host() = default;
};

/** Defaults are the Kconfig defaults of design c3 §6 (spec 05 §5.17); fr_core fills it from sdkconfig. */
struct Config {
    uint32_t heartbeat_ms = 1000;      // FR_HEARTBEAT_MS (sent +-10 %)
    uint8_t offline_x10 = 35;          // FR_OFFLINE_X10: hub lost after 3.5 intervals with nothing from it
    uint32_t offline_min_ms = 750;     // FR_OFFLINE_MIN_MS
    uint32_t ack_base_ms = 20;         // FR_ACK_BASE_MS: first Q1 retry on UDP, then x2 backoff +-25 %
    uint8_t max_attempts = 4;          // FR_MAX_ATTEMPTS: UDP sends of one Q1 frame, the first included
    uint32_t event_max_age_ms = 1000;  // FR_EVENT_MAX_AGE_MS: older Q1 EVENTs are dropped at send time
    uint32_t tcp_delivery_ms = 2000;   // FR_TCP_DELIVERY_MS: a Q1 frame on TCP/serial unACKed this long failed
    uint32_t hello_retry_ms = 1000;    // HELLO on an up link until WELCOME
    uint8_t ttl_default = 2;           // FR_TTL_DEFAULT
    /** Seeds the jitter RNG (heartbeat +-10 %, retry +-25 %); 0 derives it from the MAC at the first
     * HELLO, so nodes powered up together do not heartbeat in lockstep. Tests fix it. */
    uint32_t rng_seed = 0;
};

/** Per link kind (State::links is indexed by LinkKind). */
struct LinkState {
    bool attached = false;
    bool up = false;           // Link::up() as of the last link_changed()
    bool session = false;      // WELCOMEd on this link (serial, tcp; udp rides tcp's)
    bool udp_ok = false;       // udp: a hub echo of a UDP HEARTBEAT arrived within 3 intervals
    bool time_synced = false;  // a TIME/SYNC_REQ was answered on this link's session
    uint32_t tx = 0;           // envelopes Link::send accepted
    uint32_t tx_fail = 0;      // Link::send refused (queue full, down)
    uint32_t rx = 0;           // envelopes received
    uint32_t rx_drop = 0;      // undecodable, DUP/OLD, outside a session, or not for this node
    uint32_t retries = 0;      // Q1 re-sends
};

struct State {
    std::array<LinkState, kLinkKinds> links{};
    uint16_t hub_epoch = 0;        // from the last WELCOME
    uint32_t state_seq = 0;        // seq of the newest STATE meant for the hub (HEARTBEAT state_seq)
    uint32_t events_dropped = 0;   // no path to the hub, or older than event_max_age_ms
    uint32_t delivery_failed = 0;  // Q1 frames given up on
    uint32_t cmds = 0;             // CMDs handed to Host::dispatch
    uint32_t cmds_refused = 0;     // CMDs answered without dispatch: expired, exec_at, broadcast off port 0
    uint32_t dup = 0;              // hub frames already seen (answered from the cache when cached)
    uint32_t old = 0;              // hub frames below the window, stale LATEST, or from another hub run
    uint32_t cached_replies = 0;   // DUP requests answered from the response cache
    uint32_t sessions_lost = 0;    // sessions ended by timeout, link loss or a hub BYE
    uint32_t sessions_timed_out = 0;  // of those: 3.5 intervals with nothing from the hub (05 §5.11)
    uint32_t hook_drops = 0;       // envelopes the debug hooks swallowed, both ways
    bool hub_link_dropped = false;  // drop_hub_link() active
    bool udp_blocked = false;       // udp_block() active
    bool ip_blocked = false;        // ip_block() active

    const LinkState &link(LinkKind k) const { return links[index_of(k)]; }
    bool hub_link() const { return link(LinkKind::serial).session || link(LinkKind::tcp).session; }
    bool time_synced() const { return link(LinkKind::serial).time_synced || link(LinkKind::tcp).time_synced; }
};

/** Lives on the core task: every method, and the links' receive path, runs there. */
class Net final : public cap::Sink
{
public:
    /** Node windows on the hub's spaces (05 §5.17 FR_WINDOW_BITS_NODE). */
    static constexpr size_t kWindowBits = 128;
    /** Responses kept for DUP requests (05 §5.8), keyed (src, epoch, req_seq). */
    static constexpr size_t kCacheEntries = 8;
    /** Q1 frames awaiting the hub's ACK, and STATE second copies, at once. */
    static constexpr size_t kOutboxEntries = 8;
    /** Hub LATEST (port, kind) pairs tracked. */
    static constexpr size_t kLatestPairs = 8;
    /** Delay of an on-change STATE's second copy (05 §5.8 "Double send"). */
    static constexpr uint32_t kStateRepeatMs = 20;
    /** udp_ok lasts this many heartbeat intervals after an echo (05 §5.10). */
    static constexpr uint32_t kUdpOkIntervals = 3;
    /** A USB node whose TCP session heard nothing from the hub for more than this many tenths of an interval
     * sends over serial instead, as the hub does to it (05 §5.10; the hub's wifiSilentX10). */
    static constexpr uint32_t kWifiSilentX10 = 20;

    /** Stores the configuration only; the timer is taken at the first attach(). */
    Net(Core &core, Host &host, const Config &cfg);
    Net(const Net &) = delete;
    Net &operator=(const Net &) = delete;

    /** Up to one link per kind; a second link of a kind replaces the first. The first call takes Net's
     * one timer from the Core pool, so attach before fr::board::init drains it. An up serial or TCP link
     * gets its HELLO from the timer, i.e. once the core task runs. */
    void attach(Link &link);
    /** A link went up or down. */
    void link_changed(LinkKind kind);
    /** An envelope from a link; the caller already copied it off the transport. */
    void receive(LinkKind from, std::span<const uint8_t> envelope);
    /** BYE on every session, best effort (reboot, ota, sleep), and the sessions end; HELLO resumes after
     * hello_retry_ms if the node lives on. Called inside a request, the BYE follows that request's
     * RESULT, both on the link the request came on (the hub orders frames per link only). */
    void bye(uint8_t reason);
    State state() const;
    /** `diag stats reset`: zeroes the counters (not the flags, hub_epoch or state_seq). */
    void reset_stats();
    /**
     * An OTA-class frame from port 240 to the hub (design c4 §3): STATUS, RESULT, or an ACCEPT/REJECT
     * answering an OFFER after ota_frame() returned. It goes over the TCP session, else the serial one
     * (also while TCP is silent, kWifiSilentX10), never UDP. `ack_req`: a Q1 frame the hub ACKs; one not ACKed within tcp_delivery_ms counts in
     * delivery_failed (TCP and serial are not retried, 05 §5.8). Fails with busy without a hub session
     * (the caller sends it again after the next WELCOME) or when the link refuses it; invalid_args when
     * the frame exceeds the realtime MTU.
     */
    Status send_ota(uint8_t kind, std::span<const uint8_t> body, bool ack_req = false);

    // Debug hooks (09 §9.7) for fr_diag's `net` commands, which only FR_TEST_HOOKS builds expose. They
    // start after the RESULT of the request that asked for them; 0 seconds ends the hook at once.
    /** `net drop_hub_link <s>`: no envelopes on any link, either way, for `s` seconds, and no session
     * timeouts, HELLOs or reconnects meanwhile (T-FLOOD). */
    void drop_hub_link(uint32_t seconds);
    /** `net udp_block <s>`: nothing goes out over UDP for `s` seconds, as behind a firewall: the udp_ok
     * probe has to notice (T-PRES). */
    void udp_block(uint32_t seconds);
    /** `net ip_block <s>`: Wi-Fi that degrades without dropping: no envelopes on TCP or UDP, either way,
     * for `s` seconds, while the TCP session stays up here (no timeout, HELLO or reconnect on it until the
     * hook ends, which then times it out if it went silent too long). Serial carries on as usual, so a USB
     * node stays online at the hub through the heartbeats on its serial session. */
    void ip_block(uint32_t seconds);

    // cap::Sink: capability emissions become EVENT/STATE envelopes to the hub.
    void event(uint8_t port, uint8_t event_id, cap::Priority prio, std::span<const uint8_t> fields,
               TimeUs at) override;
    void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, TimeUs at) override;

private:
    static constexpr TimeUs kNever = INT64_MAX;
    static constexpr uint8_t kViaSerial = 1u << index_of(LinkKind::serial);
    static constexpr uint8_t kViaTcp = 1u << index_of(LinkKind::tcp);
    static constexpr uint8_t kViaUdp = 1u << index_of(LinkKind::udp);
    static constexpr size_t kRtSize = fr::proto::kMtuRealtime;
    static constexpr size_t kBulkSize = fr::proto::kMtuBulk;

    /** Per serial/tcp link: what the session needs beyond the public LinkState. */
    struct Session {
        TimeUs hello_due = kNever;  // next HELLO while up without a session
        TimeUs last_rx = 0;         // last hub frame on this link (05 §5.11 keepalive)
    };

    /** A Q1 frame awaiting the hub's ACK, or an on-change STATE's second copy (`repeat`). */
    struct Pending {
        bool used = false;
        bool repeat = false;
        bool exempt = false;  // node.boot: no age limit
        uint8_t via = 0;      // kVia* bits the first send went over
        uint8_t attempts = 0;  // UDP sends so far
        uint32_t seq = 0;
        TimeUs at = 0;  // when the event happened (age)
        TimeUs sent = 0;
        TimeUs retry_at = kNever;  // next UDP re-send, or the repeat
        TimeUs deadline = kNever;  // give up waiting for the ACK (TCP/serial copies)
        uint16_t len = 0;
        uint8_t bytes[kRtSize];
    };

    /** One response for DUP requests; `bulk` ones live in bulk_cache_ (one at a time). */
    struct Cached {
        bool used = false;
        bool bulk = false;
        uint16_t src = 0;
        uint16_t epoch = 0;
        uint32_t req_seq = 0;
        uint32_t stamp = 0;
        uint16_t len = 0;
        uint8_t bytes[kRtSize];
    };

    Link *link(LinkKind k) const { return links_[index_of(k)]; }
    LinkState &ls(LinkKind k) { return state_.links[index_of(k)]; }
    const LinkState &ls(LinkKind k) const { return state_.links[index_of(k)]; }
    Session &sess(LinkKind k) { return sessions_[index_of(k)]; }

    // Receive side.
    void handle(LinkKind from, std::span<const uint8_t> envelope);
    void on_welcome(LinkKind from, std::span<const uint8_t> body);
    void on_presence(LinkKind from, uint8_t kind, std::span<const uint8_t> body, bool unicast);
    void on_ack(uint8_t kind, uint16_t req_epoch, uint32_t req_seq);
    void on_cmd(const fr::wire::EnvelopeView &e, bool unicast, LinkKind from);
    void on_ota(const fr::wire::EnvelopeView &e, bool unicast, LinkKind from);
    void on_sync_req(LinkKind from, std::span<const uint8_t> body);
    void send_ack(const fr::wire::Header &h);
    /** A DUP request's cached answer, again, on the path an answer to a request from `from` takes. */
    bool resend_cached(uint16_t src, uint16_t epoch, uint32_t req_seq, LinkKind from);
    void cache(uint16_t src, uint16_t epoch, uint32_t req_seq, std::span<const uint8_t> envelope);

    // Sessions and timing.
    void send_hello(LinkKind k);
    void send_heartbeat();
    /** Ends a session: its Q1 frames fail, heartbeats stop with the last session. */
    void end_session(LinkKind k, bool lost);
    /** The presence frames (HEARTBEAT, PONG) go on every live session, not only the one route() prefers:
     * TCP/UDP as wifi_route() picks (even while TCP is silent: that copy tells the hub Wi-Fi carries again)
     * plus serial. The hub refreshes a node on any of its links, so a USB node whose TCP path loses frames
     * stays online over serial; the copies are the same bytes, deduplicated by the hub's window. */
    uint8_t every_session(uint8_t cls, uint8_t kind, size_t len) const;
    /** Timeout or hub BYE: end_session, then Link::drop() and HELLO again (TCP after reconnecting). */
    void lose_session(LinkKind k, DropReason why);
    /** On every session in `via` (kVia* bits; 0: every session). */
    void send_bye(uint8_t reason, uint8_t via);
    void end_sessions_after_bye();
    TimeUs session_timeout_us() const;
    /** udp_ok off; if it was on with a TCP session, Q1 frames sent over UDP alone get their TCP copy and a
     * heartbeat goes at once over TCP and UDP (05 §5.10, design c3 §3). */
    void clear_udp_ok();
    /** Link::hold() as the hooks want it: every link during drop_hub_link, TCP and UDP during ip_block. */
    void update_holds();
    void tick();
    void arm();
    void run_deferred();
    void start_drop(uint32_t seconds);
    void start_udp_block(uint32_t seconds);
    void start_ip_block(uint32_t seconds);
    void end_drop();
    void end_ip_block();
    /** Session timeouts resume after a hook: a session in `which` (kVia* bits) silent too long ends now. */
    void lose_stale_sessions(uint8_t which);
    bool dropping() const { return state_.hub_link_dropped; }
    /** A hook freezes link `k`: nothing in or out, and on a session link no timeout, HELLO or reconnect. */
    bool frozen(LinkKind k) const { return dropping() || (state_.ip_blocked && k != LinkKind::serial); }

    // Send side.
    /** kVia* bits a frame to the hub takes (05 §5.10): TCP/UDP with a TCP session, unless it is silent and
     * there is a serial session; else serial; 0 without a session (or during drop_hub_link). */
    uint8_t route(uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const;
    /** route() for an answer to a request that came from `from`: one from serial is answered on serial. */
    uint8_t answer_route(LinkKind from, uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const;
    /** The TCP/UDP choice of route() for a node with a TCP session. */
    uint8_t wifi_route(uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const;
    /** Nothing from the hub over the TCP session for more than kWifiSilentX10 / 10 intervals. */
    bool wifi_silent() const;
    std::span<const uint8_t> build(uint8_t flags, uint8_t cls, uint8_t kind, uint32_t seq, uint16_t dst, uint8_t port,
                                   std::span<const uint8_t> prefix, std::span<const uint8_t> body);
    /** Sends over every link in `via` (kVia* bits); returns the links it took, a TCP fallback included. */
    uint8_t transmit(uint8_t via, std::span<const uint8_t> envelope);
    bool transmit_on(LinkKind k, std::span<const uint8_t> envelope);
    void send_event(uint8_t port, uint8_t event_id, cap::Priority prio, std::span<const uint8_t> fields, TimeUs at,
                    bool exempt);
    void track(std::span<const uint8_t> envelope, uint32_t seq, uint8_t via, TimeUs at, bool exempt);
    void schedule_repeat(std::span<const uint8_t> envelope);
    void fail_pending(uint8_t via);
    void service_pending(Pending &p, TimeUs now);
    Pending *take_slot(bool evict);
    size_t pending_count() const;

    // Jitter: xorshift32 (deterministic per seed).
    uint32_t next_random();
    /** `ms` +- `pct` percent, uniformly, in microseconds. */
    uint32_t jittered_us(uint32_t ms, uint32_t pct);
    uint32_t backoff_us(uint8_t attempt);

    Core &core_;
    Host &host_;
    Config cfg_;
    Timer *timer_ = nullptr;
    TimeUs armed_for_ = kNever;  // the deadline timer_ runs for
    std::array<Link *, kLinkKinds> links_{};
    State state_;
    std::array<Session, kLinkKinds> sessions_{};

    // Origin of everything this node sends, refreshed from Host::identity() at every HELLO.
    uint16_t net_ = 0;
    uint16_t addr_ = fr::proto::kAddrUnassigned;
    uint16_t epoch_ = 0;
    uint8_t ttl_ = 0x22;

    // Per-boot sequence spaces (05 §5.8): ordinary and LATEST, both from 1.
    uint32_t seq_ = 0;
    uint32_t latest_seq_ = 0;

    // Hub frames: windows on (0x0000, UNICAST) and (0x0000, BCAST) and LATEST last_seq, for hub_epoch.
    ReplayWindow<kWindowBits> ucast_;
    ReplayWindow<kWindowBits> bcast_;
    LatestFilter<kLatestPairs> latest_;

    // Heartbeats and the udp_ok probe.
    TimeUs hb_due_ = kNever;
    TimeUs last_echo_ = 0;
    std::array<uint32_t, kUdpOkIntervals> hb_udp_seqs_{};  // recent HEARTBEATs that went over UDP
    size_t hb_udp_next_ = 0;
    uint8_t hub_hb_streak_ = 0;  // hub HEARTBEATs since the last echo
    uint8_t queue_hwm_ = 0;      // outbox high-water mark since the last HEARTBEAT
    uint32_t sweeps_reported_ = 0;  // LinkInfo::sweeps as of the last HEARTBEAT sent (swept bit)
    bool booted_ = false;        // fr.node.boot went out (after the first WELCOME)

    // Debug hooks and requests deferred until the current receive() has sent its RESULT.
    TimeUs drop_until_ = 0;
    TimeUs udp_block_until_ = 0;
    TimeUs ip_block_until_ = 0;
    std::array<bool, kLinkKinds> held_{};  // Link::hold() as last asked, per link
    bool in_receive_ = false;
    bool defer_bye_ = false;
    uint8_t defer_bye_reason_ = 0;
    uint8_t defer_bye_via_ = 0;  // the link its request's RESULT took (kVia* bit); 0: every session
    uint32_t defer_drop_s_ = 0;
    uint32_t defer_udp_block_s_ = 0;
    uint32_t defer_ip_block_s_ = 0;
    bool defer_drop_ = false;
    bool defer_udp_block_ = false;
    bool defer_ip_block_ = false;
    TimeUs rx_at_ = 0;  // when the envelope being handled arrived (TIME t2)

    uint32_t rng_ = 0;
    bool rng_seeded_ = false;

    std::array<Pending, kOutboxEntries> outbox_{};
    std::array<Cached, kCacheEntries> cache_{};
    uint32_t cache_clock_ = 0;
    uint8_t bulk_cache_[kBulkSize];
    // Envelopes are built here and handed to the links before anything else can build one; RESULT
    // fields go to reply_buf_ (bulk capacity: requests arrive on TCP or serial).
    uint8_t tx_buf_[kBulkSize];
    uint8_t reply_buf_[cap::Reply::kBulkCapacity];
};

}  // namespace fr::net
