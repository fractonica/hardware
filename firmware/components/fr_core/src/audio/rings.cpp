// fr:realtime
#include "fr/audio/rings.hpp"

#include <algorithm>
#include <cstring>

#include "fr/audio/rt.hpp"

namespace fr::audio {

// ---- RecordRing ----

void RecordRing::bind(int16_t *mem, size_t bytes, void *mutex)
{
    mem_ = mem;
    bytes_ = bytes;
    mutex_ = mutex;
    block_ = 0;
    slots_ = 0;
}

bool RecordRing::reset(uint32_t block)
{
    const LockGuard g(mutex_);
    const size_t fit = block > 0 && mem_ != nullptr ? bytes_ / (static_cast<size_t>(block) * sizeof(int16_t)) : 0;
    slots_ = std::min(fit, kRecordSlotsMax);
    block_ = slots_ >= 3 ? block : 0;
    nfree_ = 0;
    for (size_t i = 0; i < slots_; ++i) {
        free_[nfree_++] = static_cast<uint8_t>(slots_ - 1 - i);  // slot 0 on top
    }
    qhead_ = 0;
    qlen_ = 0;
    filling_ = kNone;
    flight_ = kNone;
    dropped_.store(0, std::memory_order_release);
    overflows_.store(0, std::memory_order_relaxed);
    return block_ != 0;
}

std::span<int16_t> RecordRing::acquire()
{
    if (block_ == 0) {
        return {};
    }
    const LockGuard g(mutex_);
    if (filling_ == kNone) {
        if (nfree_ > 0) {
            filling_ = free_[--nfree_];
        } else if (qlen_ > 0) {
            // Full: the oldest queued block goes (design D4); its samples are the gap the hub fills with silence.
            filling_ = queue_[qhead_];
            qhead_ = (qhead_ + 1) % slots_;
            --qlen_;
            dropped_.fetch_add(meta_[filling_].len, std::memory_order_acq_rel);
            dropped_total_.fetch_add(meta_[filling_].len, std::memory_order_relaxed);
            overflows_.fetch_add(1, std::memory_order_relaxed);
        } else {
            return {};  // cannot happen with 3 slots or more: one filling, one in flight, one queued or free
        }
    }
    return {mem_ + static_cast<size_t>(filling_) * block_, block_};
}

void RecordRing::publish(uint32_t len, uint32_t first_sample)
{
    const LockGuard g(mutex_);
    if (filling_ == kNone) {
        return;
    }
    meta_[filling_] = {.len = std::min(len, block_), .first_sample = first_sample};
    queue_[(qhead_ + qlen_) % slots_] = filling_;
    ++qlen_;
    filling_ = kNone;
}

void RecordRing::discard(uint32_t len)
{
    dropped_.fetch_add(std::min(len, block_), std::memory_order_acq_rel);
    dropped_total_.fetch_add(std::min(len, block_), std::memory_order_relaxed);
}

bool RecordRing::take(Block &out)
{
    const LockGuard g(mutex_);
    if (flight_ != kNone || qlen_ == 0) {
        return false;
    }
    flight_ = queue_[qhead_];
    qhead_ = (qhead_ + 1) % slots_;
    --qlen_;
    out = {.pcm = mem_ + static_cast<size_t>(flight_) * block_,
           .len = meta_[flight_].len,
           .first_sample = meta_[flight_].first_sample};
    return true;
}

void RecordRing::release()
{
    const LockGuard g(mutex_);
    if (flight_ != kNone) {
        free_[nfree_++] = flight_;
        flight_ = kNone;
    }
}

size_t RecordRing::queued() const
{
    const LockGuard g(mutex_);
    return qlen_;
}

// ---- PcmRing ----
// head_ and tail_ run over [0, 2 cap): equal is empty, a distance of cap is full.

void PcmRing::bind(int16_t *mem, size_t samples)
{
    mem_ = mem;
    cap_ = mem != nullptr ? samples : 0;
    reset();
}

void PcmRing::reset()
{
    head_.store(0, std::memory_order_relaxed);
    tail_.store(0, std::memory_order_relaxed);
}

size_t PcmRing::size() const
{
    if (cap_ == 0) {
        return 0;
    }
    const uint32_t h = head_.load(std::memory_order_acquire);
    const uint32_t t = tail_.load(std::memory_order_acquire);
    return (h + 2 * cap_ - t) % (2 * cap_);
}

size_t PcmRing::write(std::span<const int16_t> in)
{
    if (cap_ == 0) {
        return 0;
    }
    const uint32_t h = head_.load(std::memory_order_relaxed);
    const uint32_t t = tail_.load(std::memory_order_acquire);
    const size_t used = (h + 2 * cap_ - t) % (2 * cap_);
    const size_t n = std::min(in.size(), cap_ - used);
    if (n == 0) {
        return 0;
    }
    const size_t at = h % cap_;
    const size_t first = std::min(n, cap_ - at);
    std::memcpy(mem_ + at, in.data(), first * sizeof(int16_t));
    std::memcpy(mem_, in.data() + first, (n - first) * sizeof(int16_t));
    head_.store(static_cast<uint32_t>((h + n) % (2 * cap_)), std::memory_order_release);
    return n;
}

size_t PcmRing::read(std::span<int16_t> out)
{
    if (cap_ == 0) {
        return 0;
    }
    const uint32_t t = tail_.load(std::memory_order_relaxed);
    const uint32_t h = head_.load(std::memory_order_acquire);
    const size_t used = (h + 2 * cap_ - t) % (2 * cap_);
    const size_t n = std::min(out.size(), used);
    if (n == 0) {
        return 0;
    }
    const size_t at = t % cap_;
    const size_t first = std::min(n, cap_ - at);
    std::memcpy(out.data(), mem_ + at, first * sizeof(int16_t));
    std::memcpy(out.data() + first, mem_, (n - first) * sizeof(int16_t));
    tail_.store(static_cast<uint32_t>((t + n) % (2 * cap_)), std::memory_order_release);
    return n;
}

void PcmRing::discard_all()
{
    tail_.store(head_.load(std::memory_order_acquire), std::memory_order_release);
}

}  // namespace fr::audio
