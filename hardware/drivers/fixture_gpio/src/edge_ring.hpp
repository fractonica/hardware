// The fixture_gpio edge ring (design m2-c1-hil D4): one ring for every line, filled by the IRAM edge ISR and
// the press timers, emptied on the core task. fr_core's input slots keep only the newest level, its time and
// a count (input_slot_isr.cpp); a HIL line needs every edge with its own stamp. IDF-free: the host suite
// tests it (firmware/test/host/tests/fixture_edge_ring_test.cpp).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace fr::drv::fixture {

/** One captured edge: when (esp_timer µs, low 32 bits), on which line, and the level after it. */
struct RingEdge {
    uint32_t t_us;
    uint8_t ch;
    uint8_t level;
};

/**
 * A FIFO of RingEdge with a per-line overflow count. Full, it keeps what it holds and counts the new edge
 * as dropped on that edge's line, which the next `edges` batch of that line reports. Not synchronised:
 * the driver calls every method under its spinlock (the ISRs on one core, the core task on the other).
 */
template <size_t N = 256, size_t Channels = 16>
class EdgeRing
{
    static_assert(N > 0 && (N & (N - 1)) == 0, "the ring size must be a power of two");

public:
    static constexpr size_t kCapacity = N;
    static constexpr size_t kChannels = Channels;

    /** False, counting it as dropped, when the ring is full (or `ch` is out of range: nothing is counted). */
    bool push(uint32_t t_us, uint8_t ch, bool level)
    {
        if (ch >= Channels) {
            return false;
        }
        if (len_ == N) {
            ++dropped_[ch];
            return false;
        }
        items_[(head_ + len_) & (N - 1)] = {t_us, ch, static_cast<uint8_t>(level ? 1 : 0)};
        ++len_;
        return true;
    }

    /** The oldest edge; false when empty. */
    bool pop(RingEdge &out)
    {
        if (len_ == 0) {
            return false;
        }
        out = items_[head_];
        head_ = (head_ + 1) & (N - 1);
        --len_;
        return true;
    }

    /** Edges of line `ch` dropped since the previous call. */
    uint32_t take_dropped(uint8_t ch)
    {
        if (ch >= Channels) {
            return 0;
        }
        const uint32_t d = dropped_[ch];
        dropped_[ch] = 0;
        return d;
    }

    size_t size() const { return len_; }
    bool empty() const { return len_ == 0; }

private:
    std::array<RingEdge, N> items_{};
    std::array<uint32_t, Channels> dropped_{};
    size_t head_ = 0;
    size_t len_ = 0;
};

}  // namespace fr::drv::fixture
