// adc_audio (design audio-a2 D2), its own .cpp against shim/idf's adc_continuous (IDF v6.1's declarations): the handle
// (frame and pool sizes, flush_pool off), the pin to ADC1 channel map (ADC2 pins and non-ADC pins refused), the pattern
// and the rate start() asks for (sample_hz x oversample, oversample lowered above 83,333/s), the averaging of each
// group into one sample, the 12-bit code centred and left-justified (<< 20, the mean's fraction below), groups carried
// across reads and the byte ring's short reads, other channels' results skipped, the timeout, the pool's lost frames
// as overruns() in 240-sample buffers, the self-test, and those overruns in AudioInService's diag `stats audio`.
#include <array>
#include <string>
#include <vector>

#include "adc_sim.hpp"
#include "esp_sim.hpp"
#include "fr/audio/engine.hpp"
#include "fr/drv/adc_audio.hpp"
#include "fr/services/audio_in_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using fr::drv::AdcAudio;

constexpr uint32_t kFrame = AdcAudio::kFrameConversions;

/** Every shim back to power-on, on this test's clock. */
class AdcScope
{
public:
    explicit AdcScope(fr::Core &core)
    {
        esp_sim::reset();
        esp_sim::adc_reset();
        esp_sim::attach(core);
    }
    ~AdcScope()
    {
        esp_sim::reset();
        esp_sim::adc_reset();
    }
    AdcScope(const AdcScope &) = delete;
    AdcScope &operator=(const AdcScope &) = delete;
};

/** A sample as the driver makes it from a mean of `mean_x4` / 4 (exact in Q20). */
int32_t q20(int32_t mean_x4)
{
    return static_cast<int32_t>((static_cast<int64_t>(mean_x4) << 18) - (int64_t{2048} << 20));
}

/** `frames` whole DMA frames of `code` on channel `ch`. */
void convert_frames(uint32_t frames, uint16_t code, unsigned ch = 0)
{
    const std::vector<uint16_t> raw(static_cast<size_t>(frames) * kFrame, code);
    esp_sim::adc_convert(raw, ch);
}

}  // namespace

TEST(adc_audio_handle_pin_map_pattern_and_rates)
{
    FakeCore core;
    AdcScope scope(core);
    {
        AdcAudio adc2_pin({.gpio = 11});  // ADC2 channel 0 on the S3: continuous mode is ADC1's only
        CHECK(adc2_pin.init(core).error() == fr::Err::unsupported);
        AdcAudio no_adc({.gpio = 33});
        CHECK(no_adc.init(core).error() == fr::Err::unsupported);
        CHECK_EQ(esp_sim::adc_new_calls(), 0);
    }
    AdcAudio adc({.gpio = 1, .atten = AdcAudio::Atten::db0, .oversample = 4});
    CHECK(adc.start(16000).error() == fr::Err::failed);  // before init
    REQUIRE(adc.init(core));
    REQUIRE(adc.init(core));  // once
    CHECK_EQ(esp_sim::adc_new_calls(), 1);
    esp_sim::AdcHandle *h = esp_sim::adc_handle();
    REQUIRE(h != nullptr);
    CHECK_EQ(h->frame_bytes, kFrame * 4);
    CHECK_EQ(h->pool_bytes, 16 * kFrame * 4);
    CHECK(!h->flush_pool);
    CHECK(!h->started);  // nothing converts until start()

    CHECK(adc.start(11025).error() == fr::Err::invalid_args);
    CHECK(adc.start(96000).error() == fr::Err::invalid_args);
    REQUIRE(adc.start(16000));
    CHECK(h->started);
    CHECK_EQ(h->pattern_num, 1u);
    CHECK_EQ(h->unit, 0);       // ADC_UNIT_1
    CHECK_EQ(h->channel, 0);    // GPIO1: ADC1 channel 0
    CHECK_EQ(h->atten, 0);      // ADC_ATTEN_DB_0
    CHECK_EQ(h->bit_width, 12);
    CHECK_EQ(h->conv_mode, 1);  // ADC_CONV_SINGLE_UNIT_1
    CHECK_EQ(h->sample_freq_hz, 64000u);
    CHECK_EQ(h->flushes, 1u);  // the pool emptied before each start
    CHECK_EQ(adc.oversample(), 4);
    CHECK_EQ(adc.sample_hz(), 16000u);
    CHECK(adc.start(16000).error() == fr::Err::busy);
    REQUIRE(adc.stop());
    CHECK(!h->started);
    CHECK_EQ(adc.sample_hz(), 0u);
    REQUIRE(adc.stop());  // stopped already: OK
    CHECK_EQ(h->stops, 1u);

    // Faster rates lower oversample to fit the DMA's 83,333/s (codegen checks only config sample_hz).
    const std::array<std::array<uint32_t, 3>, 6> rates{{
        {8000, 4, 32000},
        {16000, 4, 64000},
        {22050, 3, 66150},
        {32000, 2, 64000},
        {44100, 1, 44100},
        {48000, 1, 48000},
    }};
    for (const auto &[hz, os, conv] : rates) {
        REQUIRE(adc.start(hz));
        CHECK_EQ(adc.oversample(), os);
        CHECK_EQ(h->sample_freq_hz, conv);
        REQUIRE(adc.stop());
    }
    AdcAudio eight({.gpio = 10, .atten = AdcAudio::Atten::db12, .oversample = 8});
    esp_sim::adc_reset();
    REQUIRE(eight.init(core));
    h = esp_sim::adc_handle();
    REQUIRE(eight.start(8000));
    CHECK_EQ(h->sample_freq_hz, 64000u);
    CHECK_EQ(h->channel, 9);  // GPIO10: ADC1 channel 9
    CHECK_EQ(h->atten, 3);    // ADC_ATTEN_DB_12
    REQUIRE(eight.stop());
    REQUIRE(eight.start(16000));
    CHECK_EQ(eight.oversample(), 5);  // floor(83333 / 16000)
    CHECK_EQ(h->sample_freq_hz, 80000u);
}

TEST(adc_audio_averages_groups_and_left_justifies_12_bits)
{
    FakeCore core;
    AdcScope scope(core);
    AdcAudio adc({.gpio = 1, .oversample = 4});
    REQUIRE(adc.init(core));
    REQUIRE(adc.start(16000));
    std::vector<int32_t> frames(240);
    auto got = adc.read(frames, 20);
    REQUIRE(got);
    CHECK_EQ(*got, 0u);  // the pool is empty: the timeout's answer (the shim does not wait)
    CHECK_EQ(esp_sim::adc_handle()->last_timeout_ms, 20u);

    // One DMA frame (256 conversions, 64 samples): groups of 4 that test the extremes, the centre and the fraction.
    std::vector<uint16_t> raw(kFrame, 2048);
    const std::array<std::array<uint16_t, 4>, 6> groups{{
        {0, 0, 0, 0},              // -2048 << 20: INT32_MIN
        {4095, 4095, 4095, 4095},  // 2047 << 20
        {2048, 2048, 2048, 2048},  // mid-scale: 0
        {2049, 2049, 2049, 2049},  // one code: 1 << 20
        {2048, 2049, 2048, 2049},  // 2048.5: the half below bit 20
        {1, 2, 3, 5},              // 2.75
    }};
    for (size_t g = 0; g < groups.size(); ++g) {
        for (size_t i = 0; i < 4; ++i) {
            raw[g * 4 + i] = groups[g][i];
        }
    }
    esp_sim::adc_convert(raw, 0);
    got = adc.read(frames, 20);
    REQUIRE(got);
    REQUIRE_EQ(*got, 64u);  // all the pool had: fewer than asked only on the timeout
    CHECK_EQ(frames[0], INT32_MIN);
    CHECK_EQ(frames[1], 2047 << 20);
    CHECK_EQ(frames[2], 0);
    CHECK_EQ(frames[3], 1 << 20);
    CHECK_EQ(frames[4], 1 << 19);
    CHECK_EQ(frames[5], q20(11));
    CHECK_EQ(frames[63], 0);

    // A read takes no more than it needs: the rest stays in the pool for the next one.
    convert_frames(8, 2052);  // 512 samples
    std::vector<int32_t> few(100);
    got = adc.read(few, 0);
    REQUIRE(got);
    CHECK_EQ(*got, 100u);
    CHECK_EQ(few[99], 4 << 20);
    CHECK_EQ(esp_sim::adc_handle()->pool.size(), (512u - 100u) * 4 * 4);
    got = adc.read(frames, 0);
    REQUIRE(got);
    CHECK_EQ(*got, 240u);
    got = adc.read(frames, 0);
    REQUIRE(got);
    CHECK_EQ(*got, 172u);
    CHECK_EQ(adc.overruns(), 0u);
    REQUIRE(adc.stop());
    CHECK(adc.read(frames, 0).error() == fr::Err::failed);  // stopped
}

TEST(adc_audio_carries_groups_across_short_reads_and_skips_other_channels)
{
    FakeCore core;
    AdcScope scope(core);
    AdcAudio adc({.gpio = 3, .oversample = 4});
    REQUIRE(adc.init(core));
    REQUIRE(adc.start(22050));  // oversample 3
    REQUIRE_EQ(adc.oversample(), 3);
    // The byte ring hands out 20 bytes (5 results) at a time: groups of 3 straddle the reads.
    esp_sim::adc_set_read_cap(20);
    std::vector<uint16_t> raw(kFrame * 3);
    for (size_t i = 0; i < raw.size(); ++i) {
        raw[i] = static_cast<uint16_t>(2048 + (i / 3) % 100);  // group g holds 2048 + g % 100 three times
    }
    esp_sim::adc_convert(raw, 2);  // GPIO3: ADC1 channel 2
    std::vector<int32_t> frames(256);
    const auto got = adc.read(frames, 0);
    REQUIRE(got);
    REQUIRE_EQ(*got, 256u);  // 768 conversions
    bool exact = true;
    for (size_t g = 0; g < 256; ++g) {
        exact = exact && frames[g] == static_cast<int32_t>((g % 100) << 20);
    }
    CHECK(exact);
    // Another channel's results (not this pattern's) are skipped.
    esp_sim::adc_set_read_cap(0);
    convert_frames(3, 4000, 5);
    convert_frames(3, 2050, 2);
    const auto more = adc.read(frames, 0);
    REQUIRE(more);
    CHECK_EQ(*more, 256u);
    CHECK_EQ(frames[0], 2 << 20);
    CHECK_EQ(frames[255], 2 << 20);
}

TEST(adc_audio_counts_lost_dma_frames_as_240_sample_buffers)
{
    FakeCore core;
    AdcScope scope(core);
    AdcAudio adc({.gpio = 1, .oversample = 4});
    REQUIRE(adc.init(core));
    REQUIRE(adc.start(16000));
    // The pool holds 16 frames; 4 more find no room: 1024 conversions, one 240-sample buffer (960) and a remainder.
    convert_frames(20, 2048);
    CHECK_EQ(esp_sim::adc_handle()->overflows, 4u);
    CHECK_EQ(adc.overruns(), 1u);
    convert_frames(4, 2048);  // 2048 lost in all: two buffers
    CHECK_EQ(adc.overruns(), 2u);
    // What the pool kept still reads in order.
    std::vector<int32_t> frames(240);
    const auto got = adc.read(frames, 0);
    REQUIRE(got);
    CHECK_EQ(*got, 240u);
    // A new start begins counting again.
    REQUIRE(adc.stop());
    REQUIRE(adc.start(16000));
    CHECK_EQ(adc.overruns(), 0u);
    CHECK(esp_sim::adc_handle()->pool.empty());  // flushed
}

TEST(adc_audio_selftest_starts_the_channel_and_needs_the_dma)
{
    FakeCore core;
    AdcScope scope(core);
    AdcAudio adc({.gpio = 1});
    CHECK(!adc.selftest().ok);  // no handle
    REQUIRE(adc.init(core));
    CHECK(!adc.selftest().ok);  // the DMA delivered nothing
    CHECK(!esp_sim::adc_handle()->started);
    esp_sim::adc_set_on_start(std::vector<uint16_t>(4 * kFrame, 2048));
    CHECK(adc.selftest().ok);
    CHECK(!esp_sim::adc_handle()->started);  // stopped again
    REQUIRE(adc.start(16000));
    CHECK(adc.selftest().ok);  // running: fr_audio has it
}

TEST(adc_audio_overruns_reach_audio_in_s_stats)
{
    // AudioInService over the driver over the shim: the pool's lost frames are `stats audio` rx_overflows, as the
    // microphone's I2S overflows are.
    FakeCore core;
    AdcScope scope(core);
    frt::RecordingSink sink{core};
    AdcAudio adc({.gpio = 1});
    fr::cap::AudioInConfig cfg{};
    cfg.gain_db = 24;
    fr::AudioInService rf(adc, cfg);
    fr::audio::engine().set_manual(true);
    rf.attach(5, "rf", sink);
    REQUIRE(rf.init(core));
    esp_sim::adc_set_on_start(std::vector<uint16_t>(4 * kFrame, 2048));  // the init self-test's frames
    fr::audio::engine().audio_once();  // the init self-test: start, one buffer
    fr::audio::engine().audio_once();  // ... stop
    CHECK(!esp_sim::adc_handle()->started);
    CHECK(rf.selftest().ok);
    REQUIRE(rf.level_get());
    fr::audio::engine().audio_once();  // the meter's run starts the channel, reads 960 of the 1024 conversions
    REQUIRE(esp_sim::adc_handle()->started);
    convert_frames(16 + 8, 2048);  // 15 frames fit beside the 64 left: 9 lost, 2304 conversions, two buffers
    fr::audio::engine().audio_once();
    std::array<fr::audio::WorkerStats, 2> st{};
    REQUIRE_EQ(fr::audio::engine().stats(st), 1u);
    CHECK_EQ(std::string(st[0].name), "rf");
    CHECK_EQ(st[0].rx_overflows, 2u);
    CHECK_EQ(rf.dma_lost(), 480u);
    CHECK_EQ(rf.traits().bits, 12);
    CHECK_EQ(rf.traits().max_sample_hz, 48000u);
}
