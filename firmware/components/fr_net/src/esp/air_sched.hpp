// The ESP-NOW driver's send discipline (design c5 §3, spec 05 §5.3 "Transmit discipline", "Peer table"),
// IDF-free so that espnow.cpp on target, fr_net_node's fake air medium and the host suite all run the same
// rules: three priority queues (URGENT > NORMAL > BULK), at most one send in flight (the next starts once
// the send callback's verdict is in, even one the guard gave up on: verdicts are matched to sends by count),
// link retries 2 ms then 4 ms after a failed send, and the unicast peer table (LRU, at most 17; a peer used
// within the last second is never evicted, so AirLink::send refuses and Net sends that frame as a flooded
// unicast instead). Everything here runs on the core task; the radio behind it (esp_now_* on target, UDP on
// the host) reports back through Scheduler::sent() and ::timer(), which the driver calls on the core task
// after its callbacks posted. No heap.
//
// M2-C4 (design m2-c4-gateway D1, D19): a frame may carry its own rate (the gateway's GW_TX, `air bench`), set on its
// peer before its attempts when the peer's differs; `air rate` changes the default rate of the unicast peers or the
// broadcast peer; a frame's end tells its link retries and queue wait (last_done); churn() times throwaway peers. Of the
// driver's 20 peer entries (05 §5.3), a node keeps one for its chosen gateway (pin(): outside the LRU, so binding
// churn never evicts it) and one spare (`air churn`'s throwaway peer); a gateway's bridge takes all 19 beside the
// broadcast peer as its LRU (set_bridge()).
//
// CSI-1 (design csi-c1 D9): a frame may be plain (espnow_tx's fixed-rate frames for a CSI receiver, not envelopes): it
// queues and goes one in flight like any other, but gets no link retry, and its end goes to Radio::done_plain, not Net.
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>

#include "fr/base.hpp"
#include "fr/net/air.hpp"
#include "fr/net/limits.hpp"
#include "fr/net/us_histogram.hpp"

namespace fr::net::air {

/** FR_MTU_RT: one ESP-NOW v1 payload. A BULK frame never goes on the air (design c5 §2). */
inline constexpr size_t kMtu = 250;
/** Frames queued at once, all priorities together (16, or the memory class's). */
inline constexpr size_t kQueueFrames = limits::kAirQueue;
/** Of those, kept for URGENT: relays and MSGs cannot crowd out a binding's command or a Q1 answer. */
inline constexpr size_t kUrgentReserve = 4;
static_assert(kQueueFrames > kUrgentReserve);
/** 05 §5.3: 20 peer entries = the broadcast peer, gateways (M2) and up to 17 unicast peers. */
inline constexpr size_t kUnicastPeers = 17;
/** A gateway's bridge (design m2-c4-gateway D8): every entry beside the broadcast peer is its LRU's. */
inline constexpr size_t kBridgePeers = 19;
/** A peer used within this is never evicted (05 §5.3): churning add_peer/del_peer costs more than a flood. */
inline constexpr TimeUs kPeerHoldUs = 1'000'000;
/** FR_LINK_RETRIES, and their delays (05 §5.3: esp_timer one-shots, never FreeRTOS ticks). */
inline constexpr size_t kLinkRetries = 2;
inline constexpr uint32_t kRetryDelayUs[kLinkRetries] = {2'000, 4'000};
/** No send callback this long after a send: the attempt failed (the link retry follows, or the frame ends). */
inline constexpr uint32_t kSendGuardUs = 100'000;
/**
 * A send the guard gave up on is still the driver's: the next send (a retry or another frame) waits for its
 * late verdict, or until this long after it went, when the driver is taken to have lost that callback. Two
 * sends in the driver would put every later verdict on the wrong frame (the callbacks carry no frame id).
 */
inline constexpr uint32_t kSendLostUs = 1'000'000;
/** A timer that fires this much before its deadline is still taken as due (esp_timer is not exact). */
inline constexpr TimeUs kTimerSlackUs = 200;

inline bool is_broadcast(const Mac &m)
{
    return m == kBroadcastMac;
}

/** What the scheduler drives. Called on the core task, never from inside a radio callback. */
class Radio
{
public:
    /** Adds a unicast peer at the robust rate (esp_now_add_peer, then esp_now_set_peer_rate_config). */
    virtual bool add_peer(const Mac &mac) = 0;
    virtual void del_peer(const Mac &mac) = 0;
    /** Starts one send (esp_now_send). True: its verdict comes later through Scheduler::sent(). */
    virtual bool transmit(const Mac &dst, std::span<const uint8_t> frame) = 0;
    /** One timer, (re)started: Scheduler::timer() once it fires. */
    virtual void arm(uint32_t delay_us) = 0;
    virtual void disarm() = 0;
    /** A frame's end (Net::air_sent): `ok` for a MAC-ACKed unicast or a broadcast that went out. */
    virtual void done(uint32_t token, bool ok) = 0;
    /** A plain frame's end (design csi-c1 D9: espnow_tx, outside Net). A radio without plain senders ignores it. */
    virtual void done_plain(uint32_t token, bool ok)
    {
        static_cast<void>(token);
        static_cast<void>(ok);
    }
    /** The peer's rate from now on (esp_now_set_peer_rate_config; kBroadcastMac: the broadcast peer); peer_default is
     * the rate add_peer gives (the robust one on target). False when the driver refused it. */
    virtual bool set_rate(const Mac &mac, AirRate rate)
    {
        static_cast<void>(mac);
        static_cast<void>(rate);
        return true;
    }

protected:
    ~Radio() = default;
};

/** Counters since boot (diag `stats` espnow). */
struct SchedStats {
    uint32_t sent = 0;       // frames that went out: unicasts MAC-ACKed, broadcasts transmitted
    uint32_t failed = 0;     // frames given up: the link retries failed, or no peer entry at send time
    uint32_t retries = 0;    // link-level re-sends
    uint32_t refused = 0;    // send() refused: queue full, no peer slot, too long
    uint32_t peer_adds = 0;  // add_peer calls that succeeded
    uint32_t evictions = 0;  // peers deleted to make room
    uint32_t guard = 0;      // attempts the guard failed: no send callback within kSendGuardUs
    uint32_t lost = 0;       // send callbacks never seen within kSendLostUs: the next send went anyway
    uint32_t rate_fail = 0;  // set_rate refused (design m2-c4-gateway D19): the peer kept its rate
};

/** What `air rate` changed (design m2-c4-gateway D19). */
struct RateChange {
    uint32_t peers = 0;  // peer entries whose rate was set now (the broadcast peer counts one)
    uint32_t failed = 0;  // ... of which the driver refused
};

class Scheduler
{
public:
    explicit Scheduler(Radio &radio) : radio_(radio) {}
    Scheduler(const Scheduler &) = delete;
    Scheduler &operator=(const Scheduler &) = delete;

    /**
     * AirLink::send: queues `envelope` for `dst` and starts it if nothing is in flight. Refused (no done()
     * follows): invalid_args when empty or above kMtu, busy when the queue is full for `prio` or `dst` would
     * need a peer slot that no peer unused for a second can free. A `plain` frame (design csi-c1 D9) gets no link
     * retry and ends through Radio::done_plain.
     */
    Status send(const Mac &dst, std::span<const uint8_t> envelope, AirPrio prio, uint32_t token, TimeUs now,
                AirRate rate = AirRate::peer_default, bool plain = false)
    {
        refused_no_peer_ = false;
        if (envelope.empty() || envelope.size() > kMtu) {
            ++stats_.refused;
            return std::unexpected(Err::invalid_args);
        }
        const size_t free = kQueueFrames - queued();
        if (free == 0 || (prio != AirPrio::urgent && free <= kUrgentReserve)) {
            ++stats_.refused;
            return std::unexpected(Err::busy);
        }
        // The peer is taken now (and marked used), so a frame accepted here finds it at send time.
        if (!is_broadcast(dst) && !peer(dst, now)) {
            ++stats_.refused;
            refused_no_peer_ = true;
            return std::unexpected(Err::busy);
        }
        Frame *f = nullptr;
        for (Frame &c : frames_) {
            if (!c.used) {
                f = &c;
                break;
            }
        }
        f->used = true;
        f->prio = prio;
        f->rate = rate;
        f->plain = plain;
        f->order = ++order_;
        f->token = token;
        f->queued_at = now;
        f->dst = dst;
        f->len = static_cast<uint8_t>(envelope.size());
        std::memcpy(f->bytes, envelope.data(), envelope.size());
        kick(now);
        return {};
    }

    /**
     * The send callbacks' verdicts since the last call: `n` of them, the last one `last_ok`. The driver calls
     * them in send order, so the last one answers the latest send once every earlier send is answered: the
     * frame in flight's attempt, or, while the next send is held back, the attempt the guard gave up on (its
     * verdict then only releases the held send). Verdicts on earlier sends, or with nothing awaiting one, are
     * dropped.
     */
    void sent(uint32_t n, bool last_ok, TimeUs now)
    {
        if (n < owed_) {
            owed_ -= n;  // late verdicts on sends before the latest: its own is still to come
            return;
        }
        owed_ = 0;
        if (inflight_ == kNone) {
            return;
        }
        if (state_ == State::awaiting) {
            radio_.disarm();
            if (last_ok) {
                finish(true, now);
            } else {
                failed_attempt(now);
            }
        } else if (state_ == State::held) {
            radio_.disarm();
            attempt(now);  // the guard already counted that attempt as failed
        }
    }
    /** One send callback's verdict. */
    void sent(bool ok, TimeUs now) { sent(1, ok, now); }

    /** The radio's timer fired: a link retry is due, a send callback is late, or a late one never came. */
    void timer(TimeUs now)
    {
        if (inflight_ == kNone || state_ == State::idle || now + kTimerSlackUs < deadline_) {
            return;  // stale: the timer was re-armed or the frame ended since
        }
        switch (state_) {
        case State::retry_wait:
            attempt(now);
            break;
        case State::awaiting:
            // The guard: the verdict is late or lost. It stays owed, so the next send waits for it (attempt()).
            ++stats_.guard;
            failed_attempt(now);
            break;
        case State::held:
            ++stats_.lost;
            owed_ = 0;
            attempt(now);
            break;
        case State::idle:
            break;
        }
    }

    size_t queued() const
    {
        size_t n = 0;
        for (const Frame &f : frames_) {
            n += f.used ? 1 : 0;
        }
        return n;
    }
    /** Unicast peer entries in the driver now: the LRU's and the pinned one. */
    size_t peers() const
    {
        size_t n = pinned_.live ? 1 : 0;
        for (size_t i = 0; i < limit_; ++i) {
            n += peers_[i].live ? 1 : 0;
        }
        return n;
    }
    /** Unicast entries the LRU may hold: kUnicastPeers on a node, kBridgePeers on a gateway. */
    size_t peer_limit() const { return limit_; }

    /**
     * Design m2-c4-gateway D10 (node): keeps `mac`, the chosen gateway, in one of the two reserved peer entries, outside
     * the LRU, so the bindings' unicast churn never evicts it; null (or another MAC) releases the one pinned before,
     * which moves into the LRU when it has a free entry and is deleted otherwise. Its LRU entry, if it had one, moves
     * over as it is (the driver's entry and rate stay). False when the driver refused a new entry (nothing pinned; its
     * frames then take the LRU like any peer's). A gateway (set_bridge) pins nothing.
     */
    bool pin(const Mac *mac, TimeUs now)
    {
        if (mac != nullptr && pinned_.live && pinned_.mac == *mac) {
            return true;
        }
        if (pinned_.live) {
            Peer *free = nullptr;
            for (size_t i = 0; i < limit_ && free == nullptr; ++i) {
                free = peers_[i].live ? nullptr : &peers_[i];
            }
            if (free != nullptr) {
                *free = pinned_;
            } else {
                radio_.del_peer(pinned_.mac);
            }
            pinned_.live = false;
        }
        if (mac == nullptr) {
            return true;
        }
        if (bridge_ || is_broadcast(*mac)) {
            return false;
        }
        for (size_t i = 0; i < limit_; ++i) {
            if (peers_[i].live && peers_[i].mac == *mac) {
                pinned_ = peers_[i];
                pinned_.used = now;
                peers_[i].live = false;
                return true;
            }
        }
        if (!radio_.add_peer(*mac)) {
            return false;
        }
        ++stats_.peer_adds;
        pinned_ = {.live = true, .mac = *mac, .used = now};
        return true;
    }
    /** The MAC pinned now (null: none). */
    const Mac *pinned() const { return pinned_.live ? &pinned_.mac : nullptr; }

    /**
     * Design m2-c4-gateway D8 (role gateway): the LRU takes kBridgePeers entries, the two reserved ones included (a
     * gateway uses no gateway), and nothing stays pinned. Off again: back to kUnicastPeers, the peers beyond deleted.
     */
    void set_bridge(bool on)
    {
        if (on == bridge_) {
            return;
        }
        bridge_ = on;
        if (on) {
            static_cast<void>(pin(nullptr, 0));
            limit_ = kBridgePeers;
            return;
        }
        for (size_t i = kUnicastPeers; i < limit_; ++i) {
            if (peers_[i].live) {
                radio_.del_peer(peers_[i].mac);
                peers_[i].live = false;
            }
        }
        limit_ = kUnicastPeers;
    }
    bool in_flight() const { return inflight_ != kNone; }
    const SchedStats &stats() const { return stats_; }

    /**
     * `air rate` (design m2-c4-gateway D19): the rate a frame without its own takes, for unicast peers or the broadcast
     * peer, set at once on every peer that has another (peer_default: the rate add_peer gives). A frame with its own
     * rate still sets it on its peer for its attempts.
     */
    RateChange set_default_rate(bool broadcast, AirRate rate)
    {
        RateChange r;
        default_rate_[broadcast ? 1 : 0] = rate;
        const auto apply = [&](const Mac &mac, AirRate &cur) {
            ++r.peers;
            if (!radio_.set_rate(mac, rate)) {
                ++r.failed;
                ++stats_.rate_fail;
                return;  // the peer kept its rate: the next frame to it tries again (apply_rate)
            }
            cur = rate;
        };
        if (broadcast) {
            apply(kBroadcastMac, bcast_rate_);
        } else {
            for (size_t i = 0; i < limit_; ++i) {
                if (peers_[i].live) {
                    apply(peers_[i].mac, peers_[i].rate);
                }
            }
            if (pinned_.live) {
                apply(pinned_.mac, pinned_.rate);
            }
        }
        return r;
    }
    AirRate default_rate(bool broadcast) const { return default_rate_[broadcast ? 1 : 0]; }
    /**
     * Design csi-c1 D6: channel C moved to the other band, so every peer entry's rate config (the broadcast peer's,
     * the LRU's, the pinned gateway's) is one of the old band's (11b does not exist on 5 GHz). Each is set again at
     * the rate the scheduler has for it, which the radio maps onto the new band. A refusal is counted (rate_fail): that
     * peer keeps the old config until its rate is set again.
     */
    RateChange reapply_rates()
    {
        RateChange r;
        const auto again = [&](const Mac &mac, AirRate cur) {
            ++r.peers;
            if (!radio_.set_rate(mac, cur)) {
                ++r.failed;
                ++stats_.rate_fail;
            }
        };
        again(kBroadcastMac, bcast_rate_);
        for (size_t i = 0; i < limit_; ++i) {
            if (peers_[i].live) {
                again(peers_[i].mac, peers_[i].rate);
            }
        }
        if (pinned_.live) {
            again(pinned_.mac, pinned_.rate);
        }
        return r;
    }
    /** The last send() was refused busy for want of a peer slot, not of queue room (AirLink::refused_no_peer). */
    bool refused_no_peer() const { return refused_no_peer_; }
    /** How send `token` ended (AirLink::done_info): valid inside the done() call for it, {} for another token. */
    AirDone last_done(uint32_t token) const { return token == done_token_ ? done_ : AirDone{}; }

private:
    static constexpr size_t kNone = SIZE_MAX;

    enum class State : uint8_t {
        idle,
        awaiting,    // transmitted, waiting for the send callback (guard armed)
        retry_wait,  // failed, waiting for the link retry's delay
        held,        // due, but an earlier send's callback is still owed (kSendLostUs armed)
    };

    struct Frame {
        bool used = false;
        AirPrio prio = AirPrio::normal;
        AirRate rate = AirRate::peer_default;  // its own, else the default for its kind of peer
        bool plain = false;                    // design csi-c1 D9: no link retry, ends through done_plain
        uint8_t len = 0;
        uint32_t order = 0;
        uint32_t token = 0;
        TimeUs queued_at = 0;   // send()
        TimeUs started_at = 0;  // its first attempt
        Mac dst{};
        uint8_t bytes[kMtu];
    };

    struct Peer {
        bool live = false;
        Mac mac{};
        TimeUs used = 0;
        AirRate rate = AirRate::peer_default;  // what the radio has for it (add_peer's)
    };

    Peer *live_peer(const Mac &mac)
    {
        if (pinned_.live && pinned_.mac == mac) {
            return &pinned_;
        }
        for (size_t i = 0; i < limit_; ++i) {
            if (peers_[i].live && peers_[i].mac == mac) {
                return &peers_[i];
            }
        }
        return nullptr;
    }

    /** The frame's rate on its peer before an attempt, when the peer has another (design m2-c4-gateway D19). */
    void apply_rate(const Frame &f)
    {
        const bool bc = is_broadcast(f.dst);
        const AirRate want = f.rate != AirRate::peer_default ? f.rate : default_rate_[bc ? 1 : 0];
        Peer *p = bc ? nullptr : live_peer(f.dst);
        AirRate &cur = bc ? bcast_rate_ : p->rate;  // attempt() just took the peer
        if (cur != want) {
            // Only what the driver took is recorded: a refusal leaves the peer's rate as it was, so the next frame
            // (or this one's link retry) asks again instead of going at a rate it never got.
            if (radio_.set_rate(f.dst, want)) {
                cur = want;
            } else {
                ++stats_.rate_fail;
            }
        }
    }

    /** A peer entry for `mac`, marked used now: the existing one, a free one, or the LRU one if it is older
     * than kPeerHoldUs. False when none can be had (or the radio refused the add). */
    bool peer(const Mac &mac, TimeUs now)
    {
        if (pinned_.live && pinned_.mac == mac) {
            pinned_.used = now;
            return true;
        }
        Peer *free = nullptr;
        Peer *lru = nullptr;
        for (size_t i = 0; i < limit_; ++i) {
            Peer &p = peers_[i];
            if (p.live && p.mac == mac) {
                p.used = now;
                return true;
            }
            if (!p.live) {
                free = free != nullptr ? free : &p;
            } else if (lru == nullptr || p.used < lru->used) {
                lru = &p;
            }
        }
        if (free == nullptr) {
            if (lru == nullptr || now - lru->used < kPeerHoldUs) {
                return false;
            }
            radio_.del_peer(lru->mac);
            lru->live = false;
            ++stats_.evictions;
            free = lru;
        }
        if (!radio_.add_peer(mac)) {
            return false;
        }
        ++stats_.peer_adds;
        *free = {.live = true, .mac = mac, .used = now};
        return true;
    }

    /** Starts the next frame (highest priority, then oldest) when nothing is in flight. */
    void kick(TimeUs now)
    {
        if (inflight_ != kNone) {
            return;
        }
        size_t best = kNone;
        for (size_t i = 0; i < frames_.size(); ++i) {
            const Frame &f = frames_[i];
            if (f.used && (best == kNone || f.prio < frames_[best].prio ||
                           (f.prio == frames_[best].prio && static_cast<int32_t>(f.order - frames_[best].order) < 0))) {
                best = i;
            }
        }
        if (best == kNone) {
            return;
        }
        inflight_ = best;
        attempts_ = 0;
        frames_[best].started_at = now;
        attempt(now);
    }

    void attempt(TimeUs now)
    {
        Frame &f = frames_[inflight_];
        // A frame that waited more than kPeerHoldUs may have lost its peer to a newer one.
        if (!is_broadcast(f.dst) && !peer(f.dst, now)) {
            finish(false, now);
            return;
        }
        if (owed_ > 0) {
            // A send the guard gave up on is still in the driver: one send in flight (05 §5.3), and this one's
            // verdict must not be mistaken for that one's.
            const TimeUs left = owed_at_ + kSendLostUs - now;
            if (left > 0) {
                arm(State::held, static_cast<uint32_t>(left), now);
                return;
            }
            ++stats_.lost;
            owed_ = 0;
        }
        apply_rate(f);
        if (!radio_.transmit(f.dst, {f.bytes, f.len})) {
            failed_attempt(now);  // ESP_ERR_ESPNOW_NO_MEM and the like: as a failed send, no callback follows
            return;
        }
        ++owed_;
        owed_at_ = now;
        arm(State::awaiting, kSendGuardUs, now);
    }

    void failed_attempt(TimeUs now)
    {
        if (attempts_ < kLinkRetries && !frames_[inflight_].plain) {
            ++stats_.retries;
            arm(State::retry_wait, kRetryDelayUs[attempts_++], now);
            return;
        }
        finish(false, now);
    }

    void arm(State s, uint32_t delay_us, TimeUs now)
    {
        state_ = s;
        deadline_ = now + delay_us;
        radio_.arm(delay_us);
    }

    void finish(bool ok, TimeUs now)
    {
        // Settled before done(): Net may send again from inside it (the fallback chain), which kicks here.
        Frame &f = frames_[inflight_];
        const uint32_t token = f.token;
        const bool plain = f.plain;
        done_token_ = token;
        done_ = {.retries = attempts_,
                 .queued_us = static_cast<uint32_t>(std::clamp<TimeUs>(f.started_at - f.queued_at, 0, UINT32_MAX))};
        f.used = false;
        inflight_ = kNone;
        state_ = State::idle;
        radio_.disarm();
        ++(ok ? stats_.sent : stats_.failed);
        if (plain) {
            radio_.done_plain(token, ok);
        } else {
            radio_.done(token, ok);
        }
        kick(now);
    }

    Radio &radio_;
    std::array<Frame, kQueueFrames> frames_{};
    std::array<Peer, kBridgePeers> peers_{};  // the LRU: the first limit_ entries
    size_t limit_ = kUnicastPeers;
    bool bridge_ = false;
    Peer pinned_;  // a node's chosen gateway (pin())
    uint32_t order_ = 0;
    size_t inflight_ = kNone;
    State state_ = State::idle;
    uint8_t attempts_ = 0;
    TimeUs deadline_ = 0;
    uint32_t owed_ = 0;   // send callbacks the driver still owes: sends that went out minus verdicts in
    TimeUs owed_at_ = 0;  // when the latest send went out
    SchedStats stats_;
    std::array<AirRate, 2> default_rate_{AirRate::peer_default, AirRate::peer_default};  // unicast, broadcast
    AirRate bcast_rate_ = AirRate::peer_default;  // what the radio has for the broadcast peer
    bool refused_no_peer_ = false;
    uint32_t done_token_ = 0;  // last_done()
    AirDone done_;
};

/** `air churn <n>` (design m2-c4-gateway D19 (d)): what n throwaway peer adds and deletes took. */
struct ChurnStats {
    uint32_t n = 0;
    uint32_t failed = 0;  // adds the radio refused (no delete follows)
    UsHistogram add;
    UsHistogram del;
};

/**
 * Adds and deletes `n` throwaway peers one at a time (locally administered MACs no node has), timing each call on
 * `now()` (esp_timer µs on target), into `out`. One peer entry beyond the scheduler's own is used at a time; the
 * scheduler's table is untouched. Core task: the driver's other calls wait meanwhile, as they would for real churn.
 */
template <class Clock>
void churn(Radio &radio, uint32_t n, Clock now, ChurnStats &out)
{
    out.n = n;
    out.failed = 0;
    out.add.clear();
    out.del.clear();
    for (uint32_t i = 0; i < n; ++i) {
        const Mac mac{0x02, 0xF2, 0xC4, 0x5D, static_cast<uint8_t>(i >> 8), static_cast<uint8_t>(i)};
        const TimeUs t0 = now();
        const bool added = radio.add_peer(mac);
        const TimeUs t1 = now();
        if (!added) {
            ++out.failed;
            continue;
        }
        radio.del_peer(mac);
        const TimeUs t2 = now();
        out.add.add(static_cast<uint32_t>(std::clamp<TimeUs>(t1 - t0, 0, UINT32_MAX)));
        out.del.add(static_cast<uint32_t>(std::clamp<TimeUs>(t2 - t1, 0, UINT32_MAX)));
    }
}

}  // namespace fr::net::air
