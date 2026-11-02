// The audio services' rings (design audio-a1 D4, D5), between the fr_audio task (I2S) and the fr_stream task
// (sockets). IDF-free; the memory comes from Rt::alloc (PSRAM on the board when it has some).
//
// Sizes (Rt::psram()):
//   - record (RecordRing): with PSRAM 22 blocks of 100 ms at up to 48 kHz (211,200 B): 2 s queued, plus the block
//     fr_audio fills and the one fr_stream sends. Without PSRAM 32,000 B of internal RAM: as many 100 ms blocks of the
//     stream's rate as fit (at least 3, at most 22), so about 0.8 s at 16 kHz and 0.1 s at 48 kHz queued.
//   - play (PcmRing): with PSRAM 1 s at 48 kHz (96,000 B); without, 16,000 B (0.5 s at 16 kHz, 0.17 s at 48 kHz).
#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>

namespace fr::audio {

inline constexpr size_t kRecordSlotsMax = 22;
inline constexpr size_t kRecordRingBytesPsram = kRecordSlotsMax * 4800 * sizeof(int16_t);
inline constexpr size_t kRecordRingBytesInternal = 32000;
inline constexpr size_t kPlayRingBytesPsram = 48000 * sizeof(int16_t);
inline constexpr size_t kPlayRingBytesInternal = 16000;

/** Samples per record block at `sample_hz`: 100 ms (design D3). */
constexpr uint32_t block_samples(uint32_t sample_hz)
{
    return sample_hz / 10;
}

/**
 * The record ring: whole blocks of PCM, oldest first, each with the index of its first sample since the stream began.
 * One producer (fr_audio) fills a block it owns, then publishes it; one consumer (fr_stream) takes the oldest into
 * flight, sends it from the ring's memory, and releases it. When the producer needs a block and none is free it drops
 * the oldest queued one (counted in dropped_samples(): the stream's first_sample then jumps, design D4); the block in
 * flight is never touched. Slots move through a free list and a queue of slot numbers under one mutex (Rt), held for
 * a few index moves only, never across a copy or a send.
 */
class RecordRing
{
public:
    struct Block {
        const int16_t *pcm = nullptr;
        uint32_t len = 0;           // samples (block_samples(), the stream's last block possibly fewer)
        uint32_t first_sample = 0;  // since the stream began
    };

    /** The memory (`bytes` of int16) and the mutex (nullptr: none, single-threaded tests). Init. */
    void bind(int16_t *mem, size_t bytes, void *mutex);
    /** Empties the ring for a stream of `block` samples per block; false when fewer than 3 blocks fit. */
    bool reset(uint32_t block);

    // ---- producer (fr_audio) ----
    /**
     * A block to fill (block() samples): a free one, or the oldest queued one, whose samples count as dropped. The
     * producer owns it until publish() or discard().
     */
    std::span<int16_t> acquire();
    /** Queues the acquired block with `len` samples from `first_sample`. */
    void publish(uint32_t len, uint32_t first_sample);
    /** Drops the acquired block's `len` samples (the stall hook): counted, never queued; the block stays acquired. */
    void discard(uint32_t len);

    // ---- consumer (fr_stream) ----
    /** Takes the oldest queued block into flight; false when none is queued (or one is in flight already). */
    bool take(Block &out);
    /** The block in flight is done with (sent or abandoned): its slot is free again. */
    void release();

    uint32_t block() const { return block_; }
    size_t slots() const { return slots_; }
    size_t queued() const;
    /** Samples dropped since reset(): overflows and discards. */
    uint32_t dropped_samples() const { return dropped_.load(std::memory_order_acquire); }
    /** Samples dropped since bind(), every stream's (diag `stats audio`). */
    uint32_t dropped_total() const { return dropped_total_.load(std::memory_order_relaxed); }
    /** Blocks dropped by overflow since reset() (discards not counted). */
    uint32_t overflows() const { return overflows_.load(std::memory_order_relaxed); }

private:
    static constexpr uint8_t kNone = 0xFF;

    struct Meta {
        uint32_t len = 0;
        uint32_t first_sample = 0;
    };

    int16_t *mem_ = nullptr;
    size_t bytes_ = 0;
    void *mutex_ = nullptr;
    uint32_t block_ = 0;
    size_t slots_ = 0;
    // Under the mutex:
    std::array<uint8_t, kRecordSlotsMax> free_{};  // a stack of free slot numbers
    size_t nfree_ = 0;
    std::array<uint8_t, kRecordSlotsMax> queue_{};  // queued slot numbers, oldest at qhead_
    size_t qhead_ = 0;
    size_t qlen_ = 0;
    std::array<Meta, kRecordSlotsMax> meta_{};
    uint8_t filling_ = kNone;  // the producer's
    uint8_t flight_ = kNone;   // the consumer's
    std::atomic<uint32_t> dropped_{0};
    std::atomic<uint32_t> overflows_{0};
    std::atomic<uint32_t> dropped_total_{0};
};

/**
 * The play ring: samples from fr_stream (the GET) to fr_audio (I2S), single producer and single consumer, lock-free.
 * discard_all() is the consumer's: it empties the ring once the producer has stopped writing for the old play.
 */
class PcmRing
{
public:
    void bind(int16_t *mem, size_t samples);
    /** Both sides idle only. */
    void reset();

    /** Producer: writes what fits; how many. */
    size_t write(std::span<const int16_t> in);
    /** Consumer: reads up to out.size(); how many. */
    size_t read(std::span<int16_t> out);
    /** Consumer: everything written so far is dropped. */
    void discard_all();

    size_t size() const;
    size_t room() const { return cap_ - size(); }
    size_t capacity() const { return cap_; }

private:
    int16_t *mem_ = nullptr;
    size_t cap_ = 0;
    std::atomic<uint32_t> head_{0};  // written (producer)
    std::atomic<uint32_t> tail_{0};  // read (consumer)
};

}  // namespace fr::audio
