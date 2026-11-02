// i2s_mic (design audio-a1 D6): an I2S standard-mode MEMS microphone through esp_driver_i2s. One RX channel, master,
// 32-bit slots, mono (the cfg.slot slot), Philips or MSB framing, DMA 6 x 240 frames; disabled (no clock on the pins)
// until start(). A share_with pair (fr/platform/i2s_pair.hpp) makes the controller's TX and RX in one i2s_new_channel
// call, whichever of the two drivers inits first; both then run at one rate, the pair's code enabling the duplex master
// for a slave's clock. The host suite builds this file over firmware/test/host/shim (FR_HOST_SHIM).
#include "fr/drv/i2s_mic.hpp"

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "fr/platform/i2s_pair.hpp"

namespace fr::drv {
namespace {

constexpr const char *TAG = "i2s_mic";
constexpr uint32_t kDmaDesc = 6;
constexpr uint32_t kDmaFrames = 240;
/** The clock the channel is set up with at init (start() sets the stream's). */
constexpr uint32_t kInitHz = 16000;
constexpr size_t kFrameBytes = sizeof(int32_t);

i2s_chan_handle_t chan(i2s_channel_obj_t *p)
{
    return p;
}

/** The DMA overwrote a buffer nobody had read (ISR context): counted for AudioInService's zeros. */
bool on_recv_overflow(i2s_chan_handle_t, i2s_event_data_t *, void *ctx)
{
    static_cast<std::atomic<uint32_t> *>(ctx)->fetch_add(1, std::memory_order_relaxed);
    return false;
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

/** The clock at `hz`; MCLK 512 x rate in a share_with pair, as i2s_amp.cpp's (MCLK/BCLK 8: a duplex slave's minimum). */
i2s_std_clk_config_t clock_config(uint32_t hz, bool shared)
{
    i2s_std_clk_config_t clk = I2S_STD_CLK_DEFAULT_CONFIG(hz);
    if (shared) {
        clk.mclk_multiple = I2S_MCLK_MULTIPLE_512;
    }
    return clk;
}

/** A share_with pair's IDF calls (fr/platform/i2s_pair.hpp); i2s_amp.cpp has the same. */
const platform::i2s::Ops kPairOps = {
    .enable = [](void *c) { return status_of(i2s_channel_enable(static_cast<i2s_chan_handle_t>(c))); },
    .disable = [](void *c) { return status_of(i2s_channel_disable(static_cast<i2s_chan_handle_t>(c))); },
    .set_clock =
        [](void *c, uint32_t hz) {
            const i2s_std_clk_config_t clk = clock_config(hz, true);
            return status_of(i2s_channel_reconfig_std_clock(static_cast<i2s_chan_handle_t>(c), &clk));
        },
};

}  // namespace

Status I2sMic::init(Core &)
{
    if (rx_ != nullptr) {
        return {};
    }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(static_cast<int>(cfg_.port), I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = kDmaDesc;
    chan_cfg.dma_frame_num = kDmaFrames;
    chan_cfg.auto_clear_after_cb = true;  // a TX half made here (share_with) plays silence when starved
    esp_err_t e = ESP_OK;
    platform::i2s::Pair *pair = nullptr;
    if (cfg_.share_with != 0) {
        pair = platform::i2s::pair(cfg_.port);
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
        rx_ = static_cast<i2s_chan_handle_t>(pair->rx);
    } else {
        i2s_chan_handle_t rx = nullptr;
        e = i2s_new_channel(&chan_cfg, nullptr, &rx);
        rx_ = rx;
    }
    if (e != ESP_OK || rx_ == nullptr) {
        ESP_LOGE(TAG, "I2S%u: no RX channel (%s)", static_cast<unsigned>(cfg_.port), esp_err_to_name(e));
        rx_ = nullptr;
        return std::unexpected(err_of(e));
    }

    i2s_std_config_t std_cfg{};
    std_cfg.clk_cfg = clock_config(kInitHz, pair != nullptr);
    std_cfg.slot_cfg = cfg_.format == Format::msb
                           ? i2s_std_slot_config_t I2S_STD_MSB_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO)
                           : i2s_std_slot_config_t I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT,
                                                                                       I2S_SLOT_MODE_MONO);
    std_cfg.slot_cfg.slot_mask = cfg_.slot == Slot::right ? I2S_STD_SLOT_RIGHT : I2S_STD_SLOT_LEFT;
    std_cfg.gpio_cfg.mclk = I2S_GPIO_UNUSED;
    std_cfg.gpio_cfg.bclk = static_cast<gpio_num_t>(cfg_.bclk);
    std_cfg.gpio_cfg.ws = static_cast<gpio_num_t>(cfg_.ws);
    std_cfg.gpio_cfg.dout = I2S_GPIO_UNUSED;
    std_cfg.gpio_cfg.din = static_cast<gpio_num_t>(cfg_.din);
    e = i2s_channel_init_std_mode(chan(rx_), &std_cfg);
    if (e == ESP_OK) {
        i2s_event_callbacks_t cbs{};
        cbs.on_recv_q_ovf = on_recv_overflow;
        e = i2s_channel_register_event_callback(chan(rx_), &cbs, &overruns_);
    }
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "I2S%u: RX setup failed (%s)", static_cast<unsigned>(cfg_.port), esp_err_to_name(e));
        return std::unexpected(err_of(e));
    }
    if (pair != nullptr) {
        platform::i2s::mark_ready(*pair, false);
    }
    clock_hz_ = kInitHz;
    ESP_LOGI(TAG, "I2S%u RX: bclk %d ws %d din %u, slot %s, %s%s", static_cast<unsigned>(cfg_.port), cfg_.bclk, cfg_.ws,
             static_cast<unsigned>(cfg_.din), cfg_.slot == Slot::right ? "right" : "left",
             cfg_.format == Format::msb ? "msb" : "philips", cfg_.share_with != 0 ? ", shared clock" : "");
    return {};
}

Status I2sMic::start(uint32_t sample_hz)
{
    if (rx_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (!hal::is_audio_rate(sample_hz) || sample_hz > max_sample_hz()) {
        return std::unexpected(Err::invalid_args);
    }
    if (sample_hz_ != 0) {
        return std::unexpected(Err::busy);
    }
    if (cfg_.share_with != 0) {
        // One clock for both halves (invalid_args while the amplifier runs at another rate), retuned on both; the
        // amplifier's TX enabled too when it is the duplex master, so BCLK and WS run.
        if (auto st = platform::i2s::start(*platform::i2s::pair(cfg_.port), false, sample_hz, kPairOps); !st) {
            return st;
        }
    } else {
        if (clock_hz_ != sample_hz) {
            const i2s_std_clk_config_t clk = clock_config(sample_hz, false);
            if (const esp_err_t e = i2s_channel_reconfig_std_clock(chan(rx_), &clk); e != ESP_OK) {
                ESP_LOGE(TAG, "clock %u Hz: %s", static_cast<unsigned>(sample_hz), esp_err_to_name(e));
                return std::unexpected(err_of(e));
            }
            clock_hz_ = sample_hz;
        }
        if (const esp_err_t e = i2s_channel_enable(chan(rx_)); e != ESP_OK) {
            return std::unexpected(err_of(e));
        }
    }
    overruns_.store(0, std::memory_order_relaxed);
    sample_hz_ = sample_hz;
    return {};
}

std::expected<size_t, Err> I2sMic::read(std::span<int32_t> frames, uint32_t timeout_ms)
{
    if (rx_ == nullptr || sample_hz_ == 0) {
        return std::unexpected(Err::failed);
    }
    size_t got = 0;
    const esp_err_t e = i2s_channel_read(chan(rx_), frames.data(), frames.size() * kFrameBytes, &got, timeout_ms);
    if (e != ESP_OK && e != ESP_ERR_TIMEOUT) {
        return std::unexpected(Err::failed);
    }
    return got / kFrameBytes;
}

Status I2sMic::stop()
{
    if (rx_ != nullptr && sample_hz_ != 0) {
        if (cfg_.share_with != 0) {
            // The channel stays enabled while it is the clock master of a running amplifier.
            platform::i2s::stop(*platform::i2s::pair(cfg_.port), false, kPairOps);
        } else {
            i2s_channel_disable(chan(rx_));
        }
    }
    sample_hz_ = 0;
    return {};
}

hal::Selftest I2sMic::selftest()
{
    if (rx_ == nullptr) {
        return {false, "i2s_mic: no RX channel"};
    }
    if (sample_hz_ != 0) {
        return {true, "i2s_mic: running"};
    }
    // The clock runs and the DMA delivers: one buffer at the init rate, or at the amplifier's while it runs in a
    // share_with pair (one clock); the data itself cannot be judged here.
    const platform::i2s::Pair *pair = cfg_.share_with != 0 ? platform::i2s::pair(cfg_.port) : nullptr;
    const uint32_t partner = pair != nullptr ? platform::i2s::partner_hz(*pair, false) : 0;
    if (!start(partner != 0 ? partner : kInitHz)) {
        return {false, "i2s_mic: cannot start"};
    }
    int32_t buf[kDmaFrames];
    const auto got = read(buf, 100);
    stop();
    if (!got || *got == 0) {
        return {false, "i2s_mic: no frames from the DMA"};
    }
    return {true, "i2s_mic: clock and DMA run"};
}

}  // namespace fr::drv
