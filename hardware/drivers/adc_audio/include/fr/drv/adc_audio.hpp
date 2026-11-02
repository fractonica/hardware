// adc_audio (design audio-a2 D2; spec 07 §7.8): hal::AudioSource on one ADC1 channel through IDF adc_continuous (DMA),
// for any analog signal at audio rate (A2: a diode RF envelope detector). AudioInService calls start(), read() and
// stop() from its fr_audio task only (fr/hal/audio.hpp), so A1's gain, DC blocker, warm-up and meter apply unchanged.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/core/core.hpp"
#include "fr/hal/audio.hpp"

struct adc_continuous_ctx_t;  // IDF's adc_continuous_handle_t points at it; IDF headers stay out of this one

namespace fr::drv {

/**
 * The ADC1 unit in continuous mode on cfg.gpio's channel at cfg.atten, converting at sample_hz x oversample (capped at
 * kMaxConversionsHz: start() at a faster rate uses floor(kMaxConversionsHz / sample_hz), at least 1) and averaging
 * each group of conversions into one sample. A sample is the 12-bit mean left-justified into the int32_t slot (bits
 * 31..20, the fraction of the mean below them), centred so mid-scale is 0 (the DC blocker removes the rest). The unit
 * is the driver's alone: codegen refuses another ADC1 reader in the same firmware (driver.yaml resources
 * adc_continuous).
 *
 * DMA: conversion frames of kFrameConversions results (4 bytes each), whatever the rate, into IDF's pool of kPoolBytes
 * (about 60 ms at 64,000 conversions/s; it is all the read side has, IDF's five DMA buffers are copied into it as each
 * fills); 21 KB of internal RAM in all. A frame the pool had no room for (adc_continuous on_pool_ovf) is lost: the
 * lost conversions count in overruns() as whole kBufferSamples-sample buffers (AudioInService puts back that many
 * zeros per overrun, as for i2s_mic's 240-frame DMA buffers), the remainder carried to the next loss.
 *
 * The DMA's rate is IDF's divider of the 5 MHz ADC controller clock (5 MHz / (2 x floor(2.5 MHz / rate))): at or a
 * little above the asked rate (16 kHz x 4 converts at 64,103/s, 0.16% fast), never below.
 */
class AdcAudio final : public hal::AudioSource
{
public:
    enum class Atten : uint8_t { db0, db2_5, db6, db12 };

    /** The ADC DMA's conversion ceiling on C3, C6 and S3 (IDF SOC_ADC_SAMPLE_FREQ_THRES_HIGH); codegen's agrees. */
    static constexpr uint32_t kMaxConversionsHz = 83'333;
    /** Conversions per DMA frame (IDF conv_frame_size / 4) and IDF's pool for them (max_store_buf_size). */
    static constexpr uint32_t kFrameConversions = 256;
    static constexpr uint32_t kPoolBytes = 16 * kFrameConversions * 4;
    /** The buffer overruns() counts in: one AudioInService read (its kReadFrames), as i2s_mic's DMA buffer. */
    static constexpr uint32_t kBufferSamples = 240;
    /** Conversions read and parsed at a time (the read and parse buffers are the driver's: fr_audio's stack is 4 KB). */
    static constexpr uint32_t kChunkConversions = 128;

    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the instance's
    // `bind: gpio.<n>` (one of the board's pins.adc1). oversample is 1..8 (codegen).
    struct Config {
        uint8_t gpio = 0;
        Atten atten = Atten::db0;
        uint8_t oversample = 4;
    };

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit AdcAudio(const Config &cfg) : cfg_(cfg) {}

    /**
     * The handle (adc_continuous_new_handle, the pool-overflow callback) on cfg.gpio's ADC1 channel; stopped.
     * Err::unsupported for a pin that is not an ADC1 channel (logged), Err::failed when IDF has no memory for it.
     */
    Status init(Core &core) override;
    Status start(uint32_t sample_hz) override;
    std::expected<size_t, Err> read(std::span<int32_t> frames, uint32_t timeout_ms) override;
    Status stop() override;
    uint32_t sample_hz() const override { return sample_hz_; }
    uint32_t max_sample_hz() const override { return 48000; }
    uint8_t bits() const override { return 12; }
    /** Buffers of kBufferSamples samples lost to a full pool since start(): lost conversions / (240 x oversample). */
    uint32_t overruns() const override;
    hal::Selftest selftest() override;

    /** Conversions averaged per sample at `sample_hz`: cfg.oversample, lowered to fit kMaxConversionsHz. */
    constexpr uint8_t oversample_at(uint32_t sample_hz) const
    {
        const uint32_t fit = sample_hz == 0 ? cfg_.oversample : kMaxConversionsHz / sample_hz;
        const uint32_t n = fit < cfg_.oversample ? fit : cfg_.oversample;
        return static_cast<uint8_t>(n < 1 ? 1 : n);
    }

    /** The running oversample (0: stopped). */
    uint8_t oversample() const { return os_; }

private:
    Config cfg_;
    Core *core_ = nullptr;
    adc_continuous_ctx_t *adc_ = nullptr;  // adc_continuous_handle_t
    uint8_t channel_ = 0;  // cfg.gpio's ADC1 channel
    uint32_t sample_hz_ = 0;
    uint8_t os_ = 0;
    // A group still being averaged (its conversions so far): carried from one read() to the next.
    uint32_t sum_ = 0;
    uint32_t count_ = 0;
    std::atomic<uint32_t> lost_{0};  // conversions in the frames the pool lost (the overflow callback, ISR)
    alignas(4) uint8_t raw_[kChunkConversions * 4] = {};
    alignas(4) uint8_t parsed_[kChunkConversions * 16] = {};  // adc_continuous_data_t[kChunkConversions] (16 bytes each)
};

}  // namespace fr::drv
