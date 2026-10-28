// fr:realtime
#include "fr/drv/cst816_i2c.hpp"

#include <cinttypes>
#include <cstdio>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "fr/platform/gpio_isr.hpp"
#include "fr/platform/i2c_bus.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "cst816";
constexpr int kTimeoutMs = 20;
constexpr uint8_t kRegReport = 0x01;   // gesture, fingers, XH, XL, YH, YL
constexpr uint8_t kRegChipId = 0xA7;
constexpr uint8_t kRegIrqCtl = 0xFA;
constexpr uint8_t kRegDisAutoSleep = 0xFE;
constexpr uint8_t kIrqTouchAndChange = 0x60;  // EnTouch (periodic while touched) | EnChange (press and lift)
constexpr uint8_t kEventLift = 1;             // XH bits 7..6: 0 down, 1 lift, 2 contact

void delay_ms(uint32_t ms)
{
    vTaskDelay(pdMS_TO_TICKS(ms) > 0 ? pdMS_TO_TICKS(ms) : 1);
}

}  // namespace

Cst816I2c::Report Cst816I2c::decode(const uint8_t (&b)[6])
{
    const uint8_t fingers = b[1] & 0x0F;
    const uint8_t event = b[2] >> 6;
    return {.x = static_cast<uint16_t>(((b[2] & 0x0F) << 8) | b[3]),
            .y = static_cast<uint16_t>(((b[4] & 0x0F) << 8) | b[5]),
            .pressed = fingers > 0 && event != kEventLift};
}

Status Cst816I2c::init(Core &core, hal::TouchSink &sink)
{
    if (!GPIO_IS_VALID_GPIO(cfg_.irq)) {
        return std::unexpected(Err::invalid_args);
    }
    sink_ = &sink;
    if (cfg_.rst >= 0) {
        gpio_config_t r = {};
        r.pin_bit_mask = 1ULL << cfg_.rst;
        r.mode = GPIO_MODE_OUTPUT;
        if (gpio_config(&r) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        gpio_set_level(static_cast<gpio_num_t>(cfg_.rst), 0);
        delay_ms(10);
        gpio_set_level(static_cast<gpio_num_t>(cfg_.rst), 1);
        delay_ms(50);
    }
    const auto dev = platform::i2c_device(cfg_.sda, cfg_.scl, cfg_.address, cfg_.i2c_khz);
    if (!dev) {
        return std::unexpected(dev.error());
    }
    dev_ = *dev;
    core_ = &core;
    // A controller that does not answer is not a failure of init (asleep, or no touch panel on this board): it is
    // probed again for a while, and selftest says "absent" until it answers.
    if (!probe()) {
        probe_timer_ = core.timer([this] { on_probe_timer(); });
        probe_until_ = core.now() + static_cast<TimeUs>(kProbeForMs) * 1000;
        if (probe_timer_ != nullptr) {
            probe_timer_->start(kProbeEveryMs * 1000);
        }
        ESP_LOGW(TAG, "absent: no ACK at 0x%02X (a board without the touch panel, or asleep: touch the screen); "
                      "probing every %u s for %u s and on an interrupt",
                 cfg_.address, static_cast<unsigned>(kProbeEveryMs / 1000), static_cast<unsigned>(kProbeForMs / 1000));
    }

    // The slot must exist before the interrupt is enabled: the ISR uses it unchecked.
    slot_ = core.input_slot([this](const InputSample &s) {
        // An interrupt from a controller that never answered: it may just have woken (a sleeping CST816D wakes on a
        // touch), so probe it first.
        if (!present_ && !probe()) {
            return;
        }
        (void)read(s.at);
    });
    if (slot_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const auto pin = static_cast<gpio_num_t>(cfg_.irq);
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.irq;
    io.mode = GPIO_MODE_INPUT;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;  // enabled below, once the handler is in place
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    // The per-pin ISR service is shared with the other GPIO drivers (button_gpio: why not ESP_INTR_FLAG_IRAM), and
    // installed once through fr_core (IDF logs every repeat install as an error: pad-s3t's BOOT button comes first).
    if (!platform::gpio_isr_service(0)) {
        return std::unexpected(Err::failed);
    }
    if (gpio_isr_handler_add(pin, &Cst816I2c::isr, this) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    if (gpio_set_intr_type(pin, GPIO_INTR_NEGEDGE) != ESP_OK || gpio_intr_enable(pin) != ESP_OK) {
        gpio_isr_handler_remove(pin);
        return std::unexpected(Err::failed);
    }
    return {};
}

void IRAM_ATTR Cst816I2c::isr(void *arg)
{
    auto *self = static_cast<Cst816I2c *>(arg);
    self->isr_count_ = self->isr_count_ + 1;
    // The level is meaningless here (INT pulses low); the core task reads the report.
    self->slot_->update_from_isr(false, esp_timer_get_time());
}

bool Cst816I2c::probe()
{
    uint8_t id = 0;
    if (i2c_master_transmit_receive(dev_, &kRegChipId, 1, &id, 1, kTimeoutMs) != ESP_OK) {
        return false;
    }
    chip_id_ = id;
    if (present_) {
        return true;
    }
    present_ = true;
    if (probe_timer_ != nullptr) {
        probe_timer_->stop();
    }
    const uint8_t no_sleep[] = {kRegDisAutoSleep, 0x01};
    const uint8_t irq[] = {kRegIrqCtl, kIrqTouchAndChange};
    if (i2c_master_transmit(dev_, no_sleep, sizeof(no_sleep), kTimeoutMs) != ESP_OK ||
        i2c_master_transmit(dev_, irq, sizeof(irq), kTimeoutMs) != ESP_OK) {
        ESP_LOGW(TAG, "chip 0x%02X refused its setup", id);
    }
    return true;
}

void Cst816I2c::on_probe_timer()
{
    if (present_) {
        return;
    }
    if (probe()) {
        ESP_LOGI(TAG, "chip 0x%02X answered at 0x%02X", chip_id_, cfg_.address);
        return;
    }
    if (core_->now() + static_cast<TimeUs>(kProbeEveryMs) * 1000 > probe_until_) {
        ESP_LOGW(TAG, "absent: still no ACK at 0x%02X after %u s; probing again only on an interrupt or a selftest",
                 cfg_.address, static_cast<unsigned>(kProbeForMs / 1000));
        return;
    }
    probe_timer_->start(kProbeEveryMs * 1000);
}

Status Cst816I2c::read(TimeUs at)
{
    if (!present_) {
        return std::unexpected(Err::failed);  // nothing answers: the bus is left alone
    }
    uint8_t b[6] = {};
    if (i2c_master_transmit_receive(dev_, &kRegReport, 1, b, sizeof(b), kTimeoutMs) != ESP_OK) {
        ++read_errors_;
        return std::unexpected(Err::failed);
    }
    const Report r = decode(b);
    sink_->on_touch(r.x, r.y, r.pressed, hal::TouchGesture::none, at);
    return {};
}

Status Cst816I2c::poll()
{
    if (dev_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    return read(esp_timer_get_time());
}

hal::Selftest Cst816I2c::selftest()
{
    if (dev_ == nullptr) {
        return {false, "not initialized"};
    }
    if (!present_ && !probe()) {
        snprintf(detail_, sizeof(detail_),
                 "absent: no ACK at 0x%02X (a board without the touch panel, or asleep: touch the screen)", cfg_.address);
        return {false, detail_};
    }
    uint8_t id = 0;
    const bool ack = i2c_master_transmit_receive(dev_, &kRegChipId, 1, &id, 1, kTimeoutMs) == ESP_OK;
    if (ack) {
        chip_id_ = id;
    }
    const char *kind = id == 0xB4 ? "CST816S" : id == 0xB5 ? "CST816T" : id == 0xB6 ? "CST816D" : "unknown chip";
    if (ack) {
        snprintf(detail_, sizeof(detail_), "chip id 0x%02X (%s) at 0x%02X, %" PRIu32 " interrupts, %" PRIu32 " read errors",
                 id, kind, cfg_.address, static_cast<uint32_t>(isr_count_), read_errors_);
    } else {
        snprintf(detail_, sizeof(detail_), "no ACK at 0x%02X (it answered before as 0x%02X: asleep?), %" PRIu32
                 " interrupts since boot", cfg_.address, chip_id_, static_cast<uint32_t>(isr_count_));
    }
    return {ack, detail_};
}

}  // namespace fr::drv
