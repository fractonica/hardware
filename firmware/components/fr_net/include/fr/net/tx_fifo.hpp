// The TCP link's transmit queue (design c3 §3 "Links"): a single-producer single-consumer byte FIFO of
// whole records `len u16 LE | envelope`, appended by the core task and taken by the fr_net task in as few
// send() calls as the ring allows (one segment for a burst of small frames). IDF-free, so the host suite
// runs it across the wrap of its counters.
#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>
#include <type_traits>

namespace fr::net {

/**
 * `N` bytes of ring. The positions run free (head - tail is the fill, modulo 2^bits) and map onto the ring
 * as `pos % N`, which stays continuous across the counters' wrap only when N divides 2^bits: a power of
 * two. `Index` is size_t on target (32 bits on C3/C6/S3, wrapping after 4 GiB of TCP); tests pick
 * uint32_t on a 64-bit host and start near the wrap.
 */
template <size_t N, class Index = size_t>
class TxFifo
{
    static_assert(N >= 4 && (N & (N - 1)) == 0, "the ring must be a power of two");
    static_assert(std::is_unsigned_v<Index> && sizeof(Index) >= sizeof(unsigned), "free-running unsigned counters");

public:
    static constexpr size_t kBytes = N;

    TxFifo() = default;
    /** Test hook: counters that start at `at` (near the wrap). */
    explicit TxFifo(Index at) : head_(at), tail_(at) {}

    /** Producer. False when the record does not fit (the frame is dropped, never split). */
    bool push(std::span<const uint8_t> env)
    {
        const Index head = head_.load(std::memory_order_relaxed);
        const Index tail = tail_.load(std::memory_order_acquire);
        const size_t need = 2 + env.size();
        if (env.size() > 0xFFFF || N - fill(head, tail) < need) {
            return false;
        }
        put(head, static_cast<uint8_t>(env.size() & 0xFF));
        put(static_cast<Index>(head + 1), static_cast<uint8_t>(env.size() >> 8));
        const size_t at = offset(static_cast<Index>(head + 2));
        const size_t first = std::min(env.size(), N - at);
        std::memcpy(buf_ + at, env.data(), first);
        std::memcpy(buf_, env.data() + first, env.size() - first);
        head_.store(static_cast<Index>(head + need), std::memory_order_release);
        pushed_.fetch_add(1, std::memory_order_relaxed);
        return true;
    }

    /** Consumer: the next contiguous run of queued bytes (empty when none). */
    std::span<const uint8_t> peek() const
    {
        const Index tail = tail_.load(std::memory_order_relaxed);
        const Index head = head_.load(std::memory_order_acquire);
        const size_t at = offset(tail);
        return {buf_ + at, std::min(fill(head, tail), N - at)};
    }

    /** Consumer: `n` bytes went to the socket. Tracks record boundaries only to count whole frames. */
    void consume(size_t n)
    {
        Index tail = tail_.load(std::memory_order_relaxed);
        while (n > 0) {
            if (rec_left_ == 0) {
                rec_left_ = 2 + (get(tail) | static_cast<size_t>(get(static_cast<Index>(tail + 1))) << 8);
            }
            const size_t take = std::min(n, rec_left_);
            rec_left_ -= take;
            tail = static_cast<Index>(tail + take);
            n -= take;
            if (rec_left_ == 0) {
                ++sent_;
            }
        }
        tail_.store(tail, std::memory_order_release);
    }

    /** Consumer: forgets everything queued (a connection ended); returns the frames lost. */
    uint32_t discard()
    {
        tail_.store(head_.load(std::memory_order_acquire), std::memory_order_release);
        rec_left_ = 0;
        const uint32_t pushed = pushed_.load(std::memory_order_relaxed);
        const uint32_t lost = pushed - sent_;
        sent_ = pushed;
        return lost;
    }

    bool empty() const { return head_.load(std::memory_order_acquire) == tail_.load(std::memory_order_relaxed); }

private:
    static size_t fill(Index head, Index tail) { return static_cast<size_t>(static_cast<Index>(head - tail)); }
    static size_t offset(Index pos) { return static_cast<size_t>(pos % N); }
    void put(Index pos, uint8_t v) { buf_[offset(pos)] = v; }
    uint8_t get(Index pos) const { return buf_[offset(pos)]; }

    uint8_t buf_[N];
    std::atomic<Index> head_{0};
    std::atomic<Index> tail_{0};
    std::atomic<uint32_t> pushed_{0};  // producer
    uint32_t sent_ = 0;                // consumer
    size_t rec_left_ = 0;              // consumer: bytes of the current record still to send
};

}  // namespace fr::net
