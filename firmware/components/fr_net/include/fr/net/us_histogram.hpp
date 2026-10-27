// A log-linear histogram of µs spans (design m2-c4-gateway D19): spike S2's RTT and peer-table figures as p50, p99
// and max without keeping the samples (10,000 echoes would not fit). Exact below 32 µs, then 16 bins per power of two
// up to 2^19 µs (about 0.5 s; longer spans share the last bin), so a percentile is within 1/16 (6 %) of the true
// value; the maximum is kept exactly. IDF-free, no heap: 1 KB per histogram.
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>

namespace fr::net {

class UsHistogram
{
public:
    static constexpr size_t kExact = 32;
    static constexpr uint32_t kSubBits = 4;  // 16 bins per octave
    static constexpr uint32_t kTopOctave = 18;
    static constexpr size_t kBins = kExact + (kTopOctave - 4) * (1u << kSubBits);  // 256

    void add(uint32_t us)
    {
        ++n_[bin(us)];
        ++count_;
        max_ = std::max(max_, us);
    }
    void clear() { *this = UsHistogram{}; }
    uint32_t count() const { return count_; }
    uint32_t max() const { return max_; }
    /** The value at rank `permille` (500: the median, 990: p99): the upper edge of the bin holding it, never above the
     * maximum; 0 without samples. */
    uint32_t percentile(uint32_t permille) const
    {
        if (count_ == 0) {
            return 0;
        }
        // The smallest value with at least ceil(count * permille / 1000) samples at or below it.
        const uint64_t rank = std::max<uint64_t>(1, (uint64_t{count_} * permille + 999) / 1000);
        uint64_t seen = 0;
        for (size_t b = 0; b < kBins; ++b) {
            seen += n_[b];
            if (seen >= rank) {
                return std::min(upper(b), max_);
            }
        }
        return max_;
    }

private:
    static size_t bin(uint32_t v)
    {
        if (v < kExact) {
            return v;
        }
        uint32_t e = 31 - static_cast<uint32_t>(__builtin_clz(v));  // floor(log2 v), 5 or more here
        if (e > kTopOctave) {
            return kBins - 1;
        }
        const uint32_t sub = (v >> (e - kSubBits)) & ((1u << kSubBits) - 1);
        return kExact + (e - 5) * (1u << kSubBits) + sub;
    }
    /** The largest value bin `b` holds (UINT32_MAX for the last). */
    static uint32_t upper(size_t b)
    {
        if (b < kExact) {
            return static_cast<uint32_t>(b);
        }
        if (b == kBins - 1) {
            return UINT32_MAX;
        }
        const uint32_t i = static_cast<uint32_t>(b - kExact);
        const uint32_t e = 5 + i / (1u << kSubBits);
        const uint32_t sub = i % (1u << kSubBits);
        const uint32_t lo = (1u << e) | (sub << (e - kSubBits));
        return lo + (1u << (e - kSubBits)) - 1;
    }

    std::array<uint32_t, kBins> n_{};
    uint32_t count_ = 0;
    uint32_t max_ = 0;
};

}  // namespace fr::net
