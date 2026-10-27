// fr:realtime
// fr_net core, M2-C4 (design m2-c4-gateway D8, D10-D12): the gateway session and a gateway's bridge.
//
// The node side: BEACONs (hub -> GW_TX broadcast, 1 Hz) keep a small table of the gateways heard, each with its RSSI
// and age, and a gateway missing 3 beacons goes. The chosen gateway (kept while it lives, else the strongest live one)
// is what Net's GatewayLink sends to, by ESP-NOW unicast, and what the hub's frames come from; the session itself is
// net.cpp's, as TCP's is, with D12's rules on top: HELLO only while no TCP session is up and the open rule holds (not
// associated, or associated 10 s without a WELCOMEd TCP session, or TCP gone 5 s; update_gateway_gate, hello_allowed),
// and the session closes with a BYE over it once a TCP session has been WELCOMEd for kGatewayCloseMs
// (service_gateway), or with its gateway.
//
// The gateway side (role gateway, fr_gw): the AirTap sees every air frame first (air.cpp), and air_send_raw puts the
// hub's GW_TX bytes on the air through the driver's scheduler, its end reported to the tap with the caller's token.
// Everything runs on the core task; no heap.
#include <algorithm>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "net_util.hpp"

namespace fr::net {

using namespace fr::wire;
using namespace util;

static_assert(static_cast<uint8_t>(AirRate::peer_default) == static_cast<uint8_t>(fr::proto::GwRate::peer_default) &&
                  static_cast<uint8_t>(AirRate::robust) == static_cast<uint8_t>(fr::proto::GwRate::robust) &&
                  static_cast<uint8_t>(AirRate::fast) == static_cast<uint8_t>(fr::proto::GwRate::fast),
              "AirRate takes GW_TX's GwRate values as they are");

namespace {

/** The driver queue a frame waits in (design c5 §3): URGENT frames, and the answers a request waits for, first. */
AirPrio prio_of(std::span<const uint8_t> envelope)
{
    if (envelope.size() < kHeaderSize) {
        return AirPrio::normal;
    }
    const uint8_t flags = envelope[kOffFlags];
    const uint8_t cls = envelope[kOffCls];
    return (flags & kFlagUrgent) != 0 || cls == kClsResult || cls == kClsAck ? AirPrio::urgent : AirPrio::normal;
}

/** A gateway is lost this long after its newest BEACON: 3 missed, plus half an interval. */
TimeUs lost_after_us(uint32_t interval_ms)
{
    return ms_us(interval_ms) * Net::kGatewayLostX10 / 10;
}

}  // namespace

// ---- the node's gateway session ----

bool Net::gateway_up() const
{
    return air_up() && gw_ >= 0 && !gateway_ && provisioned();
}

Status Net::gateway_send(std::span<const uint8_t> envelope)
{
    if (!gateway_up()) {
        return std::unexpected(Err::failed);
    }
    return air_send(gateways_[static_cast<size_t>(gw_)].mac, envelope, prio_of(envelope), kTokenGateway | next_token());
}

void Net::on_beacon(const EnvelopeView &e, const RxMeta &meta)
{
    LinkState &s = ls(LinkKind::espnow);
    auto b = fr::proto::decode_net_beacon(e.body);
    if (!b || gateway_) {
        ++s.rx_drop;  // undecodable; or this node is a gateway, which forwards BEACONs and never uses one
        return;
    }
    // gw_mac names the gateway the hub sent it through; a copy from any other radio (a relay, a stray) is no gateway
    // this node can reach by unicast. Without gw_mac the radio sender is the gateway.
    const Mac &mac = meta.src_mac;
    if (!b->gw_mac.empty() &&
        (b->gw_mac.size() != mac.size() || !std::equal(b->gw_mac.begin(), b->gw_mac.end(), mac.begin()))) {
        ++s.rx_drop;
        return;
    }
    ++state_.gateway.beacons;
    const TimeUs now = core_.now();
    update_gateway_gate(now);  // the association's clock starts by the first BEACON at the latest
    GatewaySeen *g = nullptr;
    for (GatewaySeen &x : gateways_) {
        if (x.used && x.mac == mac) {
            g = &x;
            break;
        }
    }
    if (g == nullptr) {
        // A new gateway: a free slot, else the one heard longest ago other than the chosen one.
        for (size_t i = 0; i < gateways_.size(); ++i) {
            GatewaySeen &x = gateways_[i];
            if (!x.used) {
                g = &x;
                break;
            }
            if (static_cast<int>(i) != gw_ && (g == nullptr || x.heard < g->heard)) {
                g = &x;
            }
        }
        *g = GatewaySeen{.used = true, .mac = mac};
    }
    g->rssi = meta.rssi;
    g->heard = now;
    g->interval_ms = b->beacon_interval_ms != 0 ? b->beacon_interval_ms : kBeaconDefaultMs;
    if (gw_ < 0) {
        gw_ = static_cast<int>(g - gateways_.data());
        update_gateway_link(true);
    } else if (!gw_pinned_ && g == &gateways_[static_cast<size_t>(gw_)]) {
        pin_gateway();  // the driver refused its entry before: again at each of its BEACONs
    }
}

void Net::pin_gateway()
{
    if (air_ == nullptr) {
        return;
    }
    if (gw_ < 0) {
        static_cast<void>(air_->pin_peer(nullptr));
        gw_pinned_ = false;
        return;
    }
    gw_pinned_ = air_->pin_peer(&gateways_[static_cast<size_t>(gw_)].mac);
}

void Net::deliver_gateway(std::span<const uint8_t> envelope, const RxMeta &meta)
{
    // As receive() for a link task's envelope (design c6 D23): the driver's stamp is when the frame arrived, so TIME t2,
    // the keepalive and expire_at count from there.
    ++ls(LinkKind::gateway).rx;
    const TimeUs now = core_.now();
    rx_at_ = meta.rx_at > 0 ? std::min(meta.rx_at, now) : now;
    state_.rx_queue_us_max = std::max(state_.rx_queue_us_max, static_cast<uint32_t>(std::clamp<TimeUs>(
                                                                  now - rx_at_, 0, UINT32_MAX)));
    handle(LinkKind::gateway, envelope);
}

void Net::expire_gateways(TimeUs now)
{
    bool chosen_lost = false;
    for (size_t i = 0; i < gateways_.size(); ++i) {
        GatewaySeen &g = gateways_[i];
        if (g.used && now - g.heard >= lost_after_us(g.interval_ms)) {
            g.used = false;
            ++state_.gateway.lost;
            chosen_lost = chosen_lost || static_cast<int>(i) == gw_;
        }
    }
    if (!chosen_lost) {
        return;
    }
    // The strongest of the live ones, if any (D11: no discovery sweep at C4).
    gw_ = -1;
    for (size_t i = 0; i < gateways_.size(); ++i) {
        if (gateways_[i].used && (gw_ < 0 || gateways_[i].rssi > gateways_[static_cast<size_t>(gw_)].rssi)) {
            gw_ = static_cast<int>(i);
        }
    }
    update_gateway_link(true);
}

void Net::update_gateway_link(bool rechosen)
{
    if (link(LinkKind::gateway) == nullptr) {
        return;  // attach_air() not called yet
    }
    LinkState &s = ls(LinkKind::gateway);
    if (rechosen) {
        pin_gateway();  // design m2-c4-gateway D10: its peer entry outside the LRU, the old one's released
    }
    if (rechosen && s.session) {
        // Another gateway, or none: the hub's endpoint was the old gateway's (D14), so the session ends with it.
        end_session(LinkKind::gateway, true);
        sess(LinkKind::gateway).hello_due = core_.now();
    }
    if (gateway_up() != s.up) {
        update_gateway_gate(core_.now());
        link_changed(LinkKind::gateway);  // up: HELLO (when allowed); down: the session ends
    }
}

void Net::update_gateway_gate(TimeUs now)
{
    // Associated means joined to the AP, an address or not yet: DHCP and the hub's TCP connect follow within seconds.
    const LinkInfo li = host_.link_info();
    const bool assoc = li.wifi_up || li.channel != 0;
    if (assoc && !gw_assoc_) {
        gw_wait_from_ = now;
        gw_wait_ms_ = kGatewayAssocWaitMs;
    }
    gw_assoc_ = assoc;
    gw_gate_ = !assoc || now - gw_wait_from_ >= ms_us(gw_wait_ms_);
    gw_poll_due_ = now + ms_us(kGatewayPollMs);
}

void Net::gateway_tcp_ended(TimeUs now)
{
    update_gateway_gate(now);
    if (gw_assoc_) {
        // A TCP session ended while the STA stays joined: TCP may well come back (a hub restart, a reconnect), so the
        // gateway waits kGatewayTcpGoneMs for it, never longer than the association rule would.
        gw_wait_from_ = now;
        gw_wait_ms_ = kGatewayTcpGoneMs;
        gw_gate_ = false;
    }
}

void Net::service_gateway(TimeUs now)
{
    expire_gateways(now);
    const LinkState &g = ls(LinkKind::gateway);
    if (g.up && !g.session && !ls(LinkKind::tcp).session) {
        update_gateway_gate(now);  // D12's open rule: the HELLO loop after this reads gw_gate_
    }
    // D12: TCP back and WELCOMEd for kGatewayCloseMs: the gateway session closes with a BYE over it alone (a BYE over a
    // gateway ends that session at the hub, D14; the TCP session stays), and HELLO waits for the open rule again.
    if (g.session && ls(LinkKind::tcp).session && now - tcp_since_ >= ms_us(kGatewayCloseMs)) {
        send_bye(kByeGatewayClose, kViaGateway);
        end_session(LinkKind::gateway, false);
        sess(LinkKind::gateway).hello_due = now;
        ++state_.gateway.closed;
    }
}

void Net::gateway_state(GatewayStats &st) const
{
    st.chosen = gw_ >= 0;
    st.live = static_cast<uint8_t>(
        std::count_if(gateways_.begin(), gateways_.end(), [](const GatewaySeen &x) { return x.used; }));
    if (gw_ >= 0) {
        const GatewaySeen &c = gateways_[static_cast<size_t>(gw_)];
        st.mac = c.mac;
        st.rssi = c.rssi;
        st.heard_at = c.heard;
    }
}

TimeUs Net::next_gateway_due() const
{
    TimeUs next = kNever;
    for (const GatewaySeen &g : gateways_) {
        if (g.used) {
            next = std::min(next, g.heard + lost_after_us(g.interval_ms));
        }
    }
    const LinkState &g = ls(LinkKind::gateway);
    if (g.session && ls(LinkKind::tcp).session) {
        next = std::min(next, tcp_since_ + ms_us(kGatewayCloseMs));
    }
    if (g.up && !g.session && !ls(LinkKind::tcp).session && !gw_gate_) {
        // D12's open rule holds the HELLO back: its wait's end, and a look at the association meanwhile.
        next = std::min({next, gw_wait_from_ + ms_us(gw_wait_ms_), gw_poll_due_});
    }
    return next;
}

// ---- a gateway's bridge ----

Status Net::air_send_raw(const uint8_t (&mac)[6], std::span<const uint8_t> env, uint8_t rate, uint32_t token)
{
    if (env.empty() || env.size() > kRtSize || rate > static_cast<uint8_t>(AirRate::fast)) {
        return std::unexpected(Err::invalid_args);
    }
    if (!air_up()) {
        ++ls(LinkKind::espnow).tx_fail;
        return std::unexpected(Err::failed);
    }
    auto slot = std::find_if(raw_.begin(), raw_.end(), [](const RawSend &r) { return !r.used; });
    if (slot == raw_.end()) {
        return std::unexpected(Err::busy);  // the driver's queue holds no more anyway
    }
    Mac dst;
    std::copy(mac, mac + dst.size(), dst.begin());
    const uint32_t own = kTokenRaw | next_token();
    LinkState &s = ls(LinkKind::espnow);
    const Status st = air_->send_at(dst, env, prio_of(env), own, static_cast<AirRate>(rate));
    if (!st) {
        ++s.tx_fail;
        if (st.error() == Err::busy && air_->refused_no_peer()) {
            return std::unexpected(Err::not_found);  // GW_TX_DONE no_peer, not queue_full
        }
        return st;
    }
    ++s.tx;
    *slot = RawSend{.used = true, .token = own, .tap_token = token};
    return {};
}

void Net::raw_sent(uint32_t token, bool ok)
{
    for (RawSend &r : raw_) {
        if (r.used && r.token == token) {
            r.used = false;
            const AirDone d = air_ != nullptr ? air_->done_info(token) : AirDone{};
            if (tap_ != nullptr) {
                tap_->on_air_sent(r.tap_token, ok, d.retries, d.queued_us);
            }
            return;
        }
    }
}

}  // namespace fr::net
