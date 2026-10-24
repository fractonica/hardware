// fr:realtime
// fixture_gpio (design m2-c1-hil D4, D11): presses from ISR-dispatched esp_timers, any-edge capture in an
// IRAM ISR, one edge ring for every line, and the releases on every reset path. linker.lf maps this object
// `noflash`: the edge ISR runs on the ESP_INTR_FLAG_IRAM GPIO ISR service and the press timers from the IRAM
// systimer alarm, both while flash is busy, and the panic hook with the cache in any state, so their code (with
// the inlined gpio_ll, ring and Plan code, and whatever -Og leaves out of line) sits in IRAM and every object they
// touch in internal RAM. The host suite builds this file over firmware/test/host/shim (FR_HOST_SHIM).
#include "fr/drv/fixture_gpio.hpp"

#include <cinttypes>
#include <cstdio>
#include <iterator>

#include "driver/gpio.h"
#include "edge_ring.hpp"
#include "esp_attr.h"
#include "esp_bit_defs.h"
#include "esp_intr_alloc.h"
#include "esp_log.h"
#include "esp_private/startup_internal.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "hal/gpio_ll.h"
#include "sdkconfig.h"
#include "soc/gpio_struct.h"

#if !CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD
// fixture_gpio's driver.yaml `sdkconfig` list sets it in every profile that binds the driver (design m2-c1-hil D5).
#error "fixture_gpio runs presses from ESP_TIMER_ISR timers: CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y"
#endif
#if !CONFIG_ESP_TIMER_IN_IRAM
#error "fixture_gpio's press timers must run while flash is busy: CONFIG_ESP_TIMER_IN_IRAM (design m2-c1-hil D4)"
#endif

namespace fr::drv {
namespace {

constexpr const char *TAG = "fixture_gpio";

// Guards the ring and every line's press state: the ISRs run on CPU0 (the GPIO ISR service is installed from
// the boot task, the esp_timer ISR has CPU0 affinity), the core task on CPU1.
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
fixture::EdgeRing<256, FixtureGpio::kMaxLines> s_ring;
FixtureGpio *s_lines[FixtureGpio::kMaxLines] = {};
size_t s_count = 0;
// One input slot for every line: its sample is ignored, it only wakes the core task, which drains the ring.
InputSlot *s_slot = nullptr;
bool s_isr_service = false;
bool s_draining = false;
bool s_shutdown_handler = false;  // release_for_restart() is registered with esp_restart
// Every constructed line's pin (bit n: GPIO n), for release_at_boot(): constant-initialized, so the generated
// board's constructors (dynamic initialization) can note theirs before any init function reads it.
uint64_t s_pins = 0;
static_assert(GPIO_NUM_MAX <= 64, "s_pins holds one bit per GPIO");

constexpr uint32_t low32(int64_t t)
{
    return static_cast<uint32_t>(t);
}

IRAM_ATTR void wake()
{
    if (s_slot != nullptr) {
        s_slot->update_from_isr(false, 0);  // IRAM-safe (fr_core's linker.lf); from a task it notifies normally
    }
}

/** Arms a one-shot timer for the absolute time `at`, or for now when that has passed (start_once_at refuses
 * an alarm in the past). */
IRAM_ATTR bool arm_at(esp_timer_handle_t t, int64_t at)
{
    const int64_t now = esp_timer_get_time();
    return esp_timer_start_once_at(t, static_cast<uint64_t>(at > now ? at : now)) == ESP_OK;
}

}  // namespace

FixtureGpio::FixtureGpio(const Config &cfg) : cfg_(cfg)
{
    if (cfg.gpio < 64) {
        s_pins |= uint64_t{1} << cfg.gpio;  // no hardware here (spec 03 §3.4): release_at_boot() acts on it
    }
}

// ---- ISRs and the press state (under s_mux) ----

IRAM_ATTR void FixtureGpio::isr(void *arg)
{
    auto *self = static_cast<FixtureGpio *>(arg);
    // The stamp first, as close to the edge as the clock can be read; gpio_ll is inlined (gpio_get_level is
    // in flash unless CONFIG_GPIO_CTRL_FUNC_IN_IRAM).
    const uint32_t at = low32(esp_timer_get_time());
    const bool level = gpio_ll_get_level(&GPIO, self->cfg_.gpio) != 0;
    portENTER_CRITICAL_ISR(&s_mux);
    s_ring.push(at, self->ch_, level);
    portEXIT_CRITICAL_ISR(&s_mux);
    self->edge_us_ = at;
    self->edge_level_ = level;
    self->edge_seq_ = self->edge_seq_ + 1;
    self->isr_count_ = self->isr_count_ + 1;
    wake();
}

IRAM_ATTR int64_t FixtureGpio::write_locked(bool pressed, bool &pushed)
{
    const bool level = pin_level(mode_.drive, pressed);
    gpio_ll_set_level(&GPIO, cfg_.gpio, level ? 1 : 0);
    const int64_t at = esp_timer_get_time();
    // A line without capture (nfet_gate) reports its write stamps: the DUT's boot.pressed mirrors the BOOT
    // line itself (design m2-c1-hil D4, D8). Writes that change nothing (a release of a released line) are no
    // edge.
    if (!edge_irq(mode_) && pressed != driven_) {
        s_ring.push(low32(at), ch_, level);
        pushed = true;
    }
    driven_ = pressed;
    return at;
}

IRAM_ATTR void FixtureGpio::end_locked(bool &pushed)
{
    running_ = false;
    esp_timer_stop(segment_);  // ESP_ERR_INVALID_STATE when not armed: nothing to do
    esp_timer_stop(guard_);
    write_locked(false, pushed);
}

IRAM_ATTR void FixtureGpio::step_locked(bool &pushed)
{
    for (;;) {
        write_locked(plan_.pressed_after(next_), pushed);
        ++next_;
        if (next_ >= plan_.n) {
            running_ = false;  // the last boundary released the line
            esp_timer_stop(guard_);
            return;
        }
        due_ = t0_ + plan_.ends[next_];
        if (due_ <= esp_timer_get_time()) {
            continue;  // a short segment behind a late interrupt: its boundary is due already
        }
        if (!arm_at(segment_, due_)) {
            end_locked(pushed);  // never hold the line past a segment it cannot time
        }
        return;
    }
}

IRAM_ATTR void FixtureGpio::on_segment(void *arg)
{
    auto *self = static_cast<FixtureGpio *>(arg);
    bool pushed = false;
    portENTER_CRITICAL_ISR(&s_mux);
    // A stale alarm (its press released, and maybe a new one started, while it was being dispatched) finds no
    // press, or a boundary still ahead, and does nothing.
    if (self->running_ && esp_timer_get_time() >= self->due_) {
        self->step_locked(pushed);
    }
    portEXIT_CRITICAL_ISR(&s_mux);
    if (pushed) {
        wake();
    }
}

IRAM_ATTR void FixtureGpio::on_guard(void *arg)
{
    auto *self = static_cast<FixtureGpio *>(arg);
    bool pushed = false;
    portENTER_CRITICAL_ISR(&s_mux);
    // Whatever the segment timer did, the line is let go min(total, cap) + kGuardUs after the press edge
    // (design m2-c1-hil D11 item 1). Only a stale alarm finds a newer press's cap release still ahead.
    if (esp_timer_get_time() >= self->guard_due_) {
        self->end_locked(pushed);
    }
    portEXIT_CRITICAL_ISR(&s_mux);
    if (pushed) {
        wake();
    }
}

bool FixtureGpio::released_locked() const
{
    return (gpio_ll_get_level(&GPIO, cfg_.gpio) != 0) == pin_level(mode_.drive, false);
}

// ---- the reset paths (design m2-c1-hil D11 item 1) ----
// On the S3, esp_restart() and a panic's restart end in esp_restart_noos(), a CPU reset of both cores
// (esp_system/port/soc/esp32s3/system_internal.c) that leaves the GPIO and IO_MUX registers as they were. A chip,
// system or USB-Serial/JTAG (RTS) reset clears them; the RTC watchdog's system reset too.

IRAM_ATTR void FixtureGpio::release_for_panic()
{
    // No lock: the panicking CPU may hold it, and the other one is stalled. Interrupts are off here, so no timer
    // ISR comes back to press again before the reset.
    for (size_t i = 0; i < s_count; ++i) {
        const FixtureGpio &l = *s_lines[i];
        if (l.mode_.drive != hal::FixtureDrive::none) {
            gpio_ll_set_level(&GPIO, l.cfg_.gpio, pin_level(l.mode_.drive, false) ? 1 : 0);
        }
    }
}

void FixtureGpio::release_for_restart()
{
    // esp_restart runs this on the calling task before esp_restart_noos(): under the lock, with both timers stopped
    // and the press ended, no ISR on the other CPU presses again in between.
    portENTER_CRITICAL(&s_mux);
    for (size_t i = 0; i < s_count; ++i) {
        FixtureGpio &l = *s_lines[i];
        if (l.mode_.drive != hal::FixtureDrive::none) {
            l.running_ = false;
            esp_timer_stop(l.segment_);
            esp_timer_stop(l.guard_);
            gpio_ll_set_level(&GPIO, l.cfg_.gpio, pin_level(l.mode_.drive, false) ? 1 : 0);
            l.driven_ = false;
        }
    }
    portEXIT_CRITICAL(&s_mux);
}

void FixtureGpio::release_at_boot()
{
    // The drive is not known yet (FixtureService hands it over in init()), and needs not be: with its output off an
    // open_drain line reads high through the DUT's pull-up and an nfet_gate line's gate low through its pull-down
    // (D12). Interrupts a CPU reset left enabled are masked until init() arms them again.
    for (int n = 0; n < GPIO_NUM_MAX; ++n) {
        if ((s_pins & (uint64_t{1} << n)) != 0 && GPIO_IS_VALID_GPIO(n)) {
            gpio_ll_intr_disable(&GPIO, static_cast<uint32_t>(n));
            gpio_ll_output_disable(&GPIO, static_cast<uint32_t>(n));
        }
    }
}

// Before app_main, so before fr::core::start()'s NVS, epoch commit, OTA hashing and serial start (and the status
// LED's init), which a line pressed at a CPU reset would otherwise outlast: SECONDARY runs after the C++
// constructors, and 109 before the coredump check (130). CPU0 only.
ESP_SYSTEM_INIT_FN(fixture_gpio_release_at_boot, SECONDARY, BIT(0), 109)
{
    FixtureGpio::release_at_boot();
    return ESP_OK;
}

// ---- core task ----

Status FixtureGpio::init(Core &core, const hal::FixtureLineMode &mode, hal::EdgeSink &sink)
{
    if (!GPIO_IS_VALID_GPIO(cfg_.gpio)) {
        return std::unexpected(Err::invalid_args);
    }
    if (mode.decode != hal::FixtureDecode::level) {
        return std::unexpected(Err::unsupported);  // decode ws2812 is fixture_ws2812_rx's (RMT RX)
    }
    const bool drives = mode.drive != hal::FixtureDrive::none;
    // A driving line has no pulls (D4): open_drain lets the DUT's pull-up win, nfet_gate has its gate pull-down.
    if (drives && (!GPIO_IS_VALID_OUTPUT_GPIO(cfg_.gpio) || mode.pull_up)) {
        return std::unexpected(Err::invalid_args);
    }
    if (sink_ != nullptr || s_count == kMaxLines) {
        return std::unexpected(Err::failed);
    }
    // A driving line needs esp_restart to let go of it first (D11 item 1). Five handlers fit; none left means
    // this line never drives rather than one a reboot could leave pressed.
    if (drives && !s_shutdown_handler) {
        const esp_err_t err = esp_register_shutdown_handler(&FixtureGpio::release_for_restart);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "no shutdown handler slot left: a restart could leave a press held");
            return std::unexpected(Err::failed);
        }
        s_shutdown_handler = true;
    }
    if (s_slot == nullptr) {
        s_slot = core.input_slot([](const InputSample &) { drain_all(); });
        if (s_slot == nullptr) {
            return std::unexpected(Err::failed);
        }
    }
    mode_ = mode;
    const auto pin = static_cast<gpio_num_t>(cfg_.gpio);

    // Released before it becomes an output (the test_pin.cpp pattern): a DUT may be sampling its straps now.
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.gpio;
    io.pull_up_en = !drives && mode.pull_up ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE;  // test_pin lines only
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;  // never on a line that reaches a DUT strap (D12)
    io.intr_type = GPIO_INTR_DISABLE;         // enabled below, once the handler is in place
    switch (mode.drive) {
    case hal::FixtureDrive::open_drain:
        gpio_set_level(pin, 1);
        io.mode = GPIO_MODE_INPUT_OUTPUT_OD;  // reads its own line back
        break;
    case hal::FixtureDrive::nfet_gate:
        gpio_set_level(pin, 0);
        io.mode = GPIO_MODE_INPUT_OUTPUT;  // push-pull, idle low; the input reads the gate it drives
        break;
    case hal::FixtureDrive::none:
        io.mode = GPIO_MODE_INPUT;  // can never drive
        break;
    }
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }

    if (drives) {
        esp_timer_create_args_t args = {};
        args.arg = this;
        args.dispatch_method = ESP_TIMER_ISR;
        args.skip_unhandled_events = false;
        args.callback = &FixtureGpio::on_segment;
        args.name = "fix_segment";
        if (esp_timer_create(&args, &segment_) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        args.callback = &FixtureGpio::on_guard;
        args.name = "fix_cap";
        if (esp_timer_create(&args, &guard_) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
    }

    // In the table before the interrupt is enabled: the ISR's `ch_` and drain_all() index it.
    sink_ = &sink;
    portENTER_CRITICAL(&s_mux);
    ch_ = static_cast<uint8_t>(s_count);
    s_lines[s_count] = this;
    ++s_count;
    portEXIT_CRITICAL(&s_mux);

    if (!edge_irq(mode)) {
        return {};
    }
    // ESP_INTR_FLAG_IRAM: the service keeps its handler table in internal RAM (gpio.c) and runs while flash
    // is busy, so every handler on it must be IRAM-safe. That is why the fixture profile has no button_gpio
    // instance, whose handler is not (design m2-c1-hil D4).
    if (!s_isr_service) {
        const esp_err_t err = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
        if (err == ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "GPIO ISR service already installed by another driver, maybe without ESP_INTR_FLAG_IRAM: "
                          "edges are late while flash is busy");
        } else if (err != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        s_isr_service = true;
    }
    if (gpio_isr_handler_add(pin, &FixtureGpio::isr, this) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    if (gpio_set_intr_type(pin, GPIO_INTR_ANYEDGE) != ESP_OK || gpio_intr_enable(pin) != ESP_OK) {
        gpio_isr_handler_remove(pin);
        return std::unexpected(Err::failed);
    }
    return {};
}

std::expected<hal::FixturePress, Err> FixtureGpio::press(std::span<const uint32_t> segments_us, uint32_t cap_us)
{
    if (sink_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (mode_.drive == hal::FixtureDrive::none) {
        return std::unexpected(Err::unsupported);
    }
    const auto plan = Plan::make(segments_us, cap_us);
    if (!plan) {
        return std::unexpected(plan.error());
    }
    bool pushed = false;
    bool started = false;
    Err err = Err::busy;
    uint32_t seq = 0;
    int64_t t0 = 0;
    portENTER_CRITICAL(&s_mux);
    if (!running_ && released_locked()) {
        plan_ = *plan;
        next_ = 0;
        running_ = true;
        seq = edge_seq_;
        t0 = write_locked(true, pushed);
        t0_ = t0;
        due_ = t0 + plan_.ends[0];
        guard_due_ = t0 + plan_.guard_us();
        // The core task only arms the timers; every later edge and the release come from their ISRs.
        started = arm_at(guard_, guard_due_) && arm_at(segment_, due_);
        if (!started) {
            end_locked(pushed);
            err = Err::failed;
        }
    }
    portEXIT_CRITICAL(&s_mux);
    if (pushed) {
        wake();
    }
    if (!started) {
        return std::unexpected(err);
    }
    uint32_t at = low32(t0);
    if (edge_irq(mode_)) {
        // open_drain: the press edge is the ISR's capture of the line itself, so write stamp - capture stamp
        // measures the fixture's own ISR latency on every press. Without one in kReadbackUs the write stamp
        // stands (the edges event still reports what was captured).
        const bool level = pin_level(mode_.drive, true);
        while (esp_timer_get_time() - t0 < kReadbackUs) {
            if (edge_seq_ != seq && edge_level_ == level) {
                at = edge_us_;
                break;
            }
        }
    }
    return hal::FixturePress{.at_us = at, .total_us = plan->total_us};
}

Status FixtureGpio::release()
{
    if (sink_ == nullptr || mode_.drive == hal::FixtureDrive::none) {
        return {};
    }
    bool pushed = false;
    portENTER_CRITICAL(&s_mux);
    end_locked(pushed);
    portEXIT_CRITICAL(&s_mux);
    if (pushed) {
        wake();
    }
    return {};
}

bool FixtureGpio::pressing() const
{
    return running_;
}

bool FixtureGpio::level() const
{
    return gpio_get_level(static_cast<gpio_num_t>(cfg_.gpio)) != 0;
}

void FixtureGpio::drain()
{
    drain_all();
}

void FixtureGpio::drain_all()
{
    if (s_draining) {
        return;  // a sink that drains from on_edges: the loop below delivers what it would
    }
    s_draining = true;
    fixture::RingEdge chunk[32];
    hal::FixtureEdge run[std::size(chunk)];
    for (;;) {
        size_t n = 0;
        portENTER_CRITICAL(&s_mux);
        while (n < std::size(chunk) && s_ring.pop(chunk[n])) {
            ++n;
        }
        portEXIT_CRITICAL(&s_mux);
        // Each run of one line's edges goes to its sink in one call, outside the lock.
        for (size_t i = 0; i < n;) {
            const uint8_t ch = chunk[i].ch;
            size_t k = 0;
            for (; i < n && chunk[i].ch == ch; ++i) {
                run[k++] = {.t_us = chunk[i].t_us, .level = chunk[i].level != 0};
            }
            if (ch < s_count) {
                s_lines[ch]->sink_->on_edges({run, k}, 0);
            }
        }
        if (n < std::size(chunk)) {
            break;
        }
    }
    // Overflows were the newest edges at the time: they follow what the ring held.
    for (size_t ch = 0; ch < s_count; ++ch) {
        portENTER_CRITICAL(&s_mux);
        const uint32_t dropped = s_ring.take_dropped(static_cast<uint8_t>(ch));
        portEXIT_CRITICAL(&s_mux);
        if (dropped > 0) {
            s_lines[ch]->sink_->on_edges({}, dropped);
        }
    }
    s_draining = false;
}

hal::Selftest FixtureGpio::selftest()
{
    if (sink_ == nullptr) {
        return {false, "not initialized"};
    }
    portENTER_CRITICAL(&s_mux);
    const bool released = released_locked();
    const bool running = running_;
    portEXIT_CRITICAL(&s_mux);
    const bool high = level();
    const char *state = "";
    bool ok = true;
    switch (mode_.drive) {
    case hal::FixtureDrive::open_drain:
        ok = running || released;
        state = running  ? "pressing"
                : ok     ? "released, reads high"
                         : "reads low at idle (the DUT holds BOOT, is unpowered, or the line is shorted)";
        break;
    case hal::FixtureDrive::nfet_gate:
        ok = running || released;
        state = running ? "pressing" : ok ? "released, gate low" : "gate reads high at idle (shorted to 3V3?)";
        break;
    case hal::FixtureDrive::none:
        state = high            ? "input, reads high"
                : mode_.pull_up ? "input, reads low (the DUT is unpowered or stuck)"
                                : "input, reads low";
        break;
    }
    if (edge_irq(mode_)) {
        snprintf(detail_, sizeof(detail_), "%s, %" PRIu32 " edges captured", state, static_cast<uint32_t>(isr_count_));
    } else {
        snprintf(detail_, sizeof(detail_), "%s", state);
    }
    return {ok, detail_};
}

#if FR_HOST_SHIM
/** The host suite (firmware/test/host/shim): this file's state as a fresh boot finds it, between tests. */
void fixture_gpio_host_reset()
{
    s_ring = {};
    for (FixtureGpio *&l : s_lines) {
        l = nullptr;
    }
    s_count = 0;
    s_slot = nullptr;
    s_isr_service = false;
    s_draining = false;
    s_shutdown_handler = false;
    s_pins = 0;
}
#endif

}  // namespace fr::drv

// The panic hook (D11 item 1): every panic (a task or interrupt watchdog with CONFIG_ESP_TASK_WDT_PANIC, abort, an
// assert, a fault) reaches esp_panic_handler from the port's handler, with the other CPU stalled; CMakeLists.txt
// links with -Wl,--wrap=esp_panic_handler. The lines are let go here, before the backtrace and the coredump (which
// takes up to seconds on this flash) and the restart's CPU reset, which keeps them as they are. IRAM (noflash).
extern "C" void __real_esp_panic_handler(void *info);
extern "C" IRAM_ATTR void __wrap_esp_panic_handler(void *info)
{
    fr::drv::FixtureGpio::release_for_panic();
    __real_esp_panic_handler(info);
}
