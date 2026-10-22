// The ESP-NOW driver's send discipline (design c5 §3, spec 05 §5.3 "Transmit discipline", "Peer table"),
// IDF-free so that espnow.cpp on target, fr_net_node's fake air medium and the host suite all run the same
// rules: three priority queues (URGENT > NORMAL > BULK), at most one send in flight (the next starts once
// the send callback's verdict is in, even one the guard gave up on: verdicts are matched to sends by count),
// link retries 2 ms then 4 ms after a failed send, and the unicast peer table (LRU, at most 17; a peer used
// within the last second is never evicted, so AirLink::send refuses and Net sends that frame as a flooded
// unicast instead). Everything here runs on the core task; the radio behind it (esp_now_* on target, UDP on
// the host) reports back through Scheduler::sent() and ::timer(), which the driver calls on the core task
// after its callbacks posted. No heap.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>

#include "fr/base.hpp"
#include "fr/net/air.hpp"

namespace fr::net::air {

/** FR_MTU_RT: one ESP-NOW v1 payload. A BULK frame never goes on the air (design c5 §2). */
inline constexpr size_t kMtu = 250;
/** Frames queued at once, all priorities together. */
inline constexpr size_t kQueueFrames = 16;
/** Of those, kept for URGENT: relays and MSGs cannot crowd out a binding's command or a Q1 answer. */
inline constexpr size_t kUrgentReserve = 4;
/** 05 §5.3: 20 peer entries = the broadcast peer, gateways (M2) and up to 17 unicast peers. */
inline constexpr size_t kUnicastPeers = 17;
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
     * need a peer slot that no peer unused for a second can free.
     */
    Status send(const Mac &dst, std::span<const uint8_t> envelope, AirPrio prio, uint32_t token, TimeUs now)
    {
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
        f->order = ++order_;
        f->token = token;
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
    size_t peers() const
    {
        size_t n = 0;
        for (const Peer &p : peers_) {
            n += p.live ? 1 : 0;
        }
        return n;
    }
    bool in_flight() const { return inflight_ != kNone; }
    const SchedStats &stats() const { return stats_; }

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
        uint8_t len = 0;
        uint32_t order = 0;
        uint32_t token = 0;
        Mac dst{};
        uint8_t bytes[kMtu];
    };

    struct Peer {
        bool live = false;
        Mac mac{};
        TimeUs used = 0;
    };

    /** A peer entry for `mac`, marked used now: the existing one, a free one, or the LRU one if it is older
     * than kPeerHoldUs. False when none can be had (or the radio refused the add). */
    bool peer(const Mac &mac, TimeUs now)
    {
        Peer *free = nullptr;
        Peer *lru = nullptr;
        for (Peer &p : peers_) {
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
        if (attempts_ < kLinkRetries) {
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
        f.used = false;
        inflight_ = kNone;
        state_ = State::idle;
        radio_.disarm();
        ++(ok ? stats_.sent : stats_.failed);
        radio_.done(token, ok);
        kick(now);
    }

    Radio &radio_;
    std::array<Frame, kQueueFrames> frames_{};
    std::array<Peer, kUnicastPeers> peers_{};
    uint32_t order_ = 0;
    size_t inflight_ = kNone;
    State state_ = State::idle;
    uint8_t attempts_ = 0;
    TimeUs deadline_ = 0;
    uint32_t owed_ = 0;   // send callbacks the driver still owes: sends that went out minus verdicts in
    TimeUs owed_at_ = 0;  // when the latest send went out
    SchedStats stats_;
};

}  // namespace fr::net::air
