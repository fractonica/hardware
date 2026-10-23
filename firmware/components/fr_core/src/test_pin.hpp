// The T-LAT test pin (design c6 D24, spec 04 §4.3 `test_pin`): diag `pin_pulse <us>` drives the board's
// test_pin (CONFIG_FR_TEST_PIN) low for `us`, open-drain, never pushed high: it is wired to another board's
// input, a strapping BOOT pin on the T-LAT rig, which must read high whenever that board resets. Debug builds
// (FR_TEST_HOOKS) only; a release build leaves the pin as the reset left it. Private to fr_core.
#pragma once

#include <cstdint>
#include <expected>

#include "fr/base.hpp"
#include "fr/diag.hpp"

namespace fr::core::test_pin {

/** The pin released (open-drain output, high-Z, no internal pull) and the release timer; boot task, once. */
void init();

/** CONFIG_FR_TEST_PIN, -1 without one. */
int pin();

/**
 * Drives the pin low and answers when it went low; a dedicated one-shot esp_timer (outside the core's
 * 23-timer pool) releases it after `us`. busy while a pulse runs; unsupported without a test pin (or test
 * hooks); failed when the timer would not start (the pin is released again at once). Core task.
 */
std::expected<diag::PulseInfo, Err> pulse(uint32_t us);

}  // namespace fr::core::test_pin
