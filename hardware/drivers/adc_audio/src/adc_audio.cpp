// adc_audio (design audio-a2 D2): one ADC1 channel through IDF v6.1's adc_continuous (esp_adc/adc_continuous.h). init()
// makes the handle (adc_continuous_new_handle, the on_pool_ovf callback) and finds the channel
// (adc_continuous_io_to_channel); start() sets the pattern and the rate (adc_continuous_config, only while stopped),
// empties the pool (adc_continuous_flush_pool) and starts the DMA; read() takes the pool's bytes (adc_continuous_read)
// a chunk at a time, parses them (adc_continuous_parse_data) and averages each group of `oversample` conversions into
// one sample; stop() is adc_continuous_stop. The host suite builds this file over firmware/test/host/shim
// (FR_HOST_SHIM), whose adc_continuous.h is v6.1's declarations.
#include "fr/drv/adc_audio.hpp"

#include "esp_adc/adc_continuous.h"
#include "esp_attr.h"
#include "esp_log.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "adc_audio";
/** The self-test's rate (the service's default sample_hz). */
constexpr uint32_t kTestHz = 16000;

static_assert(AdcAudio::kMaxConversionsHz == SOC_ADC_SAMPLE_FREQ_THRES_HIGH, "the target's ADC DMA ceiling changed");
static_assert(SOC_ADC_DIGI_RESULT_BYTES == 4 && SOC_ADC_DIGI_DATA_BYTES_PER_CONV == 4, "4-byte results (TYPE2)");

adc_continuous_handle_t handle(adc_continuous_ctx_t *p)
{
    return p;
}

/** The pool had no room for a finished frame (ISR context): its conversions are lost. */
bool IRAM_ATTR on_pool_ovf(adc_continuous_handle_t, const adc_continuous_evt_data_t *, void *ctx)
{
    static_cast<std::atomic<uint32_t> *>(ctx)->fetch_add(AdcAudio::kFrameConversions, std::memory_order_relaxed);
    return false;
}

adc_atten_t atten_of(AdcAudio::Atten a)
{
    switch (a) {
    case AdcAudio::Atten::db2_5:
        return ADC_ATTEN_DB_2_5;
    case AdcAudio::Atten::db6:
        return ADC_ATTEN_DB_6;
    case AdcAudio::Atten::db12:
        return ADC_ATTEN_DB_12;
    case AdcAudio::Atten::db0:
    default:
        return ADC_ATTEN_DB_0;
    }
}

Err err_of(esp_err_t e)
{
    return e == ESP_ERR_INVALID_ARG ? Err::invalid_args : e == ESP_ERR_INVALID_STATE ? Err::busy : Err::failed;
}

/** The mean of `n` 12-bit readings summing to `sum`, centred on mid-scale and left-justified (bits 31..20). */
int32_t sample_of(uint32_t sum, uint32_t n)
{
    const int64_t mean_q20 = (static_cast<int64_t>(sum) << 20) / static_cast<int64_t>(n);
    return static_cast<int32_t>(mean_q20 - (int64_t{2048} << 20));
}

}  // namespace

Status AdcAudio::init(Core &core)
{
    core_ = &core;
    if (adc_ != nullptr) {
        return {};
    }
    adc_unit_t unit = ADC_UNIT_1;
    adc_channel_t ch = ADC_CHANNEL_0;
    if (adc_continuous_io_to_channel(cfg_.gpio, &unit, &ch) != ESP_OK || unit != ADC_UNIT_1) {
        ESP_LOGE(TAG, "GPIO%u is not an ADC1 channel", static_cast<unsigned>(cfg_.gpio));
        return std::unexpected(Err::unsupported);
    }
    channel_ = static_cast<uint8_t>(ch);
    adc_continuous_handle_cfg_t hc{};
    hc.max_store_buf_size = kPoolBytes;
    hc.conv_frame_size = kFrameConversions * SOC_ADC_DIGI_DATA_BYTES_PER_CONV;
    hc.flags.flush_pool = 0;  // a full pool keeps what it holds and loses the newest frame (counted)
    adc_continuous_handle_t h = nullptr;
    esp_err_t e = adc_continuous_new_handle(&hc, &h);
    if (e == ESP_OK) {
        adc_continuous_evt_cbs_t cbs{};
        cbs.on_pool_ovf = on_pool_ovf;
        e = adc_continuous_register_event_callbacks(h, &cbs, &lost_);
        if (e != ESP_OK) {
            adc_continuous_deinit(h);
        }
    }
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "GPIO%u (ADC1 ch%u): no continuous handle (%s)", static_cast<unsigned>(cfg_.gpio),
                 static_cast<unsigned>(channel_), esp_err_to_name(e));
        return std::unexpected(Err::failed);
    }
    adc_ = h;
    ESP_LOGI(TAG, "GPIO%u: ADC1 ch%u, atten %u, oversample %u", static_cast<unsigned>(cfg_.gpio),
             static_cast<unsigned>(channel_), static_cast<unsigned>(atten_of(cfg_.atten)),
             static_cast<unsigned>(cfg_.oversample));
    return {};
}

Status AdcAudio::start(uint32_t sample_hz)
{
    if (adc_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (!hal::is_audio_rate(sample_hz) || sample_hz > max_sample_hz()) {
        return std::unexpected(Err::invalid_args);
    }
    if (sample_hz_ != 0) {
        return std::unexpected(Err::busy);
    }
    const uint8_t os = oversample_at(sample_hz);
    adc_digi_pattern_config_t pattern{};
    pattern.atten = static_cast<uint8_t>(atten_of(cfg_.atten));
    pattern.channel = channel_;
    pattern.unit = static_cast<uint8_t>(ADC_UNIT_1);
    pattern.bit_width = SOC_ADC_DIGI_MAX_BITWIDTH;
    adc_continuous_config_t dc{};
    dc.pattern_num = 1;
    dc.adc_pattern = &pattern;
    dc.sample_freq_hz = sample_hz * os;
    dc.conv_mode = ADC_CONV_SINGLE_UNIT_1;
    esp_err_t e = adc_continuous_config(handle(adc_), &dc);
    if (e == ESP_OK) {
        e = adc_continuous_flush_pool(handle(adc_));  // nothing from the run before
    }
    if (e == ESP_OK) {
        e = adc_continuous_start(handle(adc_));
    }
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "%u conversions/s: %s", static_cast<unsigned>(sample_hz * os), esp_err_to_name(e));
        return std::unexpected(err_of(e));
    }
    lost_.store(0, std::memory_order_relaxed);
    sum_ = 0;
    count_ = 0;
    os_ = os;
    sample_hz_ = sample_hz;
    return {};
}

std::expected<size_t, Err> AdcAudio::read(std::span<int32_t> frames, uint32_t timeout_ms)
{
    if (adc_ == nullptr || sample_hz_ == 0) {
        return std::unexpected(Err::failed);
    }
    static_assert(sizeof(adc_continuous_data_t) * kChunkConversions <= sizeof(parsed_) &&
                  alignof(adc_continuous_data_t) <= 4);
    const TimeUs until = core_->now() + static_cast<TimeUs>(timeout_ms) * 1000;
    auto *parsed = reinterpret_cast<adc_continuous_data_t *>(parsed_);
    size_t got = 0;
    while (got < frames.size()) {
        // No more than the frames still wanted take (the rest stays in the pool for the next read).
        const uint32_t want = static_cast<uint32_t>(frames.size() - got) * os_ - count_;
        const uint32_t conv = want < kChunkConversions ? want : kChunkConversions;
        const TimeUs now = core_->now();
        const uint32_t wait_ms = now < until ? static_cast<uint32_t>((until - now) / 1000) : 0;
        uint32_t len = 0;
        const esp_err_t e = adc_continuous_read(handle(adc_), raw_, conv * SOC_ADC_DIGI_RESULT_BYTES, &len, wait_ms);
        if (e == ESP_ERR_TIMEOUT || (e == ESP_OK && len == 0)) {
            break;  // fewer than asked only on the timeout (fr/hal/audio.hpp)
        }
        if (e != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        uint32_t n = 0;
        if (adc_continuous_parse_data(handle(adc_), raw_, len, parsed, &n) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        for (uint32_t i = 0; i < n; ++i) {
            const adc_continuous_data_t &d = parsed[i];
            if (!d.valid || d.unit != ADC_UNIT_1 || d.channel != static_cast<adc_channel_t>(channel_)) {
                continue;  // the arbiter's invalid results (none expected with ADC1 alone)
            }
            sum_ += d.raw_data & 0xFFF;
            if (++count_ == os_) {
                frames[got++] = sample_of(sum_, os_);
                sum_ = 0;
                count_ = 0;
            }
        }
    }
    return got;
}

Status AdcAudio::stop()
{
    if (adc_ != nullptr && sample_hz_ != 0) {
        adc_continuous_stop(handle(adc_));
    }
    sample_hz_ = 0;
    os_ = 0;
    return {};
}

uint32_t AdcAudio::overruns() const
{
    const uint32_t per = kBufferSamples * (os_ != 0 ? os_ : 1);
    return lost_.load(std::memory_order_relaxed) / per;
}

hal::Selftest AdcAudio::selftest()
{
    if (adc_ == nullptr) {
        return {false, "adc_audio: no continuous handle"};
    }
    if (sample_hz_ != 0) {
        return {true, "adc_audio: running"};
    }
    // The channel starts and the DMA delivers one buffer; the signal itself cannot be judged here.
    if (!start(kTestHz)) {
        return {false, "adc_audio: cannot start"};
    }
    int32_t buf[kBufferSamples];
    const auto got = read(buf, 100);
    stop();
    if (!got || *got == 0) {
        return {false, "adc_audio: no conversions from the DMA"};
    }
    return {true, "adc_audio: channel and DMA run"};
}

}  // namespace fr::drv
