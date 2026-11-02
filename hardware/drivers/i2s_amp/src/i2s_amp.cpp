// i2s_amp (design audio-a1 D6): an I2S DAC / class-D amplifier through esp_driver_i2s. One TX channel, master,
// Philips, mono 16-bit data in both slots (a MAX98357A with SD floating plays (L+R)/2), DMA 6 x 240 frames cleared
// when starved (silence, counted); 16-bit slots alone, 32-bit slots and WS in a share_with pair (the microphone's
// frame: one BCLK and WS for both), where fr/platform/i2s_pair.hpp runs the two halves' clock. The optional shutdown
// pin is low from init, high from start() to stop(). The host suite builds this file over firmware/test/host/shim
// (FR_HOST_SHIM).
#include "fr/drv/i2s_amp.hpp"

#include <algorithm>

#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_log.h"
#include "fr/platform/i2s_pair.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "i2s_amp";
constexpr uint32_t kDmaDesc = 6;
constexpr uint32_t kDmaFrames = 240;
constexpr uint32_t kInitHz = 16000;
constexpr size_t kSampleBytes = sizeof(int16_t);

i2s_chan_handle_t chan(i2s_channel_obj_t *p)
{
    return p;
}

Err err_of(esp_err_t e)
{
    return e == ESP_ERR_NOT_FOUND ? Err::busy : e == ESP_ERR_INVALID_ARG ? Err::invalid_args : Err::failed;
}

Status status_of(esp_err_t e)
{
    if (e != ESP_OK) {
        return std::unexpected(err_of(e));
    }
    return {};
}

/**
 * The clock at `hz`. In a share_with pair MCLK is 512 x rate, so MCLK/BCLK is 8 with two 32-bit slots: IDF wants at
 * least 6 for a full-duplex TX slave and 4 for an RX slave (i2s_std.c, i2s_std_calculate_clock); 256 would give 4.
 */
i2s_std_clk_config_t clock_config(uint32_t hz, bool shared)
{
    i2s_std_clk_config_t clk = I2S_STD_CLK_DEFAULT_CONFIG(hz);
    if (shared) {
        clk.mclk_multiple = I2S_MCLK_MULTIPLE_512;
    }
    return clk;
}

/** A share_with pair's IDF calls (fr/platform/i2s_pair.hpp); i2s_mic.cpp has the same. */
const platform::i2s::Ops kPairOps = {
    .enable = [](void *c) { return status_of(i2s_channel_enable(static_cast<i2s_chan_handle_t>(c))); },
    .disable = [](void *c) { return status_of(i2s_channel_disable(static_cast<i2s_chan_handle_t>(c))); },
    .set_clock =
        [](void *c, uint32_t hz) {
            const i2s_std_clk_config_t clk = clock_config(hz, true);
            return status_of(i2s_channel_reconfig_std_clock(static_cast<i2s_chan_handle_t>(c), &clk));
        },
};

/** The DMA found nothing new to send and played a cleared buffer (ISR context). */
bool on_send_starved(i2s_chan_handle_t, i2s_event_data_t *, void *ctx)
{
    static_cast<std::atomic<uint32_t> *>(ctx)->fetch_add(1, std::memory_order_relaxed);
    return false;
}

}  // namespace

Status I2sAmp::init(Core &)
{
    if (tx_ != nullptr) {
        return {};
    }
    if (cfg_.sd >= 0) {
        // Muted from the start: the pin low before anything clocks the part.
        const gpio_config_t io = {.pin_bit_mask = 1ULL << cfg_.sd,
                                  .mode = GPIO_MODE_OUTPUT,
                                  .pull_up_en = GPIO_PULLUP_DISABLE,
                                  .pull_down_en = GPIO_PULLDOWN_DISABLE,
                                  .intr_type = GPIO_INTR_DISABLE};
        if (gpio_set_level(static_cast<gpio_num_t>(cfg_.sd), 0) != ESP_OK || gpio_config(&io) != ESP_OK) {
            return std::unexpected(Err::invalid_args);
        }
    }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(static_cast<int>(cfg_.port), I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = kDmaDesc;
    chan_cfg.dma_frame_num = kDmaFrames;
    chan_cfg.auto_clear_after_cb = true;  // a starved DMA plays zeros, not the last buffer again
    esp_err_t e = ESP_OK;
    const bool shared = cfg_.share_with != 0;
    if (shared) {
        platform::i2s::Pair *pair = platform::i2s::pair(cfg_.port);
        if (pair == nullptr) {
            return std::unexpected(Err::invalid_args);
        }
        if (!pair->made) {
            i2s_chan_handle_t tx = nullptr;
            i2s_chan_handle_t rx = nullptr;
            e = i2s_new_channel(&chan_cfg, &tx, &rx);
            if (e == ESP_OK) {
                pair->tx = tx;
                pair->rx = rx;
                pair->made = true;
                pair->clock_hz = kInitHz;
            }
        }
        tx_ = static_cast<i2s_chan_handle_t>(pair->tx);
    } else {
        i2s_chan_handle_t tx = nullptr;
        e = i2s_new_channel(&chan_cfg, &tx, nullptr);
        tx_ = tx;
    }
    if (e != ESP_OK || tx_ == nullptr) {
        ESP_LOGE(TAG, "I2S%u: no TX channel (%s)", static_cast<unsigned>(cfg_.port), esp_err_to_name(e));
        tx_ = nullptr;
        return std::unexpected(err_of(e));
    }

    i2s_std_config_t std_cfg{};
    std_cfg.clk_cfg = clock_config(kInitHz, shared);
    std_cfg.slot_cfg = i2s_std_slot_config_t I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
    std_cfg.slot_cfg.slot_mask = I2S_STD_SLOT_BOTH;  // mono: the same sample in both slots
    if (shared) {
        // The microphone's frame: 32-bit slots and WS 32 BCLKs wide, one BCLK and WS for both halves.
        std_cfg.slot_cfg.slot_bit_width = I2S_SLOT_BIT_WIDTH_32BIT;
        std_cfg.slot_cfg.ws_width = 32;
    }
    std_cfg.gpio_cfg.mclk = I2S_GPIO_UNUSED;
    std_cfg.gpio_cfg.bclk = static_cast<gpio_num_t>(cfg_.bclk);
    std_cfg.gpio_cfg.ws = static_cast<gpio_num_t>(cfg_.ws);
    std_cfg.gpio_cfg.dout = static_cast<gpio_num_t>(cfg_.dout);
    std_cfg.gpio_cfg.din = I2S_GPIO_UNUSED;
    e = i2s_channel_init_std_mode(chan(tx_), &std_cfg);
    if (e == ESP_OK) {
        i2s_event_callbacks_t cbs{};
        cbs.on_send_q_ovf = on_send_starved;
        e = i2s_channel_register_event_callback(chan(tx_), &cbs, &underruns_);
    }
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "I2S%u: TX setup failed (%s)", static_cast<unsigned>(cfg_.port), esp_err_to_name(e));
        return std::unexpected(err_of(e));
    }
    if (shared) {
        platform::i2s::mark_ready(*platform::i2s::pair(cfg_.port), true);
    }
    clock_hz_ = kInitHz;
    ESP_LOGI(TAG, "I2S%u TX: bclk %d ws %d dout %u sd %d%s", static_cast<unsigned>(cfg_.port), cfg_.bclk, cfg_.ws,
             static_cast<unsigned>(cfg_.dout), cfg_.sd, shared ? ", shared clock" : "");
    return {};
}

Status I2sAmp::start(uint32_t sample_hz)
{
    if (tx_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (!hal::is_audio_rate(sample_hz) || sample_hz > max_sample_hz()) {
        return std::unexpected(Err::invalid_args);
    }
    if (sample_hz_ != 0) {
        return std::unexpected(Err::busy);
    }
    if (cfg_.share_with != 0) {
        // One clock for both halves (invalid_args while the microphone runs at another rate), retuned on both.
        if (auto st = platform::i2s::start(*platform::i2s::pair(cfg_.port), true, sample_hz, kPairOps); !st) {
            return st;
        }
    } else {
        if (clock_hz_ != sample_hz) {
            const i2s_std_clk_config_t clk = clock_config(sample_hz, false);
            if (const esp_err_t e = i2s_channel_reconfig_std_clock(chan(tx_), &clk); e != ESP_OK) {
                ESP_LOGE(TAG, "clock %u Hz: %s", static_cast<unsigned>(sample_hz), esp_err_to_name(e));
                return std::unexpected(err_of(e));
            }
            clock_hz_ = sample_hz;
        }
        if (const esp_err_t e = i2s_channel_enable(chan(tx_)); e != ESP_OK) {
            return std::unexpected(err_of(e));
        }
    }
    if (cfg_.sd >= 0) {
        gpio_set_level(static_cast<gpio_num_t>(cfg_.sd), 1);
    }
    underruns_.store(0, std::memory_order_relaxed);
    sample_hz_ = sample_hz;
    return {};
}

std::expected<size_t, Err> I2sAmp::write(std::span<const int16_t> samples, uint32_t timeout_ms)
{
    if (tx_ == nullptr || sample_hz_ == 0) {
        return std::unexpected(Err::failed);
    }
    size_t done = 0;
    const esp_err_t e = i2s_channel_write(chan(tx_), samples.data(), samples.size() * kSampleBytes, &done, timeout_ms);
    if (e != ESP_OK && e != ESP_ERR_TIMEOUT) {
        return std::unexpected(Err::failed);
    }
    return done / kSampleBytes;
}

Status I2sAmp::stop(uint32_t timeout_ms)
{
    if (tx_ != nullptr && sample_hz_ != 0) {
        // What the DMA holds plays out: at most its 6 x 240 frames. AudioOutService passes 0 and waits for that
        // itself, without sleeping on fr_audio (the microphone's RX DMA holds only 90 ms at 16 kHz).
        const uint32_t queued_ms = kDmaDesc * kDmaFrames * 1000 / sample_hz_ + 1;
        const uint32_t wait = std::min(queued_ms, timeout_ms);
        if (wait > 0) {
            vTaskDelay(pdMS_TO_TICKS(wait) > 0 ? pdMS_TO_TICKS(wait) : 1);
        }
        if (cfg_.sd >= 0) {
            gpio_set_level(static_cast<gpio_num_t>(cfg_.sd), 0);
        }
        if (cfg_.share_with != 0) {
            // Muted; the channel stays enabled while it is the clock master of a running microphone.
            platform::i2s::stop(*platform::i2s::pair(cfg_.port), true, kPairOps);
        } else {
            i2s_channel_disable(chan(tx_));
        }
    }
    sample_hz_ = 0;
    return {};
}

hal::Selftest I2sAmp::selftest()
{
    // An amplifier cannot be read back: the channel exists (and the shutdown pin took its level).
    if (tx_ == nullptr) {
        return {false, "i2s_amp: no TX channel"};
    }
    return {true, sample_hz_ != 0 ? "i2s_amp: playing" : "i2s_amp: TX channel ready"};
}

}  // namespace fr::drv
