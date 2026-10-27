// fr:realtime
// fr_net core, C5 (design c5 §3, spec 05 §5.8-5.10): the ESP-NOW side of Net. A frame from AirLink passes
// the receive filter (net, own frames, TTL), teaches the neighbour table when it came straight from its
// origin, goes through the window of its source (node frames per (src, epoch); hub broadcasts through the
// hub BCAST window, shared with the hub link's copy) and is delivered and relayed by the managed-flooding
// rules of 05 §5.9. Relays wait on Net's one timer (tick) for their jitter; K copies heard over the air
// meanwhile cancel them (a hub link's copy never counts). Also here: the per-source flood rate, the
// router-mode ESP-NOW heartbeat, the directory (NET/DIRECTORY pages, RESOLVE, DirectoryStore) and the
// completion of air sends. Everything runs on the core task; no heap.
//
// M2-C2 (design m2-c2 D17, D19): a flood the driver refuses gives its flood-rate token back (here for relays and
// seeds, in peer.cpp for the node's own floods), and while no session is up a newer hub run heard over the air is
// adopted (adopt_hub_run) instead of waiting for the next WELCOME.
#include <algorithm>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "net_util.hpp"

namespace fr::net {

using namespace fr::wire;
using namespace util;

namespace {

/**
 * 05 §5.9 rssi_bias (design c5 §8.2): a strong signal waits longer, so the neighbours farther from the
 * sender, whose relays reach more nodes that have not heard it, go first and the near ones cancel.
 * -30 dBm -> +8 ms, -90 dBm -> +0, linear in between and clamped outside.
 */
constexpr uint32_t rssi_bias_us(int8_t rssi)
{
    const int32_t r = std::clamp<int32_t>(rssi, -90, -30);
    return static_cast<uint32_t>((r + 90) * 8000 / 60);
}

static_assert(rssi_bias_us(-30) == 8000 && rssi_bias_us(-90) == 0 && rssi_bias_us(-60) == 4000);
static_assert(rssi_bias_us(-10) == 8000 && rssi_bias_us(-100) == 0);

bool same_directory(const Directory &a, const Directory &b)
{
    if (a.count != b.count) {
        return false;
    }
    for (size_t i = 0; i < a.count && i < kDirectoryMax; ++i) {
        if (a.entries[i].addr != b.entries[i].addr || a.entries[i].mac != b.entries[i].mac) {
            return false;
        }
    }
    return true;
}

}  // namespace

// ---- the driver ----

void Net::ensure_timer()
{
    if (timer_ == nullptr) {
        timer_ = core_.timer([this] { on_timer(); });
    }
}

void Net::refresh_identity()
{
    // ESP-NOW needs the node's addr, net and epoch with no hub session at all (bindings with the hub
    // stopped), so it reads them itself instead of waiting for the first HELLO.
    const Identity id = host_.identity();
    net_ = id.net;
    addr_ = id.addr;
    epoch_ = id.epoch;
    const HelloInfo hi = host_.hello_info();
    gateway_ = hi.role == fr::proto::Role::gateway;
    seed_rng(hi.mac);
}

void Net::attach_air(AirLink &air)
{
    ensure_timer();
    air_ = &air;
    LinkState &s = ls(LinkKind::espnow);
    s.attached = true;
    s.up = false;
    refresh_identity();
    link_changed(LinkKind::espnow);  // up as AirLink says; the heartbeat starts with it
}

uint32_t Net::next_token()
{
    if (++air_token_ == 0) {
        ++air_token_;  // 0 never names a send
    }
    return air_token_;
}

Status Net::air_send(const Mac &dst, std::span<const uint8_t> envelope, AirPrio prio, uint32_t token)
{
    LinkState &s = ls(LinkKind::espnow);
    if (!air_up()) {
        ++s.tx_fail;
        return std::unexpected(Err::failed);
    }
    const Status st = air_->send(dst, envelope, prio, token);
    if (st) {
        ++s.tx;
    } else {
        ++s.tx_fail;
    }
    return st;
}

void Net::air_sent(uint32_t token, bool mac_acked)
{
    if (!mac_acked) {
        ++ls(LinkKind::espnow).tx_fail;  // a unicast without its MAC ACK after the link retries
    }
    for (NodeOut &o : node_out_) {
        if (!o.used || !o.in_air || o.token != token) {
            continue;
        }
        o.in_air = false;
        o.air_deadline = kNever;
        if (Neighbor *n = neighbor_of(o.mac)) {
            // 05 §5.10: the MAC ACK refreshes the neighbour like a frame heard from it.
            if (mac_acked) {
                ++n->ack_ok;
                n->last_heard = core_.now();
            } else {
                ++n->ack_fail;
            }
        }
        if (!mac_acked) {
            out_fallback(o);  // via the hub, else a flooded unicast (05 §5.10)
        } else {
            if (!o.answer) {
                ++state_.nodes.via_espnow;
            }
            if (!o.reliable) {
                out_finish(o, fr::proto::kStatusOk, 0);
            }
            // A reliable frame now waits for its RESULT/ACK, or for the retry timer set when it was sent.
        }
        break;
    }
    flush_fired();
    arm();
}

// ---- receive ----

void Net::receive_air(std::span<const uint8_t> envelope, const RxMeta &meta)
{
    ++ls(LinkKind::espnow).rx;
    rx_at_ = core_.now();
    in_receive_ = true;
    handle_air(envelope, meta);
    in_receive_ = false;
    run_deferred();
    flush_fired();
    arm();
}

void Net::handle_air(std::span<const uint8_t> envelope, const RxMeta &meta)
{
    LinkState &s = ls(LinkKind::espnow);
    // An unprovisioned node has no net to filter on and no addr to be reached at: it stays out of the
    // ESP-NOW network (adoption over the link is M2).
    if (air_ == nullptr || !provisioned() || envelope.size() > kRtSize) {
        ++s.rx_drop;
        return;
    }
    auto e = unpack_envelope(envelope);
    if (!e) {
        ++s.rx_drop;
        return;
    }
    const Header &h = e->header;
    const uint8_t initial = ttl_initial(h.ttl);
    const uint8_t remaining = ttl_remaining(h.ttl);
    // Receive filter (05 §5.3; the driver checked the channel): this net, not this node's own frame coming
    // back through a relay, a TTL within FR_TTL_MAX, never BULK (which never goes on the air).
    if (h.net != net_ || h.src == addr_ || (h.flags & kFlagBulk) != 0 || initial > cfg_.ttl_max ||
        remaining > initial) {
        ++s.rx_drop;
        return;
    }
    if (h.src == fr::proto::kAddrHub) {
        on_hub_air(*e, envelope, meta);
        return;
    }
    if (!is_node_addr(h.src)) {
        ++s.rx_drop;  // an UNASSIGNED sender, or a group/broadcast src no node has
        return;
    }
    // 05 §5.10: only a frame straight from its origin says who is in radio range; a relayed one carries
    // the relay's MAC. DUPs count too: hearing a neighbour again is news even when its frame is not.
    if ((h.flags & kFlagRelayed) == 0 && remaining == initial) {
        learn_neighbor(meta, h.src);
    }
    on_node_frame(LinkKind::espnow, *e, envelope, &meta);
}

void Net::on_hub_air(const EnvelopeView &e, std::span<const uint8_t> envelope, const RxMeta &meta)
{
    const Header &h = e.header;
    LinkState &s = ls(LinkKind::espnow);
    // Over ESP-NOW the hub reaches nodes only through the floods its broadcasts seed (router mode; the
    // gateway's unicasts are M2). Never ACKed, never LATEST.
    if (!meta.to_broadcast || !is_flood_dst(h.dst) || (h.flags & (kFlagLatest | kFlagAckReq)) != 0) {
        ++s.rx_drop;
        return;
    }
    // The hub BCAST window of the hub run this node follows, so the hub link's copy and the air copies of one
    // broadcast dedup together, also once the session has ended (T-FLOOD-B: Wi-Fi down). Epoch 0 is no hub run.
    if (h.epoch == 0 || h.epoch != state_.hub_epoch) {
        // Design m2-c2 D19: with no session up, a newer run heard over the air is the hub restarted during a
        // router outage (its USB nodes seed it), so it is adopted instead of waiting for the next WELCOME. A
        // node with no run yet (none this boot) takes the first it hears: a stale one is overtaken by the next
        // newer frame. With a session up, the session's run is authoritative.
        const bool newer = state_.hub_epoch == 0 || epoch_after(h.epoch, state_.hub_epoch);
        if (h.epoch == 0 || state_.hub_link() || !newer) {
            ++state_.bcast.old;
            ++s.rx_drop;
            return;
        }
        adopt_hub_run(h.epoch, h.seq);
    }
    switch (bcast_.check_and_set(h.seq)) {
    case Verdict::old:
        ++state_.bcast.old;
        return;
    case Verdict::dup:
        ++state_.bcast.dup;
        flood_copy(h.src, h.epoch, h.seq, false);
        return;
    case Verdict::fresh:
        break;
    }
    if (h.dst == fr::proto::kAddrBroadcast) {
        ++state_.bcast.delivered;
        if (h.cls == kClsMsg) {
            deliver_msg(h.src, e.body);
        } else if (h.cls == kClsCmd) {
            on_cmd(e, false, LinkKind::espnow);  // port 0 only, never answered (05 §5.8)
        }
    }
    flood_relay(envelope, h, false, &meta);
}

void Net::on_node_frame(LinkKind from, const EnvelopeView &e, std::span<const uint8_t> envelope, const RxMeta *meta)
{
    const Header &h = e.header;
    const bool latest = (h.flags & kFlagLatest) != 0;
    // The origin's MAC when it sent this copy itself: its answer then goes straight back by unicast.
    const Mac *src_mac = meta != nullptr && (h.flags & kFlagRelayed) == 0 ? &meta->src_mac : nullptr;
    const Verdict v = node_window(h);
    if (v == Verdict::old) {
        ++state_.nodes.old;
        return;
    }
    if (v == Verdict::dup) {
        ++state_.nodes.dup;
        if (meta != nullptr) {
            flood_copy(h.src, h.epoch, h.seq, latest);  // only a copy heard over the air counts toward K
        }
        // 05 §5.9: a DUP request to this node means its answer was lost: the cached RESULT again (the
        // command is not run twice), or a fresh ACK, which is idempotent.
        if (h.dst == addr_ && (h.flags & kFlagAckReq) != 0) {
            if (h.cls == kClsCmd) {
                resend_cached_node(h.src, h.epoch, h.seq, src_mac);
            } else if (h.cls == kClsEvent || h.cls == kClsMsg) {
                send_node_ack(h, src_mac);
            }
        }
        return;
    }
    const bool unicast = h.dst == addr_;
    if (unicast || h.dst == fr::proto::kAddrBroadcast) {
        ++state_.nodes.delivered;
        switch (h.cls) {
        case kClsCmd:
            on_node_cmd(from, e, unicast, src_mac);
            break;
        case kClsMsg:
            deliver_msg(h.src, e.body);
            [[fallthrough]];
        case kClsEvent:
            if (unicast && (h.flags & kFlagAckReq) != 0) {
                send_node_ack(h, src_mac);
            }
            break;
        case kClsResult:
        case kClsAck:
            if (unicast) {
                on_node_answer(e);
            }
            break;
        case kClsPresence:
            // The router-mode ESP-NOW heartbeat: learn_neighbor took who sent it. Its wifi_up bit says that
            // neighbour is associated, so the AP is on this channel (05 §5.4: no sweep while one is heard).
            if (meta != nullptr && h.kind == fr::proto::kKindPresenceHeartbeat) {
                const auto hb = fr::proto::decode_presence_heartbeat(e.body);
                if (hb && (hb->state & kStateWifiUp) != 0) {
                    wifi_up_heard_at_ = core_.now();
                }
            }
            break;
        default:
            break;
        }
    } else if (meta != nullptr && !meta->to_broadcast) {
        ++ls(from).rx_drop;  // sent to this node's MAC for another addr: the sender's directory is stale
        return;
    }
    flood_relay(envelope, h, false, meta);
}

Net::Verdict Net::node_window(const Header &h)
{
    Source *found = nullptr;
    Source *free_slot = nullptr;
    Source *lru = nullptr;
    for (Source &s : sources_) {
        if (!s.used) {
            free_slot = free_slot != nullptr ? free_slot : &s;
        } else if (s.src == h.src) {
            found = &s;
            break;
        } else if (lru == nullptr || s.stamp < lru->stamp) {
            lru = &s;
        }
    }
    if (found != nullptr) {
        // 05 §5.8 window rules: an older boot of that node is dropped, a newer one starts afresh.
        if (epoch_after(found->epoch, h.epoch)) {
            return Verdict::old;
        }
        if (epoch_after(h.epoch, found->epoch)) {
            found->epoch = h.epoch;
            found->primed = false;
            found->new_boot = true;
            found->latest.clear();
        }
    } else {
        // A new source, or one forgotten for 64 others (LRU): nothing says what of it was seen before.
        found = free_slot != nullptr ? free_slot : lru;
        *found = Source{};
        found->used = true;
        found->src = h.src;
        found->epoch = h.epoch;
    }
    found->stamp = ++source_clock_;
    if ((h.flags & kFlagLatest) != 0) {
        return found->latest.accept(h.port, h.kind, h.seq) ? Verdict::fresh : Verdict::old;
    }
    if (!found->primed) {
        found->primed = true;
        if (found->new_boot) {
            // A newer boot of a source this node follows: none of that boot's seqs reached it yet, so an
            // earlier one overtaken by this frame (a hub path against a direct one) is still delivered.
            found->new_boot = false;
            found->win.restart(h.seq - 1);
            found->floor = h.seq - 1 - static_cast<uint32_t>(kWindowBits);  // nothing in the window presumed
        } else {
            // Its history starts at this frame: everything below counts as received, so a late relay of an
            // older frame is never delivered twice.
            found->win.reset(h.seq - 1);
            found->floor = h.seq - 1;
        }
    }
    const Verdict v = found->win.check_and_set(h.seq);
    // Seqs at or below the floor were only presumed received: OLD, not DUP, so a reordered reliable frame
    // gets no ACK (or cached RESULT) for a delivery that never happened, and its sender ends FAILED.
    if (v == Verdict::dup && !seq_after(h.seq, found->floor)) {
        return Verdict::old;
    }
    return v;
}

// ---- neighbours and the directory ----

Neighbor *Net::neighbor_of(const Mac &mac)
{
    for (size_t i = 0; i < neighbors_.count; ++i) {
        if (neighbors_.items[i].mac == mac) {
            return &neighbors_.items[i];
        }
    }
    return nullptr;
}

void Net::learn_neighbor(const RxMeta &meta, uint16_t addr)
{
    Neighbor *n = neighbor_of(meta.src_mac);
    if (n == nullptr) {
        if (neighbors_.count < kNeighborsMax) {
            n = &neighbors_.items[neighbors_.count++];
        } else {
            n = &*std::min_element(neighbors_.items.begin(), neighbors_.items.end(),
                                   [](const Neighbor &a, const Neighbor &b) { return a.last_heard < b.last_heard; });
        }
        *n = Neighbor{.mac = meta.src_mac};
    }
    n->addr = addr;
    n->rssi = meta.rssi;
    n->last_heard = core_.now();
}

bool Net::mac_of(uint16_t addr, Mac &out) const
{
    if (const DirEntry *d = directory_.find(addr)) {
        out = d->mac;
        return true;
    }
    // A neighbour heard straight from its origin also names its MAC (device_id = STA MAC, 06 §6.3).
    const Neighbor *best = nullptr;
    for (size_t i = 0; i < neighbors_.count; ++i) {
        const Neighbor &n = neighbors_.items[i];
        if (n.addr == addr && (best == nullptr || n.last_heard > best->last_heard)) {
            best = &n;
        }
    }
    if (best == nullptr) {
        return false;
    }
    out = best->mac;
    return true;
}

void Net::on_directory(std::span<const uint8_t> body)
{
    auto d = fr::proto::decode_net_directory(body);
    if (!d || d->pages == 0 || d->page >= d->pages) {
        return;
    }
    // The hub's sets always list this node itself, so a lone page 0 of 1 holding one other addr, or nothing,
    // can only answer a RESOLVE (05 §5.7): its entry joins the table instead of replacing it (the node asked
    // about an addr beyond what it keeps), an empty page says "unknown". Classified by content, not by what
    // is outstanding, so a late, repeated or superseded answer neither wipes the table nor resets a set
    // being staged.
    const bool lone = d->page == 0 && d->pages == 1 && d->entries.size() <= 1;
    if (lone && (d->entries.empty() || d->entries[0].addr != addr_)) {
        if (!d->entries.empty()) {
            merge_resolved(d->entries[0]);
        }
        return;
    }
    // A set of pages replaces the table once all of it arrived: page 0 starts a set, a page of another
    // set (a registry change mid-set) waits for the next page 0.
    const uint8_t pages = std::min<uint8_t>(d->pages, 32);
    if (d->page == 0) {
        dir_staging_ = Directory{};
        dir_pages_ = pages;
        dir_seen_ = 0;
        dir_self_ = false;
    } else if (dir_pages_ == 0 || pages != dir_pages_ || d->page >= pages) {
        return;
    }
    for (const fr::proto::DirectoryEntry &x : d->entries) {
        dir_self_ = dir_self_ || x.addr == addr_;
        if (!is_node_addr(x.addr) || x.mac.size() != 6 || dir_staging_.count >= kDirectoryMax ||
            dir_staging_.find(x.addr) != nullptr) {
            continue;  // beyond FR_DIRECTORY_MAX the node RESOLVEs
        }
        DirEntry &out = dir_staging_.entries[dir_staging_.count++];
        out.addr = x.addr;
        std::copy(x.mac.begin(), x.mac.end(), out.mac.begin());
    }
    dir_seen_ |= 1u << d->page;
    const uint32_t all = pages >= 32 ? UINT32_MAX : (1u << pages) - 1;
    if (dir_seen_ != all) {
        return;
    }
    dir_pages_ = 0;
    // Only a set holding this node is the hub's whole directory; anything else must not replace it.
    // Every WELCOME and registry change brings the whole set: only a change is written (NVS wear).
    if (dir_self_ && !same_directory(directory_, dir_staging_)) {
        directory_ = dir_staging_;
        if (directory_store_ != nullptr) {
            directory_store_->save(directory_);
        }
    }
}

void Net::merge_resolved(const fr::proto::DirectoryEntry &x)
{
    if (!is_node_addr(x.addr) || x.mac.size() != 6) {
        return;
    }
    for (Resolving &r : resolving_) {
        if (r.addr == x.addr) {
            r = Resolving{};  // answered: its slot is free for the next addr
        }
    }
    Mac mac{};
    std::copy(x.mac.begin(), x.mac.end(), mac.begin());
    const auto end = directory_.entries.begin() + static_cast<std::ptrdiff_t>(directory_.count);
    auto it = std::find_if(directory_.entries.begin(), end, [&](const DirEntry &e) { return e.addr == x.addr; });
    if (it != end && it->mac == mac) {
        return;
    }
    if (it == end) {
        // Full: the newest answer takes the last slot (the hub's full pages refill the table anyway).
        it = directory_.count < kDirectoryMax ? directory_.entries.begin() + static_cast<std::ptrdiff_t>(directory_.count++)
                                              : directory_.entries.end() - 1;
    }
    *it = DirEntry{.addr = x.addr, .mac = mac};
    if (directory_store_ != nullptr) {
        directory_store_->save(directory_);
    }
}

void Net::resolve(uint16_t addr)
{
    const TimeUs now = core_.now();
    // Once per kResolveRetryMs per addr (design c5 §7), for the last few addrs asked about: sends to two
    // unknown addrs in turn each ask once, not at every send.
    Resolving *slot = &resolving_[0];
    for (Resolving &r : resolving_) {
        if (r.addr == addr) {
            if (now - r.at < ms_us(kResolveRetryMs)) {
                return;
            }
            slot = &r;
            break;
        }
        if (slot->addr != 0 && (r.addr == 0 || r.at < slot->at)) {
            slot = &r;  // a free entry, else the one asked longest ago
        }
    }
    uint8_t body[fr::proto::NetResolve::kMaxSize];
    Writer w(body, sizeof(body));
    encode(fr::proto::NetResolve{.addr = addr}, w);
    const uint8_t via = route(kClsNet, fr::proto::kKindNetResolve, 0, kHeaderSize + w.size());
    if (via == 0) {
        return;  // no hub to ask: the frame goes by flood meanwhile
    }
    transmit(via, build(0, kClsNet, fr::proto::kKindNetResolve, ++seq_, fr::proto::kAddrHub, fr::proto::kPortNode, {},
                        w.bytes()));
    *slot = Resolving{.addr = addr, .at = now};
    ++state_.nodes.resolves;
}

// ---- flooding (05 §5.9) ----

void Net::flood_copy(uint16_t src, uint16_t epoch, uint32_t seq, bool latest)
{
    for (Relay &r : relays_) {
        if (r.used && r.src == src && r.epoch == epoch && r.seq == seq && r.latest == latest) {
            if (++r.copies >= relay_.k) {
                // K copies on the air around this node: its relay would reach no one new.
                r.used = false;
                ++state_.relay.cancelled;
            }
            return;
        }
    }
}

void Net::flood_relay(std::span<const uint8_t> envelope, const Header &h, bool from_hub, const RxMeta *meta)
{
    // from_air: heard on the broadcast MAC (a unicast MAC is single-hop). from_hub: a hub broadcast or
    // group frame over TCP or serial. A frame for this node (a flooded unicast's target) or for the hub
    // goes no further, nor one whose TTL is spent.
    const bool from_air = meta != nullptr && meta->to_broadcast;
    const bool hub_seed = from_hub && h.src == fr::proto::kAddrHub && is_flood_dst(h.dst);
    if (!(from_air || hub_seed) || h.dst == addr_ || h.dst == fr::proto::kAddrHub || ttl_remaining(h.ttl) <= 1 ||
        envelope.size() > kRtSize || !air_up()) {
        return;
    }
    // Gateways never relay; a node busy with an OTA leaves its radio to the download.
    if (!relay_.enabled || gateway_ || host_.vitals().ota_busy) {
        ++state_.relay.dropped;
        return;
    }
    // A seed starts at copies = 0 like a relay: the hub link's copy says nothing about what the neighbours
    // heard, so only ESP-NOW copies count toward K (design c5 §8.2). Two seeders in range of each other then
    // both transmit, and a node with no hub link of its own hears each broadcast twice (T-FLOOD: its frame
    // loss squared). K = 0 relays nothing.
    if (relay_.k == 0) {
        ++state_.relay.cancelled;
        return;
    }
    const auto free_slot = std::find_if(relays_.begin(), relays_.end(), [](const Relay &x) { return !x.used; });
    if (free_slot == relays_.end()) {
        ++state_.relay.dropped;
        return;
    }
    Relay *r = &*free_slot;
    const uint32_t jmin = relay_.jmin_ms * 1000;
    const uint32_t spread = relay_.jmax_ms > relay_.jmin_ms ? (relay_.jmax_ms - relay_.jmin_ms) * 1000 : 0;
    uint32_t delay = jmin + next_random() % (spread + 1);
    if (from_air) {
        delay += rssi_bias_us(meta->rssi);
    }
    r->used = true;
    r->seed = hub_seed;
    r->latest = (h.flags & kFlagLatest) != 0;
    r->copies = 0;
    r->src = h.src;
    r->epoch = h.epoch;
    r->seq = h.seq;
    r->due = core_.now() + delay;
    r->len = static_cast<uint8_t>(envelope.size());
    // The original bytes, EXT included; only the relay-mutable fields change.
    std::memcpy(r->bytes, envelope.data(), envelope.size());
    r->bytes[kOffFlags] |= kFlagRelayed;
    r->bytes[kOffTtl] = static_cast<uint8_t>((h.ttl & 0xF0) | (ttl_remaining(h.ttl) - 1));
}

void Net::service_relays(TimeUs now)
{
    for (Relay &r : relays_) {
        if (!r.used || r.due > now) {
            continue;
        }
        r.used = false;
        // 05 §5.9: floods per source stay within the rate the robust PHY carries; the excess is not
        // relayed (nodes with a hub link still have the hub's copy and its repairs).
        if (!flood_rate_take(r.src, now)) {
            ++state_.relay.dropped;
            continue;
        }
        const AirPrio prio = (r.bytes[kOffFlags] & kFlagUrgent) != 0 ? AirPrio::urgent : AirPrio::normal;
        if (air_send(kBroadcastMac, {r.bytes, r.len}, prio, next_token())) {
            ++(r.seed ? state_.relay.seeded : state_.relay.relayed);
        } else {
            // Design m2-c2 D17: the driver refused it (its queue full, say): the origin's token goes back, since
            // nothing went on the air. Dropped, not re-queued, which would hold a relay slot.
            flood_rate_refund(r.src);
            ++state_.relay.dropped;
            ++state_.relay.refused;
        }
    }
}

bool Net::flood_rate_take(uint16_t src, TimeUs now)
{
    constexpr uint32_t kFull = kFloodRatePerS * 1000;
    FloodRate *b = nullptr;
    FloodRate *victim = nullptr;
    for (FloodRate &f : rates_) {
        if (f.used && f.src == src) {
            b = &f;
            break;
        }
        // A free bucket first, else the one metered longest ago.
        if (!f.used) {
            if (victim == nullptr || victim->used) {
                victim = &f;
            }
        } else if (victim == nullptr || (victim->used && f.last < victim->last)) {
            victim = &f;
        }
    }
    if (b == nullptr) {
        b = victim;
        *b = FloodRate{.used = true, .src = src, .milli = kFull, .last = now};
    } else {
        // Refill: kFloodRatePerS floods per second is that many thousandths per millisecond.
        const TimeUs elapsed = std::min<TimeUs>(now - b->last, 2'000'000);
        b->milli = std::min<uint32_t>(kFull, b->milli + static_cast<uint32_t>(elapsed * kFloodRatePerS / 1000));
        b->last = now;
    }
    if (b->milli < 1000) {
        return false;
    }
    b->milli -= 1000;
    return true;
}

void Net::flood_rate_refund(uint16_t src)
{
    // Design m2-c2 D17: called right after a flood_rate_take(src) in the same core-task call, so the bucket is
    // still there (no take evicted it) and unrefilled since: one flood back is exactly what was taken.
    constexpr uint32_t kFull = kFloodRatePerS * 1000;
    for (FloodRate &f : rates_) {
        if (f.used && f.src == src) {
            f.milli = std::min<uint32_t>(kFull, f.milli + 1000);
            return;
        }
    }
}

void Net::adopt_hub_run(uint16_t epoch, uint32_t seq)
{
    // Design m2-c2 D19: none of this run's broadcasts reached the node yet, so the window starts empty just
    // below `seq` (as a newer boot of a node source does, 05 §5.8): an earlier seq overtaken by this frame
    // still delivers. A later WELCOME of this run only raises the floor (on_welcome's same run), so nothing
    // taken from the air is delivered twice; one of another run resets it. The old run's scheduled CMDs go,
    // as at a WELCOME of another run: their hub is gone, and its clock offset with it.
    state_.hub_epoch = epoch;
    bcast_.restart(seq - 1);
    drop_other_run_cmds(epoch);
    ++state_.bcast.adopted;
}

void Net::send_air_heartbeat()
{
    if (!provisioned()) {
        return;
    }
    // 05 §5.10 router-mode ESP-NOW heartbeat: to every neighbour, TTL 1, LATEST (its own space: never in
    // state_seq, which only STATEs meant for the hub move), never relayed, never sent to the hub.
    uint8_t body[fr::proto::PresenceHeartbeat::kMaxSize];
    Writer w(body, sizeof(body));
    encode(heartbeat_msg(host_.link_info(), host_.vitals()), w);
    auto env = build(kFlagLatest, kClsPresence, fr::proto::kKindPresenceHeartbeat, ++latest_seq_,
                     fr::proto::kAddrBroadcast, fr::proto::kPortNode, {}, w.bytes(), ttl_both(1));
    air_send(kBroadcastMac, env, AirPrio::normal, next_token());
}

}  // namespace fr::net
