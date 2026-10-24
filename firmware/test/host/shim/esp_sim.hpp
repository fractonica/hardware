// The host suite's ESP-IDF shim (design m2-c1-hil §4 S1): the test side of firmware/test/host/shim/idf.
//
// The host suite builds hardware/drivers/fixture_gpio/src/fixture_gpio.cpp and
// hardware/drivers/fixture_ws2812_rx/src/ws2812_rx.cpp unchanged against idf/ (FR_HOST_SHIM), so FixtureService's
// tests run the drivers' own press sequencing, stale-alarm checks, readback, edge ring, RMT receive path and
// reset-path releases instead of a copy of them. Each idf/ header declares only what those two files use, with
// IDF v6.1's names and answers; esp_sim.cpp implements them on FakeCore's clock and timers. This header is the
// tests' side: the net each pin sits on, alarm faults, restarts, panics and boots.
//
// One CPU, deterministic: an esp_timer callback runs at its alarm (a FakeCore timer, as an ISR), a GPIO edge's ISR
// runs once no critical section is open and no ISR is running (as on the CPU that takes both), and nothing else
// moves the clock.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <span>
#include <vector>

#include "fr/core/core.hpp"

struct esp_timer;

namespace esp_sim {

/** An external resistor on a pin's net: a DUT's BOOT pull-up, a MOSFET gate's pull-down. */
enum class Pull : uint8_t { none, up, down };
/**
 * Another driver on the net. `low`/`high` come through the line's series resistor, so the fixture's own output wins
 * at its pin (a DUT holding BOOT, an LED pin, a test_pin); `short_low`/`short_high` win over everything.
 */
enum class Drive : uint8_t { none, low, high, short_low, short_high };

/** ESP_INTR_FLAG_IRAM (esp_intr_alloc.h), for isr_service_flags(). */
inline constexpr int kIntrFlagIram = 1 << 10;
/** ESP_SYSTEM_INIT_STAGE_CORE / _SECONDARY. */
inline constexpr int kStageCore = 0;
inline constexpr int kStageSecondary = 1;

/** One ESP_SYSTEM_INIT_FN as registered. */
struct InitFn {
    int stage = -1;
    int priority = 0;
    unsigned cores = 0;
};

/** A change of a pin's output register, with the clock then. */
struct Write {
    int64_t at;
    bool level;
};

/** Everything back to a chip just out of a power-on reset, with nothing attached; the init functions stay. */
void reset();
/** The clock and timer pool the shim runs on (esp_timer_get_time() = core.now()). */
void attach(fr::Core &core);
int64_t now();

// ---- pins ----
void set_pull(int gpio, Pull p);
void set_drive(int gpio, Drive d);
/** The level the net has now (what an input reads). */
bool level(int gpio);
bool output_enabled(int gpio);
bool open_drain(int gpio);
bool pull_up(int gpio);
bool pull_down(int gpio);
/** The output register. */
bool out(int gpio);
/** An edge interrupt is configured, enabled and has a handler. */
bool edge_irq(int gpio);
int isr_calls(int gpio);
/** Its edges reach no ISR (an interrupt lost). */
void lose_irqs(int gpio, bool on);
/** Output-register changes since the last clear_writes(). */
const std::vector<Write> &writes(int gpio);
void clear_writes();
bool isr_service();
int isr_service_flags();

// ---- esp_timer ----
/** The timer created with this name and arg (the driver passes its line); nullptr when there is none. */
esp_timer *timer(const char *name, const void *arg);
bool armed(esp_timer *t);
bool isr_dispatch(esp_timer *t);
/** Callbacks run so far (stale ones included). */
int fires(esp_timer *t);
/** Armed alarms of `t` never fire (a lost alarm); `t` reads disarmed when it would have. */
void lose_alarms(esp_timer *t, bool on);
/** Every alarm of `t` fires `late_us` after its time (a late interrupt). */
void delay_alarms(esp_timer *t, uint32_t late_us);
/** The next `n` starts of `t` fail (ESP_FAIL). */
void fail_starts(esp_timer *t, int n);
/** `t`'s callback runs now, armed or not: an alarm dispatched after the timer was stopped and maybe re-armed. */
void fire_stale(esp_timer *t);
/** Each esp_timer_get_time() call moves the clock on by this much from now on (0: off): a busy-wait terminates. */
void spin(uint32_t us_per_read);

// ---- the system ----
/** esp_restart(): the shutdown handlers, last registered first, then cpu_reset(). */
void restart();
/**
 * A CPU reset (esp_restart_noos on the S3, a panic's restart): RAM and the software are gone (timers, the ISR
 * service and its handlers, the shutdown handlers, pending interrupts), the GPIO block keeps its registers. The
 * drivers' own RAM is the test's to clear (fixture_gpio_host_reset and fixture_ws2812_rx_host_reset).
 */
void cpu_reset();
/** A panic: interrupts off, then esp_panic_handler as the wrapped link calls it (__wrap_esp_panic_handler). The
 * test then does the restart's cpu_reset(). */
void panic();
/** Calls that reached __real_esp_panic_handler, and a hook it runs first (the pins as the real handler finds them). */
int real_panics();
void on_real_panic(std::function<void()> hook);
/** The registered ESP_SYSTEM_INIT_FN functions as start_cpu0_default runs them: CORE, then SECONDARY, each by
 * priority. ESP_OK from each, or the first other answer. */
int boot();
/** The ESP_SYSTEM_INIT_FN named `name` (stage -1: none). */
InitFn init_fn(const char *name);
size_t shutdown_handlers();
/** Slots esp_register_shutdown_handler still has (IDF: 5 in all). */
void limit_shutdown_handlers(size_t free_slots);
/** ESP_LOGx lines so far at `level` ('E', 'W', 'I', 'D'). */
int logs(char level);

// ---- RMT RX ----
/** The channel on `gpio` has a receive armed. */
bool rmt_armed(int gpio);
/** Completes the armed receive on `gpio` with `symbols` (rmt_symbol_word_t values) and runs on_recv_done as the RMT
 * ISR; false when no receive was armed (the refresh is not captured). */
bool rmt_deliver(int gpio, std::span<const uint32_t> symbols);
/** The next `n` rmt_receive calls on `gpio` fail. */
void rmt_fail_receives(int gpio, int n);
/** The configuration rmt_new_rx_channel and rmt_receive got. */
uint32_t rmt_resolution_hz(int gpio);
size_t rmt_mem_block_symbols(int gpio);
uint32_t rmt_range_min_ns(int gpio);
uint32_t rmt_range_max_ns(int gpio);
/** A WS2812 refresh as an RMT RX receive sees it at 20 MHz: per bit high 0.8 µs (1) or 0.4 µs (0), then low;
 * the last symbol's low half is the end marker (0). */
std::vector<uint32_t> ws2812_symbols(uint32_t grb, int bits = 24);

}  // namespace esp_sim

namespace fr::drv {
// The drivers' RAM as a fresh boot finds it (FR_HOST_SHIM builds define them).
void fixture_gpio_host_reset();
void fixture_ws2812_rx_host_reset();
}  // namespace fr::drv
