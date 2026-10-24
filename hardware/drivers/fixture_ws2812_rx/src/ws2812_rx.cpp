// fr:realtime
// fixture_ws2812_rx (design m2-c1-hil D4): RMT RX decode of a DUT's WS2812 line. The receive-done callback runs
// in the RMT ISR (not cache-safe by default, CONFIG_RMT_RX_ISR_CACHE_SAFE n, so it is masked while flash is
// busy): it decodes the refresh, queues the frame and re-arms the receive into the same buffer, then wakes the
// core task through one input slot shared by every line, which drains them all. The host suite builds this file over
// firmware/test/host/shim (FR_HOST_SHIM).
#include "fr/drv/fixture_ws2812_rx.hpp"

#include <cinttypes>
#include <cstdio>

#include "driver/gpio.h"
#include "driver/rmt_rx.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "sdkconfig.h"

#if CONFIG_RMT_RX_ISR_CACHE_SAFE
#error "fixture_ws2812_rx's receive-done callback and decode() live in flash: map src/ws2812_rx.cpp noflash first"
#endif

namespace fr::drv {
namespace {

portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
FixtureWs2812Rx *s_lines[FixtureWs2812Rx::kMaxLines] = {};
size_t s_count = 0;
InputSlot *s_slot = nullptr;  // its sample is ignored: it only wakes the core task

constexpr rmt_receive_config_t kReceive = [] {
    rmt_receive_config_t c = {};
    c.signal_range_min_ns = FixtureWs2812Rx::kGlitchNs;
    c.signal_range_max_ns = FixtureWs2812Rx::kIdleUs * 1000;
    return c;
}();

void drain_all()
{
    for (size_t i = 0; i < s_count; ++i) {
        s_lines[i]->drain();
    }
}

}  // namespace

struct FixtureWs2812Rx::Isr {
    static bool done(rmt_channel_handle_t, const rmt_rx_done_event_data_t *e, void *arg)
    {
        auto *self = static_cast<FixtureWs2812Rx *>(arg);
        const auto done_us = static_cast<uint32_t>(esp_timer_get_time());
        // The symbols are in symbols_ (the driver copied them there); decode before the buffer is re-armed.
        const size_t n = e->num_symbols < kSymbols ? e->num_symbols : kSymbols;
        const hal::FixtureFrame frame = decode({self->symbols_.data(), n}, done_us);
        portENTER_CRITICAL_ISR(&s_mux);
        if (self->len_ < kFrameQueue) {
            self->frames_[(self->head_ + self->len_) % kFrameQueue] = frame;
            ++self->len_;
        } else {
            ++self->lost_;
        }
        portEXIT_CRITICAL_ISR(&s_mux);
        // rmt_receive may be called from the ISR: the channel is back in its enabled state by now.
        if (!self->receive()) {
            self->rearm_ = true;
        }
        s_slot->update_from_isr(false, done_us);
        return false;  // update_from_isr yields itself when it woke the core task
    }
};

bool FixtureWs2812Rx::receive()
{
    return rmt_receive(chan_, symbols_.data(), sizeof(symbols_), &kReceive) == ESP_OK;
}

Status FixtureWs2812Rx::init(Core &core, const hal::FixtureLineMode &mode, hal::EdgeSink &sink)
{
    if (!GPIO_IS_VALID_GPIO(cfg_.gpio)) {
        return std::unexpected(Err::invalid_args);
    }
    // Input only, and no pulls: the DUT drives its data line push-pull.
    if (mode.decode != hal::FixtureDecode::ws2812 || mode.drive != hal::FixtureDrive::none || mode.pull_up) {
        return std::unexpected(Err::invalid_args);
    }
    if (sink_ != nullptr || s_count == kMaxLines) {
        return std::unexpected(Err::failed);
    }
    if (s_slot == nullptr) {
        s_slot = core.input_slot([](const InputSample &) { drain_all(); });
        if (s_slot == nullptr) {
            return std::unexpected(Err::failed);
        }
    }
    // No pulls (D12): the line reaches a DUT pin that may be a strap (pad-c6's GPIO8), and RMT RX leaves them as
    // the pad had them.
    const auto pin = static_cast<gpio_num_t>(cfg_.gpio);
    if (gpio_set_pull_mode(pin, GPIO_FLOATING) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    rmt_rx_channel_config_t rx = {};
    rx.gpio_num = pin;
    rx.clk_src = RMT_CLK_SRC_DEFAULT;
    rx.resolution_hz = kResolutionHz;
    rx.mem_block_symbols = kSymbols;
    rx.intr_priority = 0;
    // The channel, its ISR and the callback's context are allocated here, once at boot.
    if (rmt_new_rx_channel(&rx, &chan_) != ESP_OK) {
        chan_ = nullptr;
        return std::unexpected(Err::failed);
    }
    rmt_rx_event_callbacks_t cbs = {};
    cbs.on_recv_done = &Isr::done;
    if (rmt_rx_register_event_callbacks(chan_, &cbs, this) != ESP_OK || rmt_enable(chan_) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    sink_ = &sink;
    portENTER_CRITICAL(&s_mux);
    s_lines[s_count++] = this;
    portEXIT_CRITICAL(&s_mux);
    if (!receive()) {
        return std::unexpected(Err::failed);
    }
    return {};
}

std::expected<hal::FixturePress, Err> FixtureWs2812Rx::press(std::span<const uint32_t>, uint32_t)
{
    return std::unexpected(Err::unsupported);
}

Status FixtureWs2812Rx::release()
{
    return {};  // never drives
}

bool FixtureWs2812Rx::level() const
{
    return gpio_get_level(static_cast<gpio_num_t>(cfg_.gpio)) != 0;
}

void FixtureWs2812Rx::drain()
{
    if (sink_ == nullptr) {
        return;
    }
    if (rearm_) {
        rearm_ = false;
        if (!receive()) {
            rearm_ = true;  // the next drain tries again
        }
    }
    for (;;) {
        hal::FixtureFrame f{};
        uint32_t lost = 0;
        portENTER_CRITICAL(&s_mux);
        const bool have = len_ > 0;
        if (have) {
            f = frames_[head_];
            head_ = static_cast<uint8_t>((head_ + 1) % kFrameQueue);
            --len_;
        }
        lost = lost_;
        lost_ = 0;
        portEXIT_CRITICAL(&s_mux);
        // A refresh the queue had no room for still counts: as a frame with no bits, so a bad frame.
        for (uint32_t i = 0; i < lost; ++i) {
            ++frames_bad_;
            sink_->on_frame({.start_us = static_cast<uint32_t>(esp_timer_get_time()), .bits = 0, .grb = 0});
        }
        if (!have) {
            return;
        }
        if (f.bits == kFrameBits) {
            ++frames_ok_;
        } else {
            ++frames_bad_;
        }
        sink_->on_frame(f);
    }
}

hal::Selftest FixtureWs2812Rx::selftest()
{
    if (sink_ == nullptr) {
        return {false, "not initialized"};
    }
    // Between refreshes the DUT holds its data line low. High means a DUT pull-up before its RMT took the pin,
    // a short to 3V3, or the wrong pin.
    const bool high = level();
    snprintf(detail_, sizeof(detail_), "%s, %" PRIu32 " frames decoded, %" PRIu32 " bad%s",
             high ? "data line high at idle" : "data line idles low", frames_ok_, frames_bad_,
             rearm_ ? ", receive not armed" : "");
    return {!high && !rearm_, detail_};
}

#if FR_HOST_SHIM
/** The host suite (firmware/test/host/shim): this file's state as a fresh boot finds it, between tests. */
void fixture_ws2812_rx_host_reset()
{
    for (FixtureWs2812Rx *&l : s_lines) {
        l = nullptr;
    }
    s_count = 0;
    s_slot = nullptr;
}
#endif

}  // namespace fr::drv
