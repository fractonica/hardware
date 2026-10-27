// fr:realtime
// fr_gw: the ESP-NOW <-> serial bridge (design m2-c4-gateway D8, D9). See fr/gw/bridge.hpp.
#include "fr/gw/bridge.hpp"

#include <algorithm>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/serial_line.hpp"
#include "fr/wire.hpp"

namespace fr::gw {

using proto::GwOp;
using proto::GwRate;
using proto::GwTxStatus;

namespace {

uint32_t us32(TimeUs d)
{
    return d <= 0 ? 0 : static_cast<uint32_t>(std::min<TimeUs>(d, UINT32_MAX));
}

/** A NET.BEACON envelope (D11): counted in GwStatus beacons once the radio takes it. */
bool is_beacon(std::span<const uint8_t> env)
{
    const auto h = wire::unpack_header(env);
    return h && h->cls == wire::kClsNet && h->kind == proto::kKindNetBeacon;
}

}  // namespace

Bridge::Bridge(Core &core, Air &air, Line &line, Indicator *light) : core_(core), air_(air), line_(line), light_(light) {}

bool Bridge::begin()
{
    status_timer_ = core_.timer([this] { on_status_tick(); });
    hub_timer_ = core_.timer([this] { on_hub_timeout(); });
    pump_timer_ = core_.timer([this] { pump(); });
    if (status_timer_ == nullptr || hub_timer_ == nullptr || pump_timer_ == nullptr) {
        return false;  // the bridge stays off: every entry point returns at once
    }
    on_ = true;
    status_timer_->start(kStatusPeriodUs);
    refresh_light();
    return true;
}

void Bridge::refresh_light()
{
    if (light_ != nullptr) {
        light_->show(hub_);
    }
}

void Bridge::reset_stats()
{
    stats_ = {};
    stats_.q_high = static_cast<uint32_t>(used_);
    refused_queue_full_.store(0, std::memory_order_relaxed);
    refused_too_big_.store(0, std::memory_order_relaxed);
}

void Bridge::refused(GwTxStatus st)
{
    (st == GwTxStatus::too_big ? refused_too_big_ : refused_queue_full_).fetch_add(1, std::memory_order_relaxed);
}

Stats Bridge::stats() const
{
    Stats s = stats_;
    const uint32_t qf = refused_queue_full_.load(std::memory_order_relaxed);
    const uint32_t tb = refused_too_big_.load(std::memory_order_relaxed);
    s.tx_queue_full += qf;
    s.tx_too_big += tb;
    s.tx_refused = qf + tb;
    s.tx_fail += qf + tb;
    return s;
}

bool Bridge::write(uint8_t type, std::span<const uint8_t> body)
{
    return line_.write_frame(type, body);
}

void Bridge::on_serial_frame(uint8_t type, std::span<const uint8_t> body, TimeUs at)
{
    if (!on_) {
        return;  // begin() failed: no bridge this boot
    }
    switch (type) {
    case wire::kSerialGwTx:
        on_tx(body, at);
        break;
    case wire::kSerialGwCmd:
        on_cmd(body);
        break;
    case wire::kSerialLinkPing:
        on_ping(body);
        break;
    default:
        ++stats_.rx_bad;  // GW_RX, GW_TX_DONE, GW_STATUS, GW_RSP, LINK_PONG go the other way
        break;
    }
}

// ---- hub -> air ----

void Bridge::on_tx(std::span<const uint8_t> body, TimeUs at)
{
    const auto tx = proto::decode_gw_tx(body);
    if (!tx) {
        ++stats_.rx_bad;
        return;
    }
    if (tx->env.size() > kEnvMax) {
        done(tx->tx_id, GwTxStatus::too_big, 0, 0, at);
        return;
    }
    if (!air_.up()) {
        done(tx->tx_id, GwTxStatus::radio_off, 0, 0, at);
        return;
    }
    if (used_ == kQueueDepth) {
        done(tx->tx_id, GwTxStatus::queue_full, 0, 0, at);
        return;
    }
    Entry *e = nullptr;
    for (Entry &c : q_) {
        if (c.slot == Slot::free) {
            e = &c;
            break;
        }
    }
    // b0-1 rate (3 is reserved: the peer's default); b2 no_retry asks for no re-send on a NAK, which the bridge never
    // does anyway (the driver's link retries are not per frame); b3-7 are ignored.
    const auto rate = static_cast<GwRate>(tx->tx_opts & static_cast<uint8_t>(proto::GwTxOpt::rate_mask));
    e->slot = Slot::waiting;
    e->tx_id = tx->tx_id;
    std::copy(tx->dst_mac.begin(), tx->dst_mac.end(), e->dst.begin());
    e->rate = proto::is_known(rate) && rate != GwRate::peer_default ? rate : default_rate_;
    e->beacon = is_beacon(tx->env);
    e->len = static_cast<uint16_t>(tx->env.size());
    std::memcpy(e->env, tx->env.data(), tx->env.size());
    e->order = next_order_++;
    e->token = 0;
    e->at = at;
    e->taken_at = 0;
    ++used_;
    stats_.q_high = std::max<uint32_t>(stats_.q_high, static_cast<uint32_t>(used_));
    pump();
}

void Bridge::pump()
{
    const TimeUs now = core_.now();
    for (;;) {
        Entry *head = nullptr;
        for (Entry &c : q_) {
            if (c.slot == Slot::waiting && (head == nullptr || static_cast<int32_t>(c.order - head->order) < 0)) {
                head = &c;
            }
        }
        if (head == nullptr) {
            pump_timer_->stop();
            return;
        }
        if (now - head->at > kStaleUs) {
            const uint16_t id = head->tx_id;
            const TimeUs at = head->at;
            free_entry(*head);
            done(id, GwTxStatus::stale, 0, us32(now - at), at);
            continue;
        }
        uint32_t token = next_token_++;
        if (token == 0) {
            token = next_token_++;
        }
        const Status st = air_.send(head->dst, {head->env, head->len}, head->rate, token);
        if (st) {
            head->slot = Slot::sent;
            head->token = token;
            head->taken_at = now;
            if (head->beacon) {
                ++stats_.beacons;
            }
            continue;
        }
        if (st.error() == Err::busy) {
            ++stats_.tx_busy;
            if (!pump_timer_->running()) {
                pump_timer_->start(kRetryUs);  // the radio's verdicts also pump; this covers Net's own sends
            }
            return;
        }
        const GwTxStatus verdict = st.error() == Err::not_found      ? GwTxStatus::no_peer
                                   : st.error() == Err::invalid_args ? GwTxStatus::too_big
                                                                     : GwTxStatus::radio_off;
        const uint16_t id = head->tx_id;
        const TimeUs at = head->at;
        free_entry(*head);
        done(id, verdict, 0, us32(now - at), at);
    }
}

void Bridge::on_air_sent(uint32_t token, bool ok, uint8_t retries, TimeUs queued_us)
{
    for (Entry &e : q_) {
        if (e.slot == Slot::sent && e.token == token) {
            const uint16_t id = e.tx_id;
            const TimeUs at = e.at;
            // The bridge's wait, then the driver's.
            const uint32_t waited = us32(e.taken_at - e.at + std::max<TimeUs>(queued_us, 0));
            free_entry(e);
            done(id, ok ? GwTxStatus::ok : GwTxStatus::nak, retries, waited, at);
            break;
        }
    }
    pump();  // a radio queue slot is free now
}

void Bridge::done(uint16_t tx_id, GwTxStatus st, uint8_t retries, uint32_t queued_us, TimeUs at)
{
    switch (st) {
    case GwTxStatus::ok:
        ++stats_.tx;
        break;
    case GwTxStatus::nak:
        ++stats_.tx_nak;
        break;
    case GwTxStatus::queue_full:
        ++stats_.tx_queue_full;
        break;
    case GwTxStatus::no_peer:
        ++stats_.tx_no_peer;
        break;
    case GwTxStatus::too_big:
        ++stats_.tx_too_big;
        break;
    case GwTxStatus::radio_off:
        ++stats_.tx_radio_off;
        break;
    case GwTxStatus::stale:
        ++stats_.tx_stale;
        break;
    }
    if (st == GwTxStatus::ok) {
        forwarded();
    } else {
        ++stats_.tx_fail;
    }
    stats_.last_tx_us = us32(core_.now() - at);
    if (tx_id == 0) {
        return;  // a broadcast the hub does not pace: no GW_TX_DONE (D1)
    }
    const proto::GwTxDone d{.tx_id = tx_id, .status = st, .link_retries = retries, .queued_us = queued_us};
    uint8_t buf[proto::GwTxDone::kMaxSize];
    wire::Writer w(buf, sizeof(buf));
    proto::encode(d, w);
    if (!write(proto::GwTxDone::kType, w.bytes())) {
        ++stats_.done_dropped;
    }
}

void Bridge::free_entry(Entry &e)
{
    e.slot = Slot::free;
    --used_;
}

// ---- air -> hub ----

void Bridge::on_air_frame(std::span<const uint8_t> env, const net::RxMeta &meta, TimeUs at)
{
    if (!on_) {
        return;
    }
    if (!hub_) {
        ++stats_.rx_drop;
        ++stats_.rx_no_hub;
        return;
    }
    if (env.size() > kRxEnvMax) {
        ++stats_.rx_drop;
        ++stats_.rx_too_big;
        return;
    }
    const proto::GwRx rx{.src_mac = meta.src_mac,
                         .rssi = meta.rssi,
                         .channel = meta.channel,
                         .rx_ts_us = static_cast<uint32_t>(at),  // the low 32 bits of the receive stamp
                         .env = env};
    wire::Writer w(out_, sizeof(out_));
    proto::encode(rx, w);
    if (w.overflow() || !write(proto::GwRx::kType, w.bytes())) {
        ++stats_.rx_drop;
        ++stats_.rx_line_full;
        return;
    }
    ++stats_.rx;
    forwarded();
}

void Bridge::forwarded()
{
    if (light_ != nullptr && hub_ && ++flash_count_ >= kFlashEvery) {
        flash_count_ = 0;
        light_->flash();
    }
}

// ---- link ----

void Bridge::on_ping(std::span<const uint8_t> body)
{
    const auto ping = proto::decode_link_ping(body);
    if (!ping) {
        ++stats_.rx_bad;
        return;
    }
    // At once (D8): the hub's RTT is the line's, not the queue's.
    uint8_t buf[proto::LinkPong::kMaxSize];
    wire::Writer w(buf, sizeof(buf));
    proto::encode(proto::LinkPong{.t = ping->t}, w);
    (void)write(proto::LinkPong::kType, w.bytes());
    ++stats_.pings;
    hub_timer_->start(kHubTimeoutUs);
    if (!hub_) {
        hub_ = true;
        refresh_light();
    }
}

void Bridge::on_hub_timeout()
{
    if (!hub_) {
        return;
    }
    hub_ = false;
    ++stats_.hub_lost;
    // No hub, no bridge (D8): what waits for the radio goes, without verdicts nobody reads. Sent ones keep their
    // slot until the radio's verdict.
    for (Entry &e : q_) {
        if (e.slot == Slot::waiting) {
            free_entry(e);
            ++stats_.tx_dropped;
        }
    }
    pump_timer_->stop();
    flash_count_ = 0;
    refresh_light();
}

// ---- status and commands ----

proto::GwStatus Bridge::status() const
{
    const AirInfo ai = air_.info();
    proto::GwStatus s;
    s.channel = ai.channel;
    s.mode = proto::NetMode::router;  // associated with the AP, whose channel it follows (D3, D8)
    s.uptime_s = static_cast<uint32_t>(core_.now() / 1'000'000);
    s.q_depth = static_cast<uint8_t>(used_);
    s.q_max = static_cast<uint8_t>(kQueueDepth);
    s.peers = ai.peers;
    const Stats st = stats();  // the serial reader's refusals in tx_fail too
    s.tx = st.tx;
    s.tx_fail = st.tx_fail;
    s.rx = stats_.rx;
    s.rx_drop = stats_.rx_drop;
    s.rx_bad = stats_.rx_bad;
    s.beacons = stats_.beacons;
    s.ap_rssi = ai.associated ? ai.ap_rssi : 0;
    s.ap_channel = ai.associated ? ai.ap_channel : 0;
    s.last_tx_us = stats_.last_tx_us;
    return s;
}

void Bridge::on_status_tick()
{
    status_timer_->start(kStatusPeriodUs);
    // A verdict the driver never delivered must not hold a slot for good.
    const TimeUs now = core_.now();
    for (Entry &e : q_) {
        if (e.slot == Slot::sent && now - e.taken_at > kVerdictMaxUs) {
            const uint16_t id = e.tx_id;
            const TimeUs at = e.at;
            const uint32_t waited = us32(e.taken_at - at);
            free_entry(e);
            done(id, GwTxStatus::nak, 0, waited, at);
        }
    }
    uint8_t buf[proto::GwStatus::kMaxSize];
    wire::Writer w(buf, sizeof(buf));
    proto::encode(status(), w);
    (void)write(wire::kSerialGwStatus, w.bytes());
}

void Bridge::on_cmd(std::span<const uint8_t> body)
{
    const auto cmd = proto::decode_gw_cmd(body);
    if (!cmd) {
        ++stats_.rx_bad;
        return;
    }
    Status st;
    switch (cmd->op) {
    case GwOp::set_channel:
        // The AP owns the channel while the STA is associated (router mode, D8). Unassociated, the STA's own scan
        // moves the radio anyway: channel ownership is C6's.
        st = std::unexpected(air_.info().associated ? Err::busy : Err::unsupported);
        break;
    case GwOp::set_rate:
        if (proto::is_known(cmd->rate)) {
            default_rate_ = cmd->rate;
        } else {
            st = std::unexpected(Err::invalid_args);
        }
        break;
    case GwOp::peer_flush:
        st = air_.peer_flush();
        break;
    case GwOp::info:
        break;
    case GwOp::set_net:
        st = std::unexpected(Err::unsupported);  // the net is the gateway's provisioning (C6)
        break;
    case GwOp::none:
        st = std::unexpected(Err::invalid_args);
        break;
    default:
        st = std::unexpected(Err::unsupported);  // an op of a newer hub
        break;
    }
    const AirInfo ai = air_.info();
    const proto::GwRsp rsp{.req = cmd->req,
                           .status = wire_status(st),
                           .channel = ai.channel,
                           .net = ai.net,
                           .rate = default_rate_,
                           .peers = ai.peers};
    uint8_t buf[proto::GwRsp::kMaxSize];
    wire::Writer w(buf, sizeof(buf));
    proto::encode(rsp, w);
    (void)write(wire::kSerialGwRsp, w.bytes());
    ++stats_.cmds;
}

}  // namespace fr::gw
