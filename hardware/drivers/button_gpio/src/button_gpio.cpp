// fr:realtime
#include "fr/drv/button_gpio.hpp"

#include <cinttypes>
#include <cstdio>

#include "driver/gpio.h"
#include "esp_attr.h"
#include "esp_timer.h"
#include "hal/gpio_ll.h"
#include "soc/gpio_struct.h"

namespace fr::drv {

Status ButtonGpio::init(Core &core, hal::ButtonSink &sink)
{
    if (!GPIO_IS_VALID_GPIO(cfg_.gpio)) {
        return std::unexpected(Err::invalid_args);
    }
    const auto pin = static_cast<gpio_num_t>(cfg_.gpio);
    sink_ = &sink;
    // The slot must exist before the interrupt is enabled: the ISR uses it unchecked.
    slot_ = core.input_slot([this](const InputSample &s) { sink_->on_button_edge(pressed(s.level), s.at, s.edges); });
    if (slot_ == nullptr) {
        return std::unexpected(Err::failed);
    }

    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.gpio;
    io.mode = GPIO_MODE_INPUT;
    io.pull_up_en = cfg_.pull == Pull::up ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE;
    io.pull_down_en = cfg_.pull == Pull::down ? GPIO_PULLDOWN_ENABLE : GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;  // enabled below, once the handler is in place
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }

    // Every GPIO driver shares the per-pin ISR service; the first one installs it. Not
    // ESP_INTR_FLAG_IRAM: an IRAM service requires every handler on it to be IRAM-safe, which only a
    // latency-critical build guarantees (spec 03 §3.4). This handler and the slot it calls already are
    // (fr_core's linker.lf maps EspInputSlot::update_from_isr to IRAM and its vtable to DRAM). Here the
    // interrupt stays masked while the cache is off, and a late edge still proves a transition, which
    // is what ButtonService relies on.
    const esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return std::unexpected(Err::failed);
    }
    if (gpio_isr_handler_add(pin, &ButtonGpio::isr, this) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    if (gpio_set_intr_type(pin, GPIO_INTR_ANYEDGE) != ESP_OK || gpio_intr_enable(pin) != ESP_OK) {
        gpio_isr_handler_remove(pin);
        return std::unexpected(Err::failed);
    }
    return {};
}

void IRAM_ATTR ButtonGpio::isr(void *arg)
{
    auto *self = static_cast<ButtonGpio *>(arg);
    // gpio_ll is inlined into this IRAM function; gpio_get_level is in flash unless
    // CONFIG_GPIO_CTRL_FUNC_IN_IRAM. The raw level goes into the slot and is mapped through
    // active_level on the core task.
    const bool level = gpio_ll_get_level(&GPIO, self->cfg_.gpio) != 0;
    self->isr_count_ = self->isr_count_ + 1;
    self->slot_->update_from_isr(level, esp_timer_get_time());
}

bool ButtonGpio::level_pressed() const
{
    return pressed(gpio_get_level(static_cast<gpio_num_t>(cfg_.gpio)) != 0);
}

hal::Selftest ButtonGpio::selftest()
{
    if (slot_ == nullptr) {
        return {false, "not initialized"};
    }
    // Nobody is expected to hold the button during a self-test, so the idle level must read released.
    const bool held = level_pressed();
    snprintf(detail_, sizeof(detail_), "%s, %" PRIu32 " interrupts since boot",
             held ? "reads pressed at idle (held, wrong active_level or pull, or stuck)" : "idle level released",
             static_cast<uint32_t>(isr_count_));
    return {!held, detail_};
}

}  // namespace fr::drv
