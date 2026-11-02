// fr.csi's pieces below the service (design csi-c1 D10, D11, §12), IDF-free and host-tested: the wire record and
// block head, the record ring between the Wi-Fi task and fr_stream, and the motion feature.
//
// RecordRing: one producer (CsiSink::on_csi on the Wi-Fi task), one consumer (fr_stream), lock-free. Each record
// offered takes the next sequence number, kept or dropped, so a stream's first_index (the record's index since the
// stream began, dropped ones counted) is its sequence number less the stream's base. Entries are variable (the
// record's wire bytes, 18 + len, behind an 8-byte entry head), 4-aligned, never split: one that does not fit before
// the end leaves a wrap marker there and starts at 0. Full, the newest record is dropped and counted (the ones queued
// are older and go first). No PSRAM on the C5 (CSI-1's sensor): CsiService gives it kRingBytes of internal RAM. The
// byte counters are free-running u32s, positions masked: the size is a power of two (which divides 2^32), so they
// stay right across their wrap after 4 GiB.
//
// Motion: per subcarrier, amplitude = isqrt(re^2 + im^2) against an exponential baseline of about 2 s (a shift of
// round(log2(2 s x the record rate)), so the time constant follows the rate), as the mean absolute change of all
// subcarriers relative to the baseline's mean: 16384 is a change as large as the amplitude itself, saturating at 65535
// (4x). Records of one length (one frame format: 53 LLTF, 57 HT20, 245 HE20 subcarriers on the C5) feed it; records
// of another length are skipped until kSwitchAfter of them in a row moved it to theirs (re-seeded), so a router's
// beacons (legacy) among its HE replies do not thrash the baseline. Integer math only.
#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>

#include "fr/hal/csi.hpp"

namespace fr::csi {

/** The wire record's head and the block's (design csi-c1 §12, normative): CSI_RECORD_HEAD_BYTES, CSI_BLOCK_HEAD_BYTES. */
inline constexpr size_t kRecordHeadBytes = 18;
inline constexpr size_t kBlockHeadBytes = 8;
/** A block closes every kBlockMs or before it would pass kBlockMaxBytes (its head included). */
inline constexpr size_t kBlockMaxBytes = 8192;
inline constexpr uint32_t kBlockMs = 100;

inline void put_u16le(uint8_t *p, uint16_t v)
{
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
}
inline void put_u32le(uint8_t *p, uint32_t v)
{
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
    p[2] = static_cast<uint8_t>(v >> 16);
    p[3] = static_cast<uint8_t>(v >> 24);
}
inline uint16_t get_u16le(const uint8_t *p)
{
    return static_cast<uint16_t>(p[0] | p[1] << 8);
}
inline uint32_t get_u32le(const uint8_t *p)
{
    return static_cast<uint32_t>(p[0]) | static_cast<uint32_t>(p[1]) << 8 | static_cast<uint32_t>(p[2]) << 16 |
           static_cast<uint32_t>(p[3]) << 24;
}

/** The record's wire bytes: the 18-byte head (len, t_us, rssi, noise, channel, bb_format, flags, 0, mac), then data. */
inline size_t record_wire_bytes(const hal::CsiRecord &r)
{
    return kRecordHeadBytes + r.data.size();
}
/** Writes the wire record into `out`; its length, or 0 when the data is above kCsiDataMax or `out` is too small. */
size_t encode_record(const hal::CsiRecord &r, std::span<uint8_t> out);
/** A block's head: seq, first_index (u32 LE each). */
inline void encode_block_head(uint8_t *out, uint32_t seq, uint32_t first_index)
{
    put_u32le(out, seq);
    put_u32le(out + 4, first_index);
}

/** floor(sqrt(v)). */
uint32_t isqrt(uint32_t v);

class RecordRing
{
public:
    /** The entry head: total bytes (4-aligned; 0 marks a wrap), wire bytes, sequence number. */
    static constexpr size_t kEntryHead = 8;

    /** The largest power of two at most `bytes` (0 for 0): what bind() uses of them. */
    static constexpr size_t usable(size_t bytes)
    {
        size_t p = 1;
        while (p <= bytes / 2) {
            p *= 2;
        }
        return bytes == 0 ? 0 : p;
    }
    /**
     * usable(bytes) of `mem` (at least 64; less binds nothing); empty. `start` is where the byte counters begin (the
     * host suite starts them just below 2^32 to cross their wrap). Before either side runs.
     */
    void bind(uint8_t *mem, size_t bytes, uint32_t start = 0)
    {
        const size_t n = usable(bytes);
        mem_ = n >= 64 ? mem : nullptr;
        size_ = n >= 64 ? static_cast<uint32_t>(n) : 0;
        head_.store(start, std::memory_order_relaxed);
        tail_.store(start, std::memory_order_relaxed);
        next_seq_ = 0;
        offered_.store(0, std::memory_order_relaxed);
        dropped_.store(0, std::memory_order_relaxed);
    }
    bool bound() const { return mem_ != nullptr; }

    // ---- producer (Wi-Fi task) ----

    /** Copies `r` in (it takes the next sequence number); false when it did not fit and was dropped. */
    bool push(const hal::CsiRecord &r);

    // ---- consumer (fr_stream) ----

    struct View {
        uint32_t seq = 0;
        std::span<const uint8_t> wire;  // the wire record, valid until pop()
    };
    /** The oldest record; false when none. */
    bool peek(View &out);
    /** Drops the record peek() gave. */
    void pop();

    // ---- any task ----

    /** Sequence numbers handed out: [0, offered()) were offered (kept or dropped). */
    uint32_t offered() const { return offered_.load(std::memory_order_acquire); }
    uint32_t dropped() const { return dropped_.load(std::memory_order_relaxed); }
    size_t capacity() const { return size_; }

private:
    uint32_t at(uint32_t counter) const { return counter & (size_ - 1); }

    uint8_t *mem_ = nullptr;
    uint32_t size_ = 0;  // a power of two (0: unbound)
    std::atomic<uint32_t> head_{0};  // bytes written, ever (producer)
    std::atomic<uint32_t> tail_{0};  // bytes consumed, ever (consumer)
    uint32_t next_seq_ = 0;          // producer only
    std::atomic<uint32_t> offered_{0};
    std::atomic<uint32_t> dropped_{0};
};

class Motion
{
public:
    /** Subcarriers at most (kCsiDataMax / 2). */
    static constexpr size_t kMaxSub = hal::kCsiDataMax / 2;
    /** Records of another length in a row that move the baseline to theirs. */
    static constexpr uint32_t kSwitchAfter = 32;
    /** 100 %: a mean change as large as the baseline amplitude. */
    static constexpr uint32_t kUnit = 16384;
    /** The baseline's time constant. */
    static constexpr uint32_t kBaselineMs = 2000;

    /** The baseline is re-seeded from the next record (baseline_reset). */
    void reset() { seeded_ = false; }
    /**
     * One record's data ((imaginary, real) per subcarrier); `rate_hz` the records per second now (0: unknown, taken as
     * 100). False when it did not count (another length, or it seeded the baseline).
     */
    bool add(std::span<const int8_t> data, bool first_word_invalid, uint32_t rate_hz);
    /** The window's motion (the mean of its records'; 0 without any), and a new window. */
    uint16_t close();
    /** The baseline's shift at `rate_hz` (k: base += (amp - base) / 2^k). */
    static uint32_t shift_for(uint32_t rate_hz);
    /** Subcarriers the baseline follows (0: none yet). */
    size_t subcarriers() const { return seeded_ ? n_ : 0; }

private:
    std::array<int32_t, kMaxSub> base_{};  // Q8 amplitudes
    size_t n_ = 0;
    bool seeded_ = false;
    uint32_t others_ = 0;
    uint64_t win_sum_ = 0;
    uint32_t win_n_ = 0;
};

}  // namespace fr::csi
