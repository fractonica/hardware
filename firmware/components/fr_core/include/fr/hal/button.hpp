// L1 button contract (spec 07 §7.7): a driver reports raw edges, ButtonService does everything else.
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** Implemented by ButtonService; called on the core task. */
class ButtonSink
{
public:
    /** `pressed` is the sampled level mapped through active_level; `edges` as in InputSample. */
    virtual void on_button_edge(bool pressed, TimeUs at, uint32_t edges) = 0;

protected:
    ~ButtonSink() = default;
};

/** GPIO, touch, ADC ladder, IO expander... */
class ButtonSource
{
public:
    virtual Status init(Core &core, ButtonSink &sink) = 0;
    /** Current sampled level, mapped through active_level. */
    virtual bool level_pressed() const = 0;
    /** Idle level check: a button that reads pressed at rest is miswired or stuck. */
    virtual Selftest selftest() = 0;

protected:
    ~ButtonSource() = default;
};

}  // namespace fr::hal
