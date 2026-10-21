// fr:realtime
// fr_net core (design c3 §3, spec 05 §5.8-5.12). Everything runs on the core task and is driven by three
// inputs: envelopes from the links (receive), emissions from capabilities (event/property) and one timer
// that tick() serves at the earliest of the deadlines it keeps (HELLO repeats, session timeouts, the
// udp_ok expiry, the heartbeat, Q1 retries and give-ups, STATE second copies, the debug hooks). No heap:
// envelopes are built in tx_buf_, kept frames live in fixed slots.
#include "fr/net/net.hpp"

#include <algorithm>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/hash.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"  // generated fr::proto system messages
#include "node.hpp"      // generated fr::cap::Node: the boot event

namespace fr::net {

using namespace fr::wire;

namespace {

constexpr std::array<LinkKind, 2> kSessionLinks{LinkKind::serial, LinkKind::tcp};

constexpr TimeUs ms_us(uint32_t ms)
{
    return static_cast<TimeUs>(ms) * 1000;
}

/** The u32 clock of envelopes and EXT TLVs: the low 32 bits of esp_timer µs (05 §5.7). */
constexpr uint32_t low32(TimeUs t)
{
    return static_cast<uint32_t>(t);
}

/** Groups and the reserved well-known groups (05 §5.5): BCAST space, delivered only to members (M2). */
constexpr bool is_group(uint16_t dst)
{
    return dst >= fr::proto::kAddrGroupsFirst && dst < fr::proto::kAddrUnassigned;
}

}  // namespace

Net::Net(Core &core, Host &host, const Config &cfg) : core_(core), host_(host), cfg_(cfg)
{
    // Kconfig ranges keep these sane; the floors only stop a zero from spinning the timer at 0 µs.
    cfg_.heartbeat_ms = std::max<uint32_t>(cfg_.heartbeat_ms, 10);
    cfg_.hello_retry_ms = std::max<uint32_t>(cfg_.hello_retry_ms, 10);
    cfg_.ack_base_ms = std::max<uint32_t>(cfg_.ack_base_ms, 1);
    cfg_.max_attempts = std::max<uint8_t>(cfg_.max_attempts, 1);
    const uint8_t ttl = std::min<uint8_t>(cfg_.ttl_default, 15);
    ttl_ = static_cast<uint8_t>(ttl << 4 | ttl);
    rng_ = cfg_.rng_seed;
    rng_seeded_ = cfg_.rng_seed != 0;
}

// ---- links ----

void Net::attach(Link &l)
{
    if (timer_ == nullptr) {
        timer_ = core_.timer([this] { tick(); });
    }
    const LinkKind k = l.kind();
    if (link(k) != &l && ls(k).session) {
        end_session(k, false);
    }
    links_[index_of(k)] = &l;
    held_[index_of(k)] = false;
    update_holds();  // a link attached while a hook runs is held like the others
    LinkState &s = ls(k);
    s.attached = true;
    s.up = l.up();
    // attach() may run before the core task does (fr_core's start()): the timer sends the HELLO.
    sess(k).hello_due = s.up && k != LinkKind::udp ? core_.now() : kNever;
    arm();
}

void Net::link_changed(LinkKind k)
{
    Link *l = link(k);
    LinkState &s = ls(k);
    s.up = l != nullptr && l->up();
    if (!s.up) {
        end_session(k, true);
        sess(k).hello_due = kNever;
        if (k == LinkKind::udp) {
            clear_udp_ok();
        }
    } else if (k != LinkKind::udp && !s.session) {
        // A fresh TCP connection or USB host: HELLO at once, then every hello_retry_ms until WELCOME.
        sess(k).hello_due = core_.now();
        if (!frozen(k)) {
            send_hello(k);
            sess(k).hello_due = core_.now() + ms_us(cfg_.hello_retry_ms);
        }
    }
    arm();
}

void Net::receive(LinkKind from, std::span<const uint8_t> envelope)
{
    if (index_of(from) >= kLinkKinds) {
        return;
    }
    ++ls(from).rx;
    rx_at_ = core_.now();
    in_receive_ = true;
    handle(from, envelope);
    in_receive_ = false;
    run_deferred();
    arm();
}

void Net::bye(uint8_t reason)
{
    // Inside a request (fr.node.reboot) its RESULT goes first: the hub takes a node offline at its BYE
    // and fails what it still waits for, so a BYE ahead of the RESULT would turn an accepted reboot into
    // a DEVICE_OFFLINE answer.
    if (in_receive_) {
        defer_bye_ = true;
        defer_bye_reason_ = reason;
        defer_bye_via_ = 0;  // on_cmd names the RESULT's link once dispatch returns
        return;
    }
    send_bye(reason, 0);
    end_sessions_after_bye();
}

void Net::send_bye(uint8_t reason, uint8_t via)
{
    if (!state_.hub_link()) {
        return;
    }
    uint8_t body[fr::proto::PresenceBye::kMaxSize];
    Writer w(body, sizeof(body));
    encode(fr::proto::PresenceBye{.reason = reason}, w);
    // One envelope on every session (or the one `via` names): the hub dedups the copies like a dual-path
    // frame.
    auto env = build(0, kClsPresence, fr::proto::kKindPresenceBye, ++seq_, fr::proto::kAddrHub, fr::proto::kPortNode,
                     {}, w.bytes());
    for (LinkKind k : kSessionLinks) {
        if (ls(k).session && (via == 0 || (via & (1u << index_of(k))) != 0)) {
            transmit_on(k, env);
        }
    }
}

State Net::state() const
{
    return state_;
}

void Net::reset_stats()
{
    for (LinkState &l : state_.links) {
        l.tx = l.tx_fail = l.rx = l.rx_drop = l.retries = 0;
    }
    state_.events_dropped = state_.delivery_failed = state_.cmds = state_.cmds_refused = 0;
    state_.dup = state_.old = state_.cached_replies = state_.sessions_lost = state_.hook_drops = 0;
    state_.sessions_timed_out = 0;
}

void Net::drop_hub_link(uint32_t seconds)
{
    if (seconds == 0) {
        defer_drop_ = false;
        if (dropping()) {
            end_drop();
            tick();
        }
        return;
    }
    if (in_receive_) {
        defer_drop_ = true;
        defer_drop_s_ = seconds;
        return;
    }
    start_drop(seconds);
}

void Net::udp_block(uint32_t seconds)
{
    if (seconds == 0) {
        defer_udp_block_ = false;
        state_.udp_blocked = false;
        arm();
        return;
    }
    // Deferred like drop_hub_link: the RESULT of `net udp_block` itself may be going over UDP.
    if (in_receive_) {
        defer_udp_block_ = true;
        defer_udp_block_s_ = seconds;
        return;
    }
    start_udp_block(seconds);
}

void Net::ip_block(uint32_t seconds)
{
    if (seconds == 0) {
        defer_ip_block_ = false;
        if (state_.ip_blocked) {
            end_ip_block();
            tick();
        }
        return;
    }
    // Deferred like the others: the RESULT of `net ip_block` itself may be going over TCP or UDP.
    if (in_receive_) {
        defer_ip_block_ = true;
        defer_ip_block_s_ = seconds;
        return;
    }
    start_ip_block(seconds);
}

// ---- capability emissions ----

void Net::event(uint8_t port, uint8_t event_id, cap::Priority prio, std::span<const uint8_t> fields, TimeUs at)
{
    // fr.node.boot is normally Net's own (on_welcome); the age exemption holds whoever emits it.
    const bool exempt = port == fr::proto::kPortNode && event_id == cap::Node::kEventBoot;
    send_event(port, event_id, prio, fields, at, exempt);
    arm();
}

void Net::property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, TimeUs at)
{
    const TimeUs t = at < 0 ? core_.now() : at;
    // state_seq counts STATEs meant for the hub even when they find no path or are lost on UDP: the hub
    // then sees a state_seq ahead of what it got and calls get_state (05 §5.8 "Resync").
    const uint32_t seq = ++latest_seq_;
    state_.state_seq = seq;
    const size_t len = kHeaderSize + kTimePrefixSize + value.size();
    const uint8_t flags = kFlagLatest | (len > kRtSize ? kFlagBulk : 0);
    const uint8_t via = route(kClsState, prop_id, flags, len);
    if (via == 0) {
        return;  // get_state on the next WELCOME re-reports it
    }
    uint8_t prefix[kTimePrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_time_prefix(low32(t), pw);
    auto env = build(flags, kClsState, prop_id, seq, fr::proto::kAddrHub, port, pw.bytes(), value);
    if (env.empty()) {
        return;
    }
    transmit(via, env);
    if ((via & kViaUdp) != 0) {
        schedule_repeat(env);
        arm();
    }
}

// ---- receive side ----

void Net::handle(LinkKind from, std::span<const uint8_t> envelope)
{
    LinkState &s = ls(from);
    if (frozen(from)) {
        ++state_.hook_drops;
        ++s.rx_drop;
        return;
    }
    if (link(from) == nullptr) {
        ++s.rx_drop;  // nothing attached of that kind: no session can answer through it
        return;
    }
    auto e = unpack_envelope(envelope);
    if (!e) {
        ++s.rx_drop;
        return;
    }
    const Header &h = e->header;
    // Router mode (C3): a node hears only the hub, over its own TCP or serial session. The hub never
    // sends UDP; node-to-node frames come with bindings (C5). A provisioned node also filters on its net.
    const bool provisioned = addr_ != fr::proto::kAddrUnassigned;
    if (from == LinkKind::udp || h.src != fr::proto::kAddrHub || (provisioned && h.net != net_)) {
        ++s.rx_drop;
        return;
    }
    if (h.cls == kClsNet && h.kind == fr::proto::kKindNetWelcome) {
        // WELCOME opens the session and resets the windows, so it is not window-checked itself.
        if (h.dst != addr_) {
            ++s.rx_drop;
            return;
        }
        on_welcome(from, e->body);
        return;
    }
    // Hub windows are only meaningful inside a session of the hub run that WELCOMEd it.
    if (!s.session) {
        ++s.rx_drop;
        return;
    }
    if (h.epoch != state_.hub_epoch) {
        ++state_.old;
        ++s.rx_drop;
        return;
    }
    // Any frame of this hub run proves the hub alive on this link, a DUP included (05 §5.11).
    sess(from).last_rx = rx_at_;

    const bool unicast = h.dst == addr_;
    const bool broadcast = h.dst == fr::proto::kAddrBroadcast;
    if (!unicast && !broadcast && !is_group(h.dst)) {
        ++s.rx_drop;  // another node's frame
        return;
    }
    ReplayWindow<kWindowBits>::Verdict v = ReplayWindow<kWindowBits>::Verdict::fresh;
    if ((h.flags & kFlagLatest) != 0) {
        if (!latest_.accept(h.port, h.kind, h.seq)) {
            v = ReplayWindow<kWindowBits>::Verdict::old;
        }
    } else {
        v = (unicast ? ucast_ : bcast_).check_and_set(h.seq);
    }
    if (v == ReplayWindow<kWindowBits>::Verdict::dup) {
        ++state_.dup;
        ++s.rx_drop;
        if (unicast && (h.flags & kFlagAckReq) != 0) {
            if (h.cls == kClsCmd || h.cls == kClsOta) {
                // A retried request (a CMD, an OFFER): its response again, byte-identical, and the request
                // not run twice (05 §5.8).
                resend_cached(h.src, h.epoch, h.seq, from);
            } else if (h.cls == kClsEvent || h.cls == kClsMsg) {
                send_ack(h);  // the first ACK was lost: an ACK is idempotent, so a fresh one does
            }
        }
        return;
    }
    if (v == ReplayWindow<kWindowBits>::Verdict::old) {
        ++state_.old;
        ++s.rx_drop;
        return;
    }
    if (!unicast && !broadcast) {
        ++s.rx_drop;  // a group: the seq is recorded (watermark), delivery needs membership (M2)
        return;
    }

    switch (h.cls) {
    case kClsPresence:
        on_presence(from, h.kind, e->body, unicast);
        break;
    case kClsAck:
        on_ack(h.kind, e->result.req_epoch, e->result.req_seq);
        break;
    case kClsCmd:
        on_cmd(*e, unicast, from);
        break;
    case kClsOta:
        on_ota(*e, unicast, from);
        break;
    case kClsTime:
        if (unicast && h.kind == fr::proto::kKindTimeSyncReq) {
            on_sync_req(from, e->body);
        }
        break;
    case kClsEvent:
    case kClsMsg:
        // 05 §5.8: a Q1 EVENT or unicast MSG is acknowledged with an ACK frame. It confirms receipt;
        // MSG delivery to bindings arrives with C5.
        if (unicast && (h.flags & kFlagAckReq) != 0) {
            send_ack(h);
        }
        break;
    default:
        // NET.DIRECTORY (directory use is C5): accepted, nothing to do yet.
        break;
    }
}

void Net::send_ack(const Header &h)
{
    uint8_t prefix[kResultPrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_result_prefix({.req_epoch = h.epoch, .req_seq = h.seq, .status = fr::proto::kStatusOk}, pw);
    const size_t len = kHeaderSize + kResultPrefixSize;
    const uint8_t via = route(kClsAck, fr::proto::kKindAckAck, 0, len);
    if (via != 0) {
        transmit(via, build(0, kClsAck, fr::proto::kKindAckAck, ++seq_, h.src, h.port, pw.bytes(), {}));
    }
}

void Net::on_welcome(LinkKind from, std::span<const uint8_t> body)
{
    auto w = fr::proto::decode_net_welcome(body);
    if (!w) {
        ++ls(from).rx_drop;
        return;
    }
    // A WELCOME from another hub run: sessions on the other link belong to the old run.
    for (LinkKind k : kSessionLinks) {
        if (k != from && ls(k).session && w->hub_epoch != state_.hub_epoch) {
            lose_session(k, DropReason::hub_restarted);
        }
    }
    // 05 §5.8: the node resets its hub entries on every WELCOME, with the floors the hub gives.
    state_.hub_epoch = w->hub_epoch;
    ucast_.reset(w->ucast_floor);
    bcast_.reset(w->bcast_base);
    latest_.clear();
    LinkState &s = ls(from);
    s.session = true;
    s.time_synced = false;  // the handshake's TIME burst follows
    sess(from).last_rx = rx_at_;
    sess(from).hello_due = kNever;
    // Heartbeats start with the first session, and one follows every WELCOME: on TCP it probes UDP at once
    // instead of an interval later, so inputs get the fast path sooner.
    hb_due_ = std::min(hb_due_, rx_at_);
    if (!booted_) {
        // 07 §7.3: fr.node.boot once per boot, right after the first WELCOME, exempt from the age rule.
        booted_ = true;
        uint8_t buf[cap::NodeBoot::kMaxSize];
        Writer bw(buf, sizeof(buf));
        encode(cap::NodeBoot{.reset_reason = host_.hello_info().reset_reason}, bw);
        send_event(fr::proto::kPortNode, cap::Node::kEventBoot, cap::Priority::normal, bw.bytes(), rx_at_, true);
    }
}

void Net::on_presence(LinkKind from, uint8_t kind, std::span<const uint8_t> body, bool unicast)
{
    switch (kind) {
    case fr::proto::kKindPresenceHeartbeat:
        // The hub's own keepalive, sent when no echo went to this node within an interval. Jitter lets
        // one slip in between echoes; two in a row mean the UDP heartbeats stopped arriving: fall back
        // to TCP now instead of after 3 intervals, before the hub's offline timer runs out. Only TCP's
        // count: echoes come over TCP, while a standby serial session gets a keepalive every interval
        // whatever UDP does (a board on USB would otherwise flap udp_ok).
        if (from != LinkKind::tcp) {
            break;
        }
        hub_hb_streak_ = static_cast<uint8_t>(std::min(hub_hb_streak_ + 1, 2));
        if (hub_hb_streak_ >= 2) {
            clear_udp_ok();
        }
        break;
    case fr::proto::kKindPresencePing: {
        if (!unicast) {
            break;
        }
        // The hub PINGs a node it has not heard from for 2.5 intervals (suspect): whatever udp_ok says,
        // UDP is not reaching it, so the PONG and what follows take TCP (a heartbeat too, at once).
        clear_udp_ok();
        auto ping = fr::proto::decode_presence_ping(body);
        if (!ping) {
            break;
        }
        uint8_t buf[fr::proto::PresencePong::kMaxSize];
        Writer w(buf, sizeof(buf));
        encode(fr::proto::PresencePong{.t0 = ping->t0, .t1 = low32(rx_at_)}, w);
        const size_t len = kHeaderSize + w.size();
        const uint8_t via = every_session(kClsPresence, fr::proto::kKindPresencePong, len);
        if (via != 0) {
            transmit(via, build(0, kClsPresence, fr::proto::kKindPresencePong, ++seq_, fr::proto::kAddrHub,
                                fr::proto::kPortNode, {}, w.bytes()));
        }
        break;
    }
    case fr::proto::kKindPresenceBye:
        // The hub ends its link with this node (it is shutting down, or it took the node offline): every
        // session of this hub run ends now, not only the one the BYE came on. The hub sends it over USB
        // and closes TCP, and a close that never reached the node (Wi-Fi gone) would otherwise keep
        // RESULTs on a dead connection while the hub WELCOMEs the node again over USB.
        for (LinkKind k : kSessionLinks) {
            if (ls(k).session) {
                lose_session(k, DropReason::hub_bye);
            }
        }
        break;
    default:
        break;
    }
}

void Net::on_ack(uint8_t kind, uint16_t req_epoch, uint32_t req_seq)
{
    if ((kind != fr::proto::kKindAckAck && kind != fr::proto::kKindAckNack) || req_epoch != epoch_) {
        return;
    }
    if (kind == fr::proto::kKindAckAck) {
        for (const uint32_t seq : hb_udp_seqs_) {
            if (seq != 0 && seq == req_seq) {
                // The hub's echo of a UDP HEARTBEAT: UDP works (05 §5.10 probe).
                ls(LinkKind::udp).udp_ok = true;
                last_echo_ = rx_at_;
                hub_hb_streak_ = 0;
                return;
            }
        }
    }
    for (Pending &p : outbox_) {
        if (p.used && !p.repeat && p.seq == req_seq) {
            p.used = false;
            return;
        }
    }
}

void Net::on_cmd(const EnvelopeView &e, bool unicast, LinkKind from)
{
    const Header &h = e.header;
    // 05 §5.8: only port 0 means the same thing on every device, so only it takes broadcasts; those, and
    // fast CMDs (no ACK_REQ: Q0, never answered), get no RESULT.
    if (!unicast && h.port != fr::proto::kPortNode) {
        ++state_.cmds_refused;
        ++ls(from).rx_drop;
        return;
    }
    const bool respond = unicast && (h.flags & kFlagAckReq) != 0;
    // Requests arrive on TCP or serial, where a RESULT may go BULK (design c3 §2).
    const size_t capacity = from == LinkKind::udp ? cap::Reply::kRealtimeCapacity : cap::Reply::kBulkCapacity;
    cap::Reply reply(std::span<uint8_t>(reply_buf_, capacity));
    Status st;
    const std::optional<uint32_t> expire_at = h.ext.value(kExtExpireAtUs);
    if (h.ext.find(kExtExecAtUs)) {
        // Scheduled execution arrives with T-LAT (design c3 §9, decision 9).
        st = std::unexpected(Err::unsupported);
        ++state_.cmds_refused;
    } else if (expire_at && state_.time_synced() && seq_after(low32(rx_at_), *expire_at)) {
        // Arrived after the hub had given up on it: never run late (05 §5.6, §5.8). An unsynced node
        // cannot compare clocks and ignores the TLV.
        st = std::unexpected(Err::expired);
        ++state_.cmds_refused;
    } else {
        ++state_.cmds;
        st = host_.dispatch(h.port, h.kind, e.body, reply);
    }
    if (!respond) {
        return;
    }
    uint8_t prefix[kResultPrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_result_prefix({.req_epoch = h.epoch, .req_seq = h.seq, .status = wire_status(st)}, pw);
    // Only a successful dispatch owns what it wrote into the reply.
    const std::span<const uint8_t> fields = st ? reply.bytes() : std::span<const uint8_t>{};
    const size_t len = kHeaderSize + kResultPrefixSize + fields.size();
    const uint8_t flags = len > kRtSize ? kFlagBulk : 0;
    auto env = build(flags, kClsResult, h.kind, ++seq_, h.src, h.port, pw.bytes(), fields);
    if (env.empty()) {
        return;  // cannot happen: the bulk Reply leaves room for the header and prefix
    }
    cache(h.src, h.epoch, h.seq, env);
    if (defer_bye_) {
        // The request asked for a BYE (fr.node.reboot), which takes the node offline at the hub and fails
        // what it still waits for. The hub orders frames per link only, so the RESULT and then the BYE
        // both take the link the request came on (TCP or serial: the hub never sends UDP), never UDP or
        // the other session, where the BYE could overtake it (design c3 §3, decision 17).
        defer_bye_via_ = static_cast<uint8_t>(1u << index_of(from));
        transmit_on(from, env);
        return;
    }
    const uint8_t via = answer_route(from, kClsResult, h.kind, flags, env.size());
    if (via != 0) {
        transmit(via, env);
    }
}

void Net::on_ota(const EnvelopeView &e, bool unicast, LinkKind from)
{
    const Header &h = e.header;
    // 05 §5.7: OTA traffic is unicast and always on port 240; anything else is no job of this node's.
    if (!unicast || h.port != fr::proto::kPortOta) {
        ++ls(from).rx_drop;
        return;
    }
    OtaReply reply;
    host_.ota_frame(from, h, e.body, reply);
    if (!reply.has()) {
        return;  // answered later through send_ota (an ACCEPT after the first bytes), or never (COMMIT)
    }
    auto env = build(0, kClsOta, reply.kind(), ++seq_, h.src, fr::proto::kPortOta, {}, reply.body());
    if (env.empty()) {
        return;  // cannot happen: OtaReply::kCapacity keeps it realtime-sized
    }
    if ((h.flags & kFlagAckReq) != 0) {
        // The answer is the OFFER's acknowledgement (05 §5.8): a DUP of the OFFER gets these bytes again
        // and is not handed to the host twice.
        cache(h.src, h.epoch, h.seq, env);
    }
    const uint8_t via = answer_route(from, kClsOta, reply.kind(), 0, env.size());
    if (via != 0) {
        transmit(via, env);
    }
}

Status Net::send_ota(uint8_t kind, std::span<const uint8_t> body, bool ack_req)
{
    const size_t len = kHeaderSize + body.size();
    if (len > kRtSize) {
        return std::unexpected(Err::invalid_args);  // STATUS, RESULT, ACCEPT, REJECT are all a few dozen bytes
    }
    const uint8_t flags = ack_req ? kFlagAckReq : 0;
    const uint8_t via = route(kClsOta, kind, flags, len);
    if (via == 0) {
        return std::unexpected(Err::busy);  // no session (or drop_hub_link): the job reports after WELCOME
    }
    const uint32_t seq = ++seq_;
    auto env = build(flags, kClsOta, kind, seq, fr::proto::kAddrHub, fr::proto::kPortOta, {}, body);
    if (env.empty() || !transmit_on(via == kViaTcp ? LinkKind::tcp : LinkKind::serial, env)) {
        return std::unexpected(Err::busy);
    }
    if (ack_req) {
        // Q1 on TCP or serial: no re-send, only the give-up after tcp_delivery_ms (05 §5.8). Not input, so
        // exempt from the event age rule.
        track(env, seq, via, core_.now(), true);
        arm();
    }
    return {};
}

void Net::on_sync_req(LinkKind from, std::span<const uint8_t> body)
{
    auto req = fr::proto::decode_time_sync_req(body);
    if (!req) {
        ++ls(from).rx_drop;
        return;
    }
    // t2 when the request reached the core task, t3 now; the answer takes the link the request came on,
    // since the hub measures that link's round trip (05 §5.12.4).
    const fr::proto::TimeSyncRes res{.t1 = req->t1,
                                     .t2 = static_cast<uint64_t>(rx_at_),
                                     .t3 = static_cast<uint64_t>(core_.now())};
    uint8_t buf[fr::proto::TimeSyncRes::kMaxSize];
    Writer w(buf, sizeof(buf));
    encode(res, w);
    transmit_on(from, build(0, kClsTime, fr::proto::kKindTimeSyncRes, ++seq_, fr::proto::kAddrHub,
                            fr::proto::kPortNode, {}, w.bytes()));
    ls(from).time_synced = true;
}

bool Net::resend_cached(uint16_t src, uint16_t epoch, uint32_t req_seq, LinkKind from)
{
    for (const Cached &c : cache_) {
        if (c.used && c.src == src && c.epoch == epoch && c.req_seq == req_seq) {
            const std::span<const uint8_t> env(c.bulk ? bulk_cache_ : c.bytes, c.len);
            const uint8_t via = answer_route(from, env[2], env[3], env[1], env.size());
            if (via != 0) {
                transmit(via, env);
            }
            ++state_.cached_replies;
            return true;
        }
    }
    return false;  // evicted: dropped all the same, never run twice
}

void Net::cache(uint16_t src, uint16_t epoch, uint32_t req_seq, std::span<const uint8_t> envelope)
{
    Cached *slot = &cache_[0];
    for (Cached &c : cache_) {
        if (!c.used) {
            slot = &c;
            break;
        }
        if (c.stamp < slot->stamp) {
            slot = &c;
        }
    }
    const bool bulk = envelope.size() > kRtSize;
    if (bulk) {
        // One bulk response at a time (describe, diag.exec): the previous one leaves the cache.
        for (Cached &c : cache_) {
            if (c.used && c.bulk) {
                c.used = false;
            }
        }
        std::memcpy(bulk_cache_, envelope.data(), envelope.size());
    } else {
        std::memcpy(slot->bytes, envelope.data(), envelope.size());
    }
    slot->used = true;
    slot->bulk = bulk;
    slot->src = src;
    slot->epoch = epoch;
    slot->req_seq = req_seq;
    slot->stamp = ++cache_clock_;
    slot->len = static_cast<uint16_t>(envelope.size());
}

// ---- sessions and timing ----

TimeUs Net::session_timeout_us() const
{
    const uint64_t x10 = uint64_t{cfg_.heartbeat_ms} * cfg_.offline_x10 / 10;
    return ms_us(static_cast<uint32_t>(std::max<uint64_t>(x10, cfg_.offline_min_ms)));
}

void Net::send_hello(LinkKind k)
{
    const Identity id = host_.identity();
    net_ = id.net;
    addr_ = id.addr;
    epoch_ = id.epoch;
    const HelloInfo hi = host_.hello_info();
    const LinkInfo li = host_.link_info();
    if (!rng_seeded_) {
        rng_ = fnv1a32(std::span<const uint8_t>(hi.mac));
        rng_seeded_ = true;
    }
    const bool associated = li.channel != 0;
    const fr::proto::PresenceHello m{
        .mac = hi.mac,
        .chip = hi.chip,
        .chip_rev = hi.chip_rev,
        .fw_id_prefix = hi.fw_id_prefix,
        .descriptor_hash = hi.descriptor_hash,
        .board_hash = hi.board_hash,
        .role = hi.role,
        .caps = hi.caps,
        .hb_interval_ms = cfg_.heartbeat_ms,  // the cadence Net keeps, whatever HelloInfo says
        .reset_reason = hi.reset_reason,
        .ota_state = hi.ota_state,
        .alias = id.alias_view(),
        .alias_rev = id.alias_rev,
        .channel = li.channel,
        .bssid = associated ? std::span<const uint8_t>(li.bssid) : std::span<const uint8_t>{},
    };
    uint8_t body[fr::proto::PresenceHello::kMaxSize];
    Writer w(body, sizeof(body));
    encode(m, w);
    if (w.overflow()) {
        return;
    }
    // HELLO is the request side of HELLO/WELCOME (Q1); it goes on the link it opens, repeated by the timer.
    transmit_on(k, build(kFlagAckReq, kClsPresence, fr::proto::kKindPresenceHello, ++seq_, fr::proto::kAddrHub,
                         fr::proto::kPortNode, {}, w.bytes()));
}

void Net::send_heartbeat()
{
    const TimeUs now = core_.now();
    const LinkInfo li = host_.link_info();
    const Vitals vit = host_.vitals();
    uint32_t tx_fail = 0;
    uint32_t rx_drop = 0;
    for (const LinkState &l : state_.links) {
        tx_fail += l.tx_fail;
        rx_drop += l.rx_drop;
    }
    uint32_t bits = 0;
    bits |= li.wifi_up ? kStateWifiUp : 0;
    bits |= state_.hub_link() ? kStateHubLink : 0;
    bits |= vit.ota_busy ? kStateOtaBusy : 0;
    bits |= state_.time_synced() ? kStateTimeSynced : 0;
    bits |= vit.low_batt ? kStateLowBatt : 0;
    // 05 §5.4 "Heartbeats report each sweep": set until a HEARTBEAT carrying it has gone out.
    bits |= li.sweeps != sweeps_reported_ ? kStateSwept : 0;
    const fr::proto::PresenceHeartbeat m{
        .uptime_s = static_cast<uint32_t>(now / 1'000'000),
        .state = bits,
        .rssi_ap = li.rssi,
        .tx_fail = tx_fail,
        .rx_drop = rx_drop,
        .queue_hwm = queue_hwm_,
        .free_heap_kb = vit.free_heap_kb,
        .vbat_mv = vit.vbat_mv,
        .bcast_watermark = bcast_.watermark(),
        .state_seq = state_.state_seq,
    };
    // queue_hwm covers one interval: the outbox's peak since the previous HEARTBEAT.
    queue_hwm_ = static_cast<uint8_t>(pending_count());
    uint8_t body[fr::proto::PresenceHeartbeat::kMaxSize];
    Writer w(body, sizeof(body));
    encode(m, w);
    const uint8_t via = every_session(kClsPresence, fr::proto::kKindPresenceHeartbeat, kHeaderSize + w.size());
    if (via == 0) {
        return;
    }
    const uint32_t seq = ++seq_;
    transmit(via, build(0, kClsPresence, fr::proto::kKindPresenceHeartbeat, seq, fr::proto::kAddrHub,
                        fr::proto::kPortNode, {}, w.bytes()));
    sweeps_reported_ = li.sweeps;
    if ((via & kViaUdp) != 0) {
        // The hub echoes each UDP-received HEARTBEAT with an ACK over TCP: that echo is the udp_ok probe.
        hb_udp_seqs_[hb_udp_next_] = seq;
        hb_udp_next_ = (hb_udp_next_ + 1) % hb_udp_seqs_.size();
    }
}

uint8_t Net::every_session(uint8_t cls, uint8_t kind, size_t len) const
{
    if (dropping()) {
        return 0;
    }
    const uint8_t via = ls(LinkKind::tcp).session ? wifi_route(cls, kind, 0, len) : 0;
    return ls(LinkKind::serial).session ? static_cast<uint8_t>(via | kViaSerial) : via;
}

void Net::end_session(LinkKind k, bool lost)
{
    if (index_of(k) >= kLinkKinds || k == LinkKind::udp) {
        return;
    }
    LinkState &s = ls(k);
    if (!s.session) {
        return;
    }
    s.session = false;
    s.time_synced = false;
    if (lost) {
        ++state_.sessions_lost;
    }
    // 05 §5.8: a Q1 frame written to a connection that is gone has failed; UDP rides the TCP session
    // (its ACKs come back over TCP).
    if (k == LinkKind::tcp) {
        clear_udp_ok();
        fail_pending(kViaTcp | kViaUdp);
        // A standby serial session becomes the path: its keepalive clock starts now.
        sess(LinkKind::serial).last_rx = core_.now();
    } else {
        fail_pending(kViaSerial);
    }
    if (!state_.hub_link()) {
        hb_due_ = kNever;
    }
}

void Net::lose_session(LinkKind k, DropReason why)
{
    if (why == DropReason::hub_silent && ls(k).session) {
        ++state_.sessions_timed_out;
    }
    end_session(k, true);
    Link *l = link(k);
    if (l == nullptr) {
        return;
    }
    // 05 §5.11: close and reconnect (TCP: its link_changed brings the next HELLO; one retry period is the
    // fallback for a link still up), or just HELLO again (serial).
    l->drop(why);
    if (!l->up()) {
        sess(k).hello_due = kNever;
    } else if (k == LinkKind::tcp) {
        sess(k).hello_due = core_.now() + ms_us(cfg_.hello_retry_ms);
    } else {
        sess(k).hello_due = core_.now();
    }
}

void Net::end_sessions_after_bye()
{
    const TimeUs now = core_.now();
    for (LinkKind k : kSessionLinks) {
        if (ls(k).session) {
            end_session(k, false);
            // A node that lives on after all (an OTA that did not start) comes back by itself.
            sess(k).hello_due = now + ms_us(cfg_.hello_retry_ms);
        }
    }
    arm();
}

void Net::clear_udp_ok()
{
    LinkState &u = ls(LinkKind::udp);
    if (!u.udp_ok) {
        return;
    }
    u.udp_ok = false;
    if (!ls(LinkKind::tcp).session) {
        return;  // end_session(tcp): its frames failed with it, and heartbeats need a session
    }
    // 05 §5.10: while udp_ok is false Q1 frames take UDP and TCP. One that went over UDP alone keeps its
    // UDP retries and gets its TCP copy now, instead of retrying only on a path the node no longer trusts
    // (stale input is not resent: its next retry drops it).
    const TimeUs now = core_.now();
    for (Pending &p : outbox_) {
        if (!p.used || p.repeat || p.via != kViaUdp || (!p.exempt && now - p.at > ms_us(cfg_.event_max_age_ms))) {
            continue;
        }
        if (transmit_on(LinkKind::tcp, std::span<const uint8_t>(p.bytes, p.len))) {
            p.via |= kViaTcp;
            p.deadline = now + ms_us(cfg_.tcp_delivery_ms);
        }
    }
    // Whatever cleared it (lapse, PING, hub keepalives, UDP down), the hub hears at once over TCP, and
    // the UDP copy re-probes (design c3 §3).
    hb_due_ = std::min(hb_due_, now);
}

void Net::update_holds()
{
    for (size_t i = 0; i < kLinkKinds; ++i) {
        const bool on = frozen(static_cast<LinkKind>(i));
        if (links_[i] != nullptr && held_[i] != on) {
            held_[i] = on;
            links_[i]->hold(on);
        }
    }
}

void Net::run_deferred()
{
    if (defer_bye_) {
        defer_bye_ = false;
        send_bye(defer_bye_reason_, defer_bye_via_);
        defer_bye_via_ = 0;
        end_sessions_after_bye();
    }
    if (defer_drop_) {
        defer_drop_ = false;
        start_drop(defer_drop_s_);
    }
    if (defer_udp_block_) {
        defer_udp_block_ = false;
        start_udp_block(defer_udp_block_s_);
    }
    if (defer_ip_block_) {
        defer_ip_block_ = false;
        start_ip_block(defer_ip_block_s_);
    }
}

void Net::start_drop(uint32_t seconds)
{
    state_.hub_link_dropped = true;
    drop_until_ = core_.now() + static_cast<TimeUs>(seconds) * 1'000'000;
    // No reconnects either (09 §9.7): a connection the hub closes meanwhile stays closed until the end.
    update_holds();
    arm();
}

void Net::start_udp_block(uint32_t seconds)
{
    state_.udp_blocked = true;
    udp_block_until_ = core_.now() + static_cast<TimeUs>(seconds) * 1'000'000;
    arm();
}

void Net::start_ip_block(uint32_t seconds)
{
    state_.ip_blocked = true;
    ip_block_until_ = core_.now() + static_cast<TimeUs>(seconds) * 1'000'000;
    // The TCP connection stays as it is: one the hub closes meanwhile is not reconnected until the end.
    update_holds();
    arm();
}

void Net::end_drop()
{
    state_.hub_link_dropped = false;
    drop_until_ = 0;
    update_holds();
    // Session timeouts resume from the last hub frame before the drop: a drop longer than the timeout
    // ends every session at once, the standby serial one included (the hub declared the node offline
    // long ago), and they re-HELLO. HELLOs that fell due during the drop go at the next tick.
    lose_stale_sessions(kViaSerial | kViaTcp);
}

void Net::end_ip_block()
{
    state_.ip_blocked = false;
    ip_block_until_ = 0;
    update_holds();
    // As after a drop, for TCP: a session the hub went silent on for longer than the timeout ends now and
    // reconnects; serial kept its own clock (standby while TCP lasts).
    lose_stale_sessions(kViaTcp);
}

void Net::lose_stale_sessions(uint8_t which)
{
    const TimeUs now = core_.now();
    for (LinkKind k : kSessionLinks) {
        if ((which & (1u << index_of(k))) != 0 && !frozen(k) && ls(k).session &&
            now - sess(k).last_rx >= session_timeout_us()) {
            lose_session(k, DropReason::hub_silent);
        }
    }
}

void Net::tick()
{
    armed_for_ = kNever;  // the timer fired: arm() below starts it again, whatever running() says now
    const TimeUs now = core_.now();
    if (dropping() && now >= drop_until_) {
        end_drop();
    }
    if (state_.udp_blocked && now >= udp_block_until_) {
        state_.udp_blocked = false;
    }
    if (state_.ip_blocked && now >= ip_block_until_) {
        end_ip_block();
    }
    for (LinkKind k : kSessionLinks) {
        LinkState &s = ls(k);
        Session &x = sess(k);
        if (s.session && !frozen(k)) {
            if (k == LinkKind::serial && ls(LinkKind::tcp).session) {
                // Standby: everything goes over TCP/UDP, so the hub owes the serial link nothing. Its
                // clock starts when it becomes the path (from design c3 §9, decision 4).
                x.last_rx = now;
            } else if (now - x.last_rx >= session_timeout_us()) {
                lose_session(k, DropReason::hub_silent);
            }
        }
        if (!s.session && s.up && !frozen(k) && x.hello_due <= now) {
            send_hello(k);
            x.hello_due = now + ms_us(cfg_.hello_retry_ms);
        }
    }
    if (ls(LinkKind::udp).udp_ok && now - last_echo_ >= ms_us(cfg_.heartbeat_ms) * kUdpOkIntervals) {
        clear_udp_ok();  // and a heartbeat over TCP at once, not an interval later
    }
    if (state_.hub_link() && hb_due_ <= now) {
        send_heartbeat();
        hb_due_ = now + jittered_us(cfg_.heartbeat_ms, 10);
    }
    for (Pending &p : outbox_) {
        if (p.used) {
            service_pending(p, now);
        }
    }
    arm();
}

void Net::arm()
{
    if (timer_ == nullptr) {
        return;
    }
    TimeUs next = kNever;
    if (dropping()) {
        next = std::min(next, drop_until_);
    } else {
        for (LinkKind k : kSessionLinks) {
            const LinkState &s = ls(k);
            const Session &x = sessions_[index_of(k)];
            if (frozen(k)) {
                continue;  // ip_block: the TCP session's clock and HELLOs wait for its end
            }
            if (s.session) {
                if (!(k == LinkKind::serial && ls(LinkKind::tcp).session)) {
                    next = std::min(next, x.last_rx + session_timeout_us());
                }
            } else if (s.up) {
                next = std::min(next, x.hello_due);
            }
        }
    }
    if (state_.udp_blocked) {
        next = std::min(next, udp_block_until_);
    }
    if (state_.ip_blocked) {
        next = std::min(next, ip_block_until_);
    }
    if (ls(LinkKind::udp).udp_ok) {
        next = std::min(next, last_echo_ + ms_us(cfg_.heartbeat_ms) * kUdpOkIntervals);
    }
    if (state_.hub_link()) {
        next = std::min(next, hb_due_);
    }
    for (const Pending &p : outbox_) {
        if (p.used) {
            next = std::min({next, p.retry_at, p.deadline});
        }
    }
    if (next == kNever) {
        timer_->stop();
        armed_for_ = kNever;
        return;
    }
    // Emissions call arm() on the realtime path; most leave the earliest deadline as it was.
    if (next == armed_for_ && timer_->running()) {
        return;
    }
    armed_for_ = next;
    const TimeUs now = core_.now();
    const TimeUs delay = next > now ? next - now : 0;
    timer_->start(static_cast<uint32_t>(std::min<TimeUs>(delay, UINT32_MAX)));
}

// ---- send side ----

uint8_t Net::route(uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const
{
    if (dropping()) {
        return 0;
    }
    // 05 §5.10 router mode and design c3 §9 decision 4: TCP/UDP first, serial otherwise, else nothing. Wi-Fi
    // can stall without dropping (an AP gone, IP traffic lost; the ip_block hook): with nothing from the hub
    // over TCP for 2 intervals, a USB node sends over serial, where the hub sends to it by the same rule,
    // and goes back to TCP with the next hub frame there (its TCP session times out at 3.5 intervals).
    const bool serial = ls(LinkKind::serial).session;
    if (ls(LinkKind::tcp).session && !(serial && wifi_silent())) {
        return wifi_route(cls, kind, flags, len);
    }
    return serial ? kViaSerial : 0;
}

uint8_t Net::answer_route(LinkKind from, uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const
{
    // A request from serial is answered there. The hub sends one over USB to a node that has TCP only for
    // the serial session's own handshake, or once nothing reached it over Wi-Fi for 2 intervals, which the
    // node does not see when only its uplink is gone (the hub's keepalives still arrive over TCP).
    if (from == LinkKind::serial && !dropping()) {
        return ls(LinkKind::serial).session ? kViaSerial : 0;
    }
    return route(cls, kind, flags, len);
}

bool Net::wifi_silent() const
{
    // The hub's echoes and keepalives reach a TCP session at least every interval while Wi-Fi carries.
    const TimeUs silent = core_.now() - sessions_[index_of(LinkKind::tcp)].last_rx;
    return silent > ms_us(cfg_.heartbeat_ms) * kWifiSilentX10 / 10;
}

uint8_t Net::wifi_route(uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const
{
    if (cls == kClsOta) {
        return kViaTcp;  // design c4 §3: OTA frames never ride UDP
    }
    const LinkState &u = ls(LinkKind::udp);
    // A BULK frame never fits a datagram the hub's realtime path expects, and the hub drops UDP from
    // an UNASSIGNED node (05 §5.5): its frames have no addr to dedup by.
    const bool udp = len <= kRtSize && u.attached && u.up && addr_ != fr::proto::kAddrUnassigned;
    const bool heartbeat = cls == kClsPresence && kind == fr::proto::kKindPresenceHeartbeat;
    if (udp && u.udp_ok) {
        const bool fast = heartbeat || (cls == kClsPresence && kind == fr::proto::kKindPresencePong) ||
                          cls == kClsAck || cls == kClsResult || (flags & (kFlagUrgent | kFlagLatest)) != 0;
        return fast ? kViaUdp : kViaTcp;
    }
    // UDP unproven: HEARTBEAT (the probe), URGENT and Q1 frames take both, same bytes; the rest TCP.
    const bool dual = udp && (heartbeat || (flags & (kFlagUrgent | kFlagAckReq)) != 0);
    return dual ? kViaUdp | kViaTcp : kViaTcp;
}

std::span<const uint8_t> Net::build(uint8_t flags, uint8_t cls, uint8_t kind, uint32_t seq, uint16_t dst, uint8_t port,
                                    std::span<const uint8_t> prefix, std::span<const uint8_t> body)
{
    Writer w(tx_buf_, sizeof(tx_buf_));
    pack_header({.flags = flags,
                 .cls = cls,
                 .kind = kind,
                 .seq = seq,
                 .net = net_,
                 .src = addr_,
                 .dst = dst,
                 .epoch = epoch_,
                 .ttl = ttl_,
                 .port = port},
                w);
    w.raw(prefix);
    w.raw(body);
    if (w.overflow()) {
        return {};
    }
    return w.bytes();
}

uint8_t Net::transmit(uint8_t via, std::span<const uint8_t> envelope)
{
    // UDP first: it is the fast path, and before udp_ok the TCP copy is only the backup.
    if ((via & kViaUdp) != 0 && !transmit_on(LinkKind::udp, envelope) && !frozen(LinkKind::udp) &&
        !state_.udp_blocked && (via & kViaTcp) == 0 && ls(LinkKind::tcp).session) {
        // The UDP socket refused it (lwIP out of buffers, say): TCP takes it rather than lose a RESULT or
        // a heartbeat. The udp_block and ip_block hooks lose frames on purpose and get no such help.
        via |= kViaTcp;
    }
    if ((via & kViaTcp) != 0) {
        transmit_on(LinkKind::tcp, envelope);
    }
    if ((via & kViaSerial) != 0) {
        transmit_on(LinkKind::serial, envelope);
    }
    return via;
}

bool Net::transmit_on(LinkKind k, std::span<const uint8_t> envelope)
{
    if (envelope.empty()) {
        return false;
    }
    if (frozen(k) || (k == LinkKind::udp && state_.udp_blocked)) {
        ++state_.hook_drops;  // as if the network ate it: nothing else notices
        return false;
    }
    LinkState &s = ls(k);
    Link *l = link(k);
    if (l == nullptr || !l->send(envelope)) {
        ++s.tx_fail;
        return false;
    }
    ++s.tx;
    return true;
}

void Net::send_event(uint8_t port, uint8_t event_id, cap::Priority prio, std::span<const uint8_t> fields, TimeUs at,
                     bool exempt)
{
    const TimeUs now = core_.now();
    const TimeUs t = at < 0 ? now : at;
    const size_t len = kHeaderSize + kTimePrefixSize + fields.size();
    // realtime/normal EVENTs are Q1 (ACK_REQ, 05 §5.8), realtime ones URGENT too; bulk ones, and any
    // too large for a realtime slot, go BULK without ACK_REQ (TCP or serial only).
    uint8_t flags = kFlagBulk;
    if (prio != cap::Priority::bulk && len <= kRtSize) {
        flags = kFlagAckReq | (prio == cap::Priority::realtime ? kFlagUrgent : 0);
    }
    const bool q1 = (flags & kFlagAckReq) != 0;
    const uint8_t via = route(kClsEvent, event_id, flags, len);
    // No path to the hub, or (05 §5.11 "stale input") a Q1 event older than FR_EVENT_MAX_AGE_MS.
    if (via == 0 || (q1 && !exempt && now - t > ms_us(cfg_.event_max_age_ms))) {
        ++state_.events_dropped;
        return;
    }
    uint8_t prefix[kTimePrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_time_prefix(low32(t), pw);
    const uint32_t seq = ++seq_;
    auto env = build(flags, kClsEvent, event_id, seq, fr::proto::kAddrHub, port, pw.bytes(), fields);
    if (env.empty()) {
        ++state_.events_dropped;  // beyond the bulk MTU
        return;
    }
    const uint8_t took = transmit(via, env);
    if (q1) {
        track(env, seq, took, t, exempt);
    }
}

Net::Pending *Net::take_slot(bool evict)
{
    Pending *oldest = nullptr;
    for (Pending &p : outbox_) {
        if (!p.used) {
            return &p;
        }
        if (oldest == nullptr || p.sent < oldest->sent) {
            oldest = &p;
        }
    }
    if (!evict || oldest == nullptr) {
        return nullptr;
    }
    // Full: the newest input matters more than the oldest one still unconfirmed.
    if (!oldest->repeat) {
        ++state_.delivery_failed;
    }
    oldest->used = false;
    return oldest;
}

size_t Net::pending_count() const
{
    return static_cast<size_t>(std::count_if(outbox_.begin(), outbox_.end(), [](const Pending &p) { return p.used; }));
}

void Net::track(std::span<const uint8_t> envelope, uint32_t seq, uint8_t via, TimeUs at, bool exempt)
{
    if (envelope.size() > kRtSize) {
        return;  // Q1 frames are realtime-sized (send_event)
    }
    Pending *p = take_slot(true);
    const TimeUs now = core_.now();
    const bool udp = (via & kViaUdp) != 0;
    p->used = true;
    p->repeat = false;
    p->exempt = exempt;
    p->via = via;
    p->seq = seq;
    p->at = at;
    p->sent = now;
    // 05 §5.8: re-sent over UDP only (same seq); TCP and serial deliver or fail, after tcp_delivery_ms.
    p->attempts = udp ? 1 : 0;
    p->retry_at = udp ? now + backoff_us(1) : kNever;
    p->deadline = (via & (kViaTcp | kViaSerial)) != 0 ? now + ms_us(cfg_.tcp_delivery_ms) : kNever;
    p->len = static_cast<uint16_t>(envelope.size());
    std::memcpy(p->bytes, envelope.data(), envelope.size());
    queue_hwm_ = static_cast<uint8_t>(std::max<size_t>(queue_hwm_, pending_count()));
}

void Net::schedule_repeat(std::span<const uint8_t> envelope)
{
    // 05 §5.8 "Double send": UDP may lose the first copy; the hub drops the second by its LATEST seq.
    // A full outbox skips it (Q1 frames keep their slots).
    Pending *p = envelope.size() <= kRtSize ? take_slot(false) : nullptr;
    if (p == nullptr) {
        return;
    }
    const TimeUs now = core_.now();
    p->used = true;
    p->repeat = true;
    p->exempt = false;
    p->via = kViaUdp;
    p->seq = 0;
    p->at = now;
    p->sent = now;
    p->attempts = 0;
    p->retry_at = now + ms_us(kStateRepeatMs);
    p->deadline = kNever;
    p->len = static_cast<uint16_t>(envelope.size());
    std::memcpy(p->bytes, envelope.data(), envelope.size());
}

void Net::fail_pending(uint8_t via)
{
    for (Pending &p : outbox_) {
        if (p.used && (p.via & via) != 0) {
            if (!p.repeat) {
                ++state_.delivery_failed;
            }
            p.used = false;
        }
    }
}

void Net::service_pending(Pending &p, TimeUs now)
{
    const std::span<const uint8_t> env(p.bytes, p.len);
    if (p.repeat) {
        if (p.retry_at <= now) {
            // The second copy takes whatever path a STATE takes now (TCP if udp_ok was lost meanwhile).
            const uint8_t via = route(env[2], env[3], env[1], env.size());
            if (via != 0) {
                transmit(via, env);
            }
            p.used = false;
        }
        return;
    }
    if (p.retry_at <= now) {
        const bool stale = !p.exempt && now - p.at > ms_us(cfg_.event_max_age_ms);
        if (p.attempts < cfg_.max_attempts && !stale) {
            ++p.attempts;
            ++ls(LinkKind::udp).retries;
            transmit_on(LinkKind::udp, env);
            p.retry_at = now + backoff_us(p.attempts);
        } else {
            // Out of attempts, or too old to re-send as input (05 §5.11).
            if (stale) {
                ++state_.events_dropped;
            }
            p.retry_at = kNever;
            if (p.deadline == kNever) {  // UDP was its only path
                if (!stale) {
                    ++state_.delivery_failed;
                }
                p.used = false;
                return;
            }
        }
    }
    if (p.deadline <= now) {
        ++state_.delivery_failed;
        p.used = false;
    }
}

uint32_t Net::next_random()
{
    uint32_t x = rng_ != 0 ? rng_ : 0x9E3779B9u;  // xorshift32 must not start at 0
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    rng_ = x;
    return x;
}

uint32_t Net::jittered_us(uint32_t ms, uint32_t pct)
{
    // ms * (1000 +- 10 * pct) permille, in µs: uniform over the whole range.
    const uint32_t permille = 1000 - pct * 10 + next_random() % (pct * 20 + 1);
    return static_cast<uint32_t>(std::min<uint64_t>(uint64_t{ms} * permille, UINT32_MAX));
}

uint32_t Net::backoff_us(uint8_t attempt)
{
    // 05 §5.8: 20 ms after the first send, x2 per attempt, +-25 % (0 hops in router mode).
    const uint32_t shift = std::min<uint32_t>(attempt > 0 ? attempt - 1u : 0u, 16);
    const uint64_t ms = std::min<uint64_t>(uint64_t{cfg_.ack_base_ms} << shift, UINT32_MAX / 1250);
    return jittered_us(static_cast<uint32_t>(ms), 25);
}

}  // namespace fr::net
