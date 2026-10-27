// One node's radio (design m2-c2 D5): the real air::Scheduler over the Medium, and espnow.cpp's service on the node's
// network queue. The medium calls received() and transmitted() from executor events (never inside transmit()); both
// only copy into a mailbox and ask for the coalesced service, which then feeds the scheduler and Net on the core task,
// in espnow.cpp's order: verdicts before the timer, then up to four received frames, re-requested while more remain.
#include "sim/sim_air.hpp"

#include <algorithm>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/wire.hpp"
#include "sim/airtime.hpp"
#include "sim/rng.hpp"

namespace frsim {

namespace {

// Envelope v1 (05 §5.6): magic_ver, flags, cls, kind, seq u32, then net u16 LE (espnow.cpp's kNetOffset).
constexpr size_t kNetOffset = 8;
constexpr uint32_t kPostRetryUs = 1'000;

}  // namespace

SimAir::SimAir(Medium &medium, SimCore &core, const fr::net::Mac &mac, uint8_t channel, Rate bcast_rate, Rate ucast_rate)
    : medium_(medium), core_(core), mac_(mac), channel_(channel), bcast_rate_(bcast_rate), ucast_rate_(ucast_rate)
{
    sched_.emplace(*this);
    radio_ = medium_.add_radio(*this, mac_, channel_);
}

void SimAir::attach(fr::net::Net &net)
{
    net_ = &net;
}

void SimAir::set_net(uint16_t net)
{
    net_id_ = net;
}

void SimAir::crash()
{
    core_.executor().cancel(arm_event_);
    arm_event_ = 0;
    rx_head_ = rx_tail_ = 0;
    verdicts_ = 0;
    last_ok_ = false;
    timer_due_ = false;
    posted_ = false;
    net_ = nullptr;
    sched_.reset();
    sched_.emplace(*this);
}

void SimAir::set_up(bool up)
{
    up_ = up;
}

void SimAir::set_channel(uint8_t channel)
{
    channel_ = channel;
    medium_.set_channel(radio_, channel);
}

void SimAir::set_knobs(const Knobs &knobs)
{
    knobs_ = knobs;
}

RadioId SimAir::radio() const
{
    return radio_;
}

const fr::net::air::Scheduler &SimAir::scheduler() const
{
    return *sched_;
}

const SimAir::Stats &SimAir::stats() const
{
    return stats_;
}

bool SimAir::up() const
{
    return up_;
}

fr::Status SimAir::send(const fr::net::Mac &dst, std::span<const uint8_t> envelope, fr::net::AirPrio prio, uint32_t token)
{
    if (!up_) {
        return std::unexpected(fr::Err::failed);
    }
    const fr::Status st = sched_->send(dst, envelope, prio, token, core_.now());
    if (st) {
        ++stats_.sent_by_prio[static_cast<size_t>(prio)];
    }
    return st;
}

bool SimAir::add_peer(const fr::net::Mac &mac)
{
    static_cast<void>(mac);
    if (knob(knobs_.add_peer_fail_permille, static_cast<uint8_t>(rng::Purpose::add_peer))) {
        ++stats_.peer_add_failed;
        return false;
    }
    ++stats_.peer_adds;
    return true;
}

void SimAir::del_peer(const fr::net::Mac &mac)
{
    static_cast<void>(mac);
    ++stats_.peer_dels;
}

bool SimAir::transmit(const fr::net::Mac &dst, std::span<const uint8_t> frame)
{
    if (!up_) {
        return false;  // esp_now_send fails while ESP-NOW is down: a failed attempt, no callback
    }
    const bool broadcast = fr::net::air::is_broadcast(dst);
    const Rate rate = broadcast ? bcast_rate_ : ucast_rate_;
    stats_.airtime_us += airtime::exchange_us(rate, frame.size(), !broadcast);
    medium_.transmit(radio_, dst, frame, rate);
    return true;
}

void SimAir::arm(uint32_t delay_us)
{
    Executor &exec = core_.executor();
    exec.cancel(arm_event_);
    const uint32_t gen = core_.generation();
    arm_event_ = exec.after(delay_us, [this, gen] {
        if (core_.generation() != gen) {
            return;
        }
        arm_event_ = 0;
        timer_due_ = true;
        request_service();
    });
}

void SimAir::disarm()
{
    core_.executor().cancel(arm_event_);
    arm_event_ = 0;
}

void SimAir::done(uint32_t token, bool ok)
{
    if (net_ != nullptr) {
        net_->air_sent(token, ok);
    }
}

void SimAir::received(std::span<const uint8_t> frame, const fr::net::RxMeta &meta)
{
    if (!up_) {
        return;  // not listening
    }
    // espnow.cpp's receive filter: channel C, length (18..250), magic/version, net.
    const bool bad_net = net_id_ != 0 && frame.size() > kNetOffset + 1 &&
                         static_cast<uint16_t>(frame[kNetOffset] | frame[kNetOffset + 1] << 8) != net_id_;
    if (meta.channel != channel_ || frame.size() < fr::wire::kHeaderSize || frame.size() > fr::net::air::kMtu ||
        frame[0] != fr::wire::kMagicVer || bad_net) {
        ++stats_.rx_bad;
        return;
    }
    if (rx_head_ - rx_tail_ >= kRxRing) {
        ++stats_.ring_drops;  // diag rx_lost: the core task has not caught up
        return;
    }
    RxSlot &slot = ring_[rx_head_ % kRxRing];
    slot.len = static_cast<uint8_t>(frame.size());
    std::copy(frame.begin(), frame.end(), slot.bytes.begin());
    slot.meta = meta;
    ++rx_head_;
    ++stats_.rx;
    request_service();
}

void SimAir::transmitted(bool ok)
{
    if (knob(knobs_.lost_cb_permille, static_cast<uint8_t>(rng::Purpose::lost_cb))) {
        return;  // the driver never calls back: the scheduler's guard, then its lost rule
    }
    if (knob(knobs_.late_cb_permille, static_cast<uint8_t>(rng::Purpose::late_cb))) {
        const uint32_t gen = core_.generation();
        core_.executor().after(knobs_.late_cb_us, [this, gen, ok] {
            if (core_.generation() == gen) {
                verdict(ok);
            }
        });
        return;
    }
    verdict(ok);
}

uint32_t SimAir::generation() const
{
    return core_.generation();
}

bool SimAir::listening() const
{
    return up_;  // a node powered off (set_up(false)) hears nothing and ACKs nothing on the medium
}

void SimAir::verdict(bool ok)
{
    ++verdicts_;
    last_ok_ = ok;
    request_service();
}

bool SimAir::knob(uint32_t permille, uint8_t purpose)
{
    if (permille == 0) {
        return false;
    }
    const double u = rng::uniform(medium_.config().seed, mac_, ++knob_draws_, mac_, static_cast<rng::Purpose>(purpose));
    return u * 1000.0 < static_cast<double>(permille);
}

void SimAir::request_service()
{
    if (posted_) {
        return;  // the queued one sees this work too
    }
    posted_ = true;
    const uint32_t gen = core_.generation();
    if (!core_.post_net([this, gen] {
            if (core_.generation() == gen) {
                service();
            }
        })) {
        posted_ = false;
        core_.executor().after(kPostRetryUs, [this, gen] {
            if (core_.generation() == gen) {
                request_service();
            }
        });
    }
}

void SimAir::service()
{
    posted_ = false;  // anything from here on asks again
    const fr::TimeUs now = core_.now();
    // The verdicts before the timer: a stale timer then finds the frame's state moved on and is ignored.
    if (verdicts_ != 0) {
        const uint32_t n = verdicts_;
        verdicts_ = 0;
        sched_->sent(n, last_ok_, now);
    }
    if (timer_due_) {
        timer_due_ = false;
        sched_->timer(now);
    }
    const uint32_t gen = core_.generation();
    for (size_t n = 0; n < kServiceBatch && rx_tail_ != rx_head_; ++n) {
        const RxSlot &slot = ring_[rx_tail_ % kRxRing];
        ++rx_tail_;  // before Net sees it: the frame is the core task's now
        if (net_ != nullptr) {
            net_->receive_air({slot.bytes.data(), slot.len}, slot.meta);  // Net copies what it keeps
        }
        if (core_.generation() != gen) {
            return;  // the frame crashed the node (crash() reset this radio)
        }
    }
    if (rx_tail_ != rx_head_) {
        request_service();
    }
}

}  // namespace frsim
