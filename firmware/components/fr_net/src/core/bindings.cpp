// fr:realtime
// fr_net core, C5 (design c5 §3, spec 07 §7.11): bindings. The table holds up to 16 encoded Bindings as
// fr.node.bind_set brought them, persisted through BindingStore. A binding fires on a local EVENT emission
// (Net::event, before the hub send) or on a received MSG topic, and sends its pre-encoded CMD fields or MSG
// data to its target: this node (dispatched here), every node (a MSG broadcast) or another node (the
// fallback chain of peer.cpp, starting at the MAC the binding carries, so it works with the hub stopped).
// Each fire is reported as node.binding_fired {slot, target_status, rtt_us, path} once its outcome is
// known. Everything runs on the core task; no heap.
#include <algorithm>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "net_util.hpp"
#include "node.hpp"  // generated fr::cap::Node: the binding_fired event

namespace fr::net {

using namespace fr::wire;
using namespace util;

namespace {

/** A binding's MSG body: topic (<= 32 B) and payload (<= 64 B), each with its tag and length byte. */
constexpr size_t kBindingMsgMax = 2 + 32 + 2 + 64;
static_assert(kBindingMsgMax <= fr::proto::MsgMsg::kMaxSize);

/** One encoded Binding as a BindingList item: field 1's tag, its length, its bytes. */
constexpr size_t list_item_size(size_t len)
{
    return 1 + varint_size(len) + len;
}

/** The structural rules a binding must meet before it is stored (design c5 §2; the hub resolves the rest). */
bool binding_ok(const fr::proto::Binding &b)
{
    return b.slot < kBindingsMax && (b.on_cls == kClsEvent || b.on_cls == kClsMsg) &&
           (b.to_cls == kClsCmd || b.to_cls == kClsMsg) && (b.to_mac.empty() || b.to_mac.size() == 6);
}

}  // namespace

// ---- the table ----

void Net::attach_stores(DirectoryStore *directory, BindingStore *bindings)
{
    directory_store_ = directory;
    binding_store_ = bindings;
    // Loaded in place (the binding table is ~2.7 KB, too much for a boot-time stack), then checked: a store
    // written by another firmware version must not hand the core a slot it cannot fire.
    if (directory != nullptr && directory->load(directory_)) {
        directory_.count = std::min(directory_.count, kDirectoryMax);
    }
    if (bindings != nullptr && bindings->load(bindings_)) {
        for (size_t i = 0; i < bindings_.size(); ++i) {
            BindingSlot &s = bindings_[i];
            if (!s.used) {
                continue;
            }
            if (s.len > sizeof(s.bytes)) {
                s = BindingSlot{};
                continue;
            }
            const auto b = fr::proto::decode_binding(s.encoded());
            if (!b || !binding_ok(*b) || b->slot != i) {
                s = BindingSlot{};
            }
        }
    }
}

Status Net::set_binding(std::span<const uint8_t> binding)
{
    const auto b = fr::proto::decode_binding(binding);
    if (!b || !binding_ok(*b)) {
        return std::unexpected(Err::invalid_args);
    }
    // Stored re-encoded: canonical and within kMaxSize even when the args carried unknown fields.
    BindingSlot &s = bindings_[b->slot];
    uint8_t bytes[fr::proto::Binding::kMaxSize];
    Writer w(bytes, sizeof(bytes));
    encode(*b, w);  // `b` views `binding`, which may be the slot itself: encode aside, then copy
    if (w.overflow()) {
        return std::unexpected(Err::invalid_args);  // cannot happen: decoded fields fit their kMaxSize
    }
    // The whole table must stay readable through bind_list, or the hub's reconcile at every handshake cannot
    // see what the node holds (design c5 §8.6).
    size_t list = list_item_size(w.size());
    for (size_t i = 0; i < bindings_.size(); ++i) {
        if (i != b->slot && bindings_[i].used) {
            list += list_item_size(bindings_[i].len);
        }
    }
    if (list > kBindListMax) {
        return std::unexpected(Err::invalid_args);
    }
    std::memcpy(s.bytes, bytes, w.size());
    s.len = static_cast<uint8_t>(w.size());
    s.used = true;
    if (binding_store_ != nullptr) {
        binding_store_->save(bindings_);
    }
    return {};
}

Status Net::clear_binding(uint8_t slot)
{
    if (slot == kBindSlotAll) {
        bindings_.fill(BindingSlot{});
    } else if (slot < kBindingsMax) {
        bindings_[slot] = BindingSlot{};
    } else {
        return std::unexpected(Err::invalid_args);
    }
    if (binding_store_ != nullptr) {
        binding_store_->save(bindings_);
    }
    return {};
}

std::expected<std::span<const uint8_t>, Err> Net::encode_bindings(std::span<uint8_t> out) const
{
    // A BindingList is `items` (field 1) repeated, each an encoded Binding: the slots' bytes as they are.
    Writer w(out.data(), out.size());
    for (const BindingSlot &s : bindings_) {
        if (s.used) {
            w.field_bytes(1, s.encoded());
        }
    }
    if (w.overflow()) {
        return std::unexpected(Err::failed);
    }
    return w.bytes();
}

void Net::set_relay(const RelayConfig &relay)
{
    relay_ = relay;
}

// ---- execution ----

void Net::run_bindings(bool on_event, uint8_t port, uint8_t kind, std::string_view topic)
{
    // A reaction may trigger bindings in turn (a local CMD that emits an event, a MSG to oneself), up to
    // kBindingChainMax deep: a loop ends there instead of in a stack overflow.
    if (binding_depth_ >= kBindingChainMax || !provisioned()) {
        return;
    }
    ++binding_depth_;
    for (const BindingSlot &s : bindings_) {
        if (!s.used) {
            continue;
        }
        // Fired from a copy: a reaction may be fr.node.bind_set or bind_clear on this very table.
        uint8_t bytes[fr::proto::Binding::kMaxSize];
        const size_t len = std::min<size_t>(s.len, sizeof(bytes));
        std::memcpy(bytes, s.bytes, len);
        const auto b = fr::proto::decode_binding({bytes, len});
        if (!b) {
            continue;
        }
        const bool match = on_event ? b->on_cls == kClsEvent && b->on_port == port && b->on_kind == kind
                                    : b->on_cls == kClsMsg && b->on_topic == topic;
        if (match) {
            fire(*b);
        }
    }
    --binding_depth_;
}

void Net::fire(const fr::proto::Binding &b)
{
    const TimeUs trigger = core_.now();
    if (b.to_addr == addr_ && b.to_cls == kClsCmd) {
        // 07 §7.11 "to.addr = self": a local reaction, dispatched here with no network. Its own Reply, not
        // reply_buf_: this may run inside a hub CMD's dispatch. (Its own scope too, apart from the MSG
        // buffer below: a binding chain nests this frame, on the core task's stack.)
        cap::StaticReply<> reply;
        ++state_.cmds;
        const Status st = host_.dispatch(b.to_port, b.to_kind, b.payload, reply);
        const uint32_t rtt = b.reliable ? static_cast<uint32_t>(std::min<TimeUs>(core_.now() - trigger, UINT32_MAX)) : 0;
        fired(b.slot, wire_status(st), rtt, Path::local);
        return;
    }
    // What the target gets: the pre-encoded CMD fields as they are, or a MSG {to_topic, payload}.
    uint8_t msg[kBindingMsgMax];
    std::span<const uint8_t> body = b.payload;
    uint8_t kind = b.to_kind;
    if (b.to_cls == kClsMsg) {
        Writer w(msg, sizeof(msg));
        encode(fr::proto::MsgMsg{.topic = b.to_topic, .data = b.payload}, w);
        body = w.bytes();
        kind = fr::proto::kKindMsgMsg;
    }
    if (b.to_addr == addr_) {
        deliver_msg(addr_, body);  // a MSG to itself: its bindings (within the chain limit) and handlers
        fired(b.slot, fr::proto::kStatusOk, 0, Path::local);
        return;
    }
    if (b.to_addr == fr::proto::kAddrBroadcast) {
        // A MSG broadcast, or a port-0 CMD (the only one every device reads alike, 05 §5.8); never ACKed.
        const auto r = broadcast_frame(b.to_cls, kind, b.to_port, body, 0);
        fired(b.slot, r ? fr::proto::kStatusOk : static_cast<uint8_t>(r.error()), 0, r ? *r : Path::espnow);
        return;
    }
    if (!is_node_addr(b.to_addr)) {
        fired(b.slot, static_cast<uint8_t>(Err::invalid_args), 0, Path::espnow);  // groups are M2
        return;
    }
    // The target's MAC travels in the binding (07 §7.11 "Routing"), so the unicast needs no directory.
    Mac mac{};
    const bool has_mac = b.to_mac.size() == mac.size();
    if (has_mac) {
        std::copy(b.to_mac.begin(), b.to_mac.end(), mac.begin());
    }
    uint8_t flags = b.reliable ? kFlagAckReq : 0;
    if (b.to_cls == kClsCmd) {
        flags |= kFlagUrgent;  // input-driven: the URGENT queue on the air and the fast path to the hub
    }
    const Status st = node_send(b.to_addr, has_mac ? &mac : nullptr, flags, b.to_cls, kind, b.to_port, {}, body,
                                static_cast<int8_t>(b.slot), trigger);
    if (!st) {
        fired(b.slot, wire_status(st), 0, Path::espnow);  // no path at all now
    }
}

void Net::fired(uint8_t slot, uint8_t status, uint32_t rtt_us, Path path)
{
    BindingStats &bs = state_.bindings;
    ++bs.fired;
    if (status != fr::proto::kStatusOk) {
        ++bs.failed;
    } else if (rtt_us != 0) {
        rtts_[rtt_next_] = rtt_us;
        rtt_next_ = (rtt_next_ + 1) % kRttSamples;
        rtt_n_ = std::min(rtt_n_ + 1, kRttSamples);
    }
    // Always queued, never sent from here: callers may hold an envelope in tx_buf_, which sending an EVENT
    // rebuilds. Every entry point flushes before it returns.
    if (fired_n_ < fired_q_.size()) {
        fired_q_[fired_n_++] = {.slot = slot, .status = status, .path = path, .rtt_us = rtt_us};
    }
}

void Net::flush_fired()
{
    if (fired_hold_ > 0) {
        return;  // Net::event sends its EVENT first
    }
    // send_event never fires bindings, so nothing is queued while this drains.
    for (size_t i = 0; i < fired_n_; ++i) {
        emit_fired(fired_q_[i]);
    }
    fired_n_ = 0;
}

void Net::emit_fired(const Fired &f)
{
    uint8_t buf[cap::NodeBindingFired::kMaxSize];
    Writer w(buf, sizeof(buf));
    encode(cap::NodeBindingFired{.slot = f.slot,
                                 .target_status = f.status,
                                 .rtt_us = f.rtt_us,
                                 .path = static_cast<uint8_t>(f.path)},
           w);
    // Like any fr.node event: Q1 to the hub when there is a path, else counted in events_dropped (bindings
    // work with no hub session; only their report needs one).
    send_event(fr::proto::kPortNode, cap::Node::kEventBindingFired, cap::Priority::normal, w.bytes(), core_.now(),
               false);
}

uint32_t Net::rtt_p50() const
{
    if (rtt_n_ == 0) {
        return 0;
    }
    std::array<uint32_t, kRttSamples> v = rtts_;
    const auto mid = v.begin() + static_cast<std::ptrdiff_t>(rtt_n_ / 2);
    std::nth_element(v.begin(), mid, v.begin() + static_cast<std::ptrdiff_t>(rtt_n_));
    return *mid;
}

}  // namespace fr::net
