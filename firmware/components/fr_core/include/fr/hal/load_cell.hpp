// L1 load cell contract (design scale-round-c1 D7): a bridge ADC (the HX711) converts at its own rate and hands each
// conversion over through a small lock-free ring; ScaleService drains it on the core task and does everything else
// (filter, tare and calibration, stability, `settled`, the reports).
//
// Threading: init(), start(), stop() and take() run on the core task (init at board init); the driver's own context (a
// task woken by the data-ready interrupt) pushes the conversions. rate_hz() and selftest() may run on any task.
#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** The channel and gain the clock train selects (fr.scale Gain, same values). */
enum class LoadCellGain : uint8_t { a128 = 0, a64 = 1, b32 = 2 };

/** One conversion: the raw code sign-extended from the part's resolution, and when it became ready (esp_timer µs). */
struct LoadCellSample {
    int32_t raw = 0;
    TimeUs at = 0;
};

/**
 * Single-producer single-consumer ring of conversions: the driver's context pushes, the core task pops. Lock-free
 * (two indices published with release, read with acquire); a push into a full ring is refused and counted, so the
 * oldest conversions stay and the newest is lost (the core drains every few ms; a full ring means it stalled).
 */
template <size_t N>
class SampleRing
{
    static_assert(N >= 2 && (N & (N - 1)) == 0, "a power of two");

public:
    /** Producer side. False (and counted) when full. */
    bool push(const LoadCellSample &s)
    {
        const uint32_t head = head_.load(std::memory_order_relaxed);
        const uint32_t tail = tail_.load(std::memory_order_acquire);
        if (head - tail >= N) {
            dropped_.store(dropped_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
            return false;
        }
        buf_[head % N] = s;
        head_.store(head + 1, std::memory_order_release);
        return true;
    }

    /** Consumer side: the oldest sample; false when empty. */
    bool pop(LoadCellSample &out)
    {
        const uint32_t tail = tail_.load(std::memory_order_relaxed);
        if (tail == head_.load(std::memory_order_acquire)) {
            return false;
        }
        out = buf_[tail % N];
        tail_.store(tail + 1, std::memory_order_release);
        return true;
    }

    /** Pushes refused because the ring was full, since boot. Any task. */
    uint32_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

private:
    std::array<LoadCellSample, N> buf_{};
    std::atomic<uint32_t> head_{0};
    std::atomic<uint32_t> tail_{0};
    std::atomic<uint32_t> dropped_{0};  // the producer's alone (no read-modify-write needed across contexts)
};

/** A load cell through a bridge ADC (hx711_gpio). */
class LoadCell
{
public:
    /** Pins and the driver's context; the part stays powered down (no conversion yet). Board init. */
    virtual Status init(Core &core) = 0;
    /**
     * Powers the part up; conversions start coming, the first ones after the part has settled at `gain`. A repeat call
     * changes the gain from the next conversion. Err::failed before init. Core task.
     */
    virtual Status start(LoadCellGain gain) = 0;
    /** Powers the part down (HX711: SCK held high); OK when stopped. Core task. */
    virtual Status stop() = 0;
    /** The oldest conversion not taken yet; false when none. Core task (the ring's one consumer). */
    virtual bool take(LoadCellSample &out) = 0;
    /** Conversions completed over the last full second; 0 when the part does not answer. Any task. */
    virtual uint8_t rate_hz() const = 0;
    /** The part's resolution (fr.scale trait resolution_bits: 24 on the HX711). */
    virtual uint8_t resolution_bits() const = 0;
    /** The part's fastest conversion rate (fr.scale trait max_rate_hz: 80 on the HX711). */
    virtual uint8_t max_rate_hz() const = 0;
    /** Conversions lost because the core task did not take them in time, since boot. Any task. */
    virtual uint32_t overruns() const { return 0; }
    /** A conversion within 200 ms and a raw code not stuck at the part's limits. Any task; may wait up to 200 ms. */
    virtual Selftest selftest() = 0;

protected:
    ~LoadCell() = default;
};

}  // namespace fr::hal
