// button_gpio (design c2 §6, spec 07 §7.8): hal::ButtonSource on one GPIO. An any-edge interrupt writes
// the core's input slot; ButtonService debounces on the core task, so the ISR stays a few instructions.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/button.hpp"

namespace fr::drv {

class ButtonGpio final : public hal::ButtonSource
{
public:
    enum class ActiveLevel : uint8_t { low, high };
    // external and none leave the pad's pulls off: the board has its own resistor, or the line is driven.
    enum class Pull : uint8_t { up, down, external, none };

    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the
    // board manifest entry.
    struct Config {
        uint8_t gpio = 0;
        ActiveLevel active_level = ActiveLevel::low;
        Pull pull = Pull::up;
    };

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit ButtonGpio(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core, hal::ButtonSink &sink) override;
    bool level_pressed() const override;
    hal::Selftest selftest() override;

private:
    static void isr(void *arg);
    bool pressed(bool level) const { return level == (cfg_.active_level == ActiveLevel::high); }

    Config cfg_;
    InputSlot *slot_ = nullptr;
    hal::ButtonSink *sink_ = nullptr;
    // Interrupts taken since init, so selftest can tell a dead interrupt from a lost delivery.
    volatile uint32_t isr_count_ = 0;
    char detail_[112] = {};
};

}  // namespace fr::drv
