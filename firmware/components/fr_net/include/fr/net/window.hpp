// Duplicate filtering for one sequence space (spec 05 §5.8): the replay window of the ordinary spaces and
// the latest-wins filter of LATEST frames. Header-only and IDF-free; Net keeps one window per hub space
// (UNICAST, BCAST) at 128 bits, the hub's TS router keeps 256-bit ones with the same rules.
#pragma once

#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>

namespace fr::net {

/** RFC 1982 serial comparison on u32 sequence numbers and timestamps: a is after b. */
constexpr bool seq_after(uint32_t a, uint32_t b)
{
    return static_cast<int32_t>(a - b) > 0;
}

/** RFC 1982 on the u16 epochs (05 §5.5): a is a later boot or hub run than b. */
constexpr bool epoch_after(uint16_t a, uint16_t b)
{
    return static_cast<int16_t>(static_cast<uint16_t>(a - b)) > 0;
}

/**
 * `{top_seq, bitmap}` of one (origin, space): a seq after top slides the window, one inside it is a DUP
 * when its bit is already set, one below it is OLD. Seqs compare with serial arithmetic, so a wild seq
 * from a corrupt frame (half the space away) is OLD instead of wiping the history.
 */
template <size_t Bits>
class ReplayWindow
{
    static_assert(Bits > 0 && Bits % 64 == 0, "the window is whole 64-bit words");

public:
    enum class Verdict : uint8_t { fresh, dup, old };

    constexpr ReplayWindow() { reset(0); }

    /** Everything up to and including `floor` counts as received: a WELCOME's ucast_floor/bcast_base. */
    constexpr void reset(uint32_t floor)
    {
        top_ = floor;
        words_.fill(~uint64_t{0});
    }

    /** Classifies `seq` and records it when fresh. */
    constexpr Verdict check_and_set(uint32_t seq)
    {
        const int32_t d = static_cast<int32_t>(seq - top_);
        if (d > 0) {
            shift(static_cast<uint32_t>(d));
            words_[0] |= 1;
            top_ = seq;
            return Verdict::fresh;
        }
        // -d without overflow: INT32_MIN is half the space below, far outside any window.
        const uint64_t off = static_cast<uint64_t>(-static_cast<int64_t>(d));
        if (off >= Bits) {
            return Verdict::old;
        }
        uint64_t &w = words_[off / 64];
        const uint64_t bit = uint64_t{1} << (off % 64);
        if ((w & bit) != 0) {
            return Verdict::dup;
        }
        w |= bit;
        return Verdict::fresh;
    }

    constexpr uint32_t top() const { return top_; }

    /**
     * The highest seq such that every earlier one inside the window was received (HEARTBEAT
     * bcast_watermark, 05 §5.9): one below the oldest gap, or top when there is none.
     */
    constexpr uint32_t watermark() const
    {
        for (size_t i = kWords; i-- > 0;) {
            const uint64_t missing = ~words_[i];
            if (missing != 0) {
                const size_t bit = 63 - static_cast<size_t>(std::countl_zero(missing));
                return top_ - static_cast<uint32_t>(i * 64 + bit) - 1;
            }
        }
        return top_;
    }

private:
    static constexpr size_t kWords = Bits / 64;

    /** Bit k (word k / 64, bit k % 64) stands for seq top - k; sliding by n moves every bit n places up. */
    constexpr void shift(uint32_t n)
    {
        if (n >= Bits) {
            words_.fill(0);
            return;
        }
        const size_t ws = n / 64;
        const size_t bs = n % 64;
        for (size_t i = kWords; i-- > 0;) {
            uint64_t v = i >= ws ? words_[i - ws] << bs : 0;
            if (bs != 0 && i >= ws + 1) {
                v |= words_[i - ws - 1] >> (64 - bs);
            }
            words_[i] = v;
        }
    }

    uint32_t top_ = 0;
    std::array<uint64_t, kWords> words_{};
};

/**
 * `last_seq` per (port, kind) of one origin's LATEST space (05 §5.8): a frame is accepted only when its
 * seq is after the last accepted one. N pairs are tracked; a new pair beyond that evicts the one updated
 * longest ago, which then accepts its next frame (latest-wins frames are idempotent).
 */
template <size_t N>
class LatestFilter
{
public:
    constexpr void clear() { slots_ = {}; }

    /** True when `seq` is newer than the last accepted seq of (port, kind); it then becomes the last. */
    constexpr bool accept(uint8_t port, uint8_t kind, uint32_t seq)
    {
        Slot *victim = &slots_[0];
        for (Slot &s : slots_) {
            if (s.used && s.port == port && s.kind == kind) {
                if (!seq_after(seq, s.seq)) {
                    return false;
                }
                s.seq = seq;
                s.stamp = ++clock_;
                return true;
            }
            if (!s.used) {
                victim = &s;
            } else if (victim->used && s.stamp < victim->stamp) {
                victim = &s;
            }
        }
        *victim = {.used = true, .port = port, .kind = kind, .seq = seq, .stamp = ++clock_};
        return true;
    }

private:
    struct Slot {
        bool used = false;
        uint8_t port = 0;
        uint8_t kind = 0;
        uint32_t seq = 0;
        uint32_t stamp = 0;
    };

    std::array<Slot, N> slots_{};
    uint32_t clock_ = 0;
};

}  // namespace fr::net
