// The host suite's ESP-IDF shim (esp_sim.hpp): the idf/ functions the fixture drivers call, on FakeCore's clock.
#include "esp_sim.hpp"

#include <algorithm>
#include <array>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/rmt_rx.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_private/startup_internal.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "hal/gpio_ll.h"
#include "soc/gpio_sig_map.h"
#include "soc/gpio_struct.h"

gpio_dev_t GPIO = {};

extern "C" void __wrap_esp_panic_handler(void *info);  // fixture_gpio.cpp: the panic hook under test

struct esp_timer {
    esp_timer_cb_t cb = nullptr;
    void *arg = nullptr;
    std::string name;
    esp_timer_dispatch_t dispatch = ESP_TIMER_TASK;
    fr::Timer *ct = nullptr;  // the FakeCore timer behind it
    bool armed = false;
    bool dead = false;  // a CPU reset took it
    bool lose = false;
    uint32_t late_us = 0;
    int fail_starts = 0;
    int fires = 0;
};

struct rmt_channel_t {
    int gpio = -1;
    uint32_t resolution_hz = 0;
    size_t mem_block_symbols = 0;
    rmt_rx_done_callback_t cb = nullptr;
    void *user = nullptr;
    bool enabled = false;
    bool armed = false;
    void *buf = nullptr;
    size_t buf_symbols = 0;
    rmt_receive_config_t cfg{};
    int fail_receives = 0;
};

namespace esp_sim {
namespace {

constexpr int kPins = GPIO_NUM_MAX;
/** esp_timer_impl_get_min_period_us() on the systimer: an alarm up to this far in the past still arms. */
constexpr int64_t kMinPeriodUs = 50;

struct Pin {
    uint8_t out = 0;
    bool oe = false, od = false, ie = false, pu = false, pd = false;
    Pull pull_ext = Pull::none;
    Drive drive_ext = Drive::none;
    gpio_int_type_t intr_type = GPIO_INTR_DISABLE;
    bool intr_ena = false;
    gpio_isr_t handler = nullptr;
    void *arg = nullptr;
    bool pending = false;
    bool lose_irqs = false;
    int isr_calls = 0;
    bool last = false;  // the net's level as of the last update()
    int ledc = -1;      // the LEDC channel the GPIO matrix routes to it; -1: its output register
    // GPIO_FUNCn_OEN_SEL clear: while a peripheral (LEDC) is routed to the pin, the output enable is that
    // peripheral's (LEDC's is always on) and GPIO_ENABLE (oe) is ignored. ledc_channel_config clears OEN_SEL
    // (esp_rom_gpio_connect_out_signal); gpio_ll_set_output_enable_ctrl(.., false, ..) sets it.
    bool oen_periph = false;
    std::vector<Write> writes;
};

/** An S3 low-speed LEDC timer and channel. */
struct LedcTimer {
    uint32_t freq_hz = 0;
    int bits = 0;
};
struct LedcChannel {
    bool configured = false;
    int gpio = -1;
    int timer = 0;
    uint32_t duty = 0;     // set by ledc_set_duty
    uint32_t applied = 0;  // ... and output since ledc_update_duty
};

struct Registered {
    esp_err_t (*fn)(void);
    int stage;
    int priority;
    unsigned cores;
    const char *name;
};

struct Sim {
    fr::Core *core = nullptr;
    int64_t offset = 0;  // spin(): esp_timer_get_time() runs ahead of the core clock
    uint32_t spin_us = 0;
    std::array<Pin, kPins> pins{};
    bool isr_service = false;
    int isr_flags = 0;
    int crit = 0;  // open critical sections
    int isr = 0;   // ISRs running
    bool masked = false;  // a panic turned interrupts off until the CPU reset
    std::vector<std::unique_ptr<esp_timer>> timers;
    std::vector<shutdown_handler_t> shutdown;
    size_t shutdown_free = 5;
    int real_panics = 0;
    std::function<void()> on_real_panic;
    std::array<int, 4> logs{};
    std::vector<std::unique_ptr<rmt_channel_t>> rmt;
    std::array<int, kPins> rmt_fail{};  // rmt_fail_receives before the channel exists
    std::array<LedcTimer, LEDC_TIMER_MAX> ledc_timers{};
    std::array<LedcChannel, LEDC_CHANNEL_MAX> ledc{};
    int ledc_timer_configs = 0;
};

Sim &sim()
{
    static Sim s;
    return s;
}

std::vector<Registered> &init_fns()
{
    static std::vector<Registered> fns;
    return fns;
}

Pin &pin(int n)
{
    if (n < 0 || n >= kPins || !GPIO_IS_VALID_GPIO(n)) {
        std::fprintf(stderr, "esp_sim: GPIO%d is not an S3 GPIO\n", n);
        std::abort();
    }
    return sim().pins[static_cast<size_t>(n)];
}

/** The output enable the pad sees: the routed peripheral's while OEN_SEL is clear, else GPIO_ENABLE. On
 * SIG_GPIO_OUT_IDX the pad always takes GPIO_ENABLE. */
bool oe_effective(const Pin &p)
{
    return (p.ledc >= 0 && p.oen_periph) || p.oe;
}

bool net_level(const Pin &p)
{
    if (p.drive_ext == Drive::short_low) {
        return false;
    }
    if (p.drive_ext == Drive::short_high) {
        return true;
    }
    if (p.ledc >= 0 && oe_effective(p)) {
        return sim().ledc[static_cast<size_t>(p.ledc)].applied > 0;  // a PWM waveform: high while its duty is not 0
    }
    if (p.oe && p.out == 0) {
        return false;
    }
    if (p.oe && !p.od && p.out != 0) {
        return true;
    }
    if (p.drive_ext == Drive::low) {
        return false;
    }
    if (p.drive_ext == Drive::high) {
        return true;
    }
    if (p.pull_ext == Pull::up || p.pu) {
        return true;
    }
    if (p.pull_ext == Pull::down || p.pd) {
        return false;
    }
    return false;  // floating: the S3 pad reads it low more often than not (inferred), and nothing relies on it
}

/** Runs the pending GPIO ISRs once nothing masks them. */
void deliver()
{
    Sim &s = sim();
    for (bool again = true; again;) {
        again = false;
        if (s.crit > 0 || s.isr > 0 || s.masked) {
            return;
        }
        for (Pin &p : s.pins) {
            if (p.pending) {
                p.pending = false;
                if (s.isr_service && p.handler != nullptr && p.intr_ena) {
                    ++p.isr_calls;
                    ++s.isr;
                    p.handler(p.arg);
                    --s.isr;
                    again = true;
                }
            }
        }
    }
}

/** A pin's state changed: an edge of its net arms its interrupt, then whatever is deliverable runs. */
void update(int n)
{
    Pin &p = pin(n);
    const bool lv = net_level(p);
    if (lv != p.last) {
        p.last = lv;
        const bool match = p.intr_type == GPIO_INTR_ANYEDGE || (p.intr_type == GPIO_INTR_POSEDGE && lv) ||
                           (p.intr_type == GPIO_INTR_NEGEDGE && !lv);
        if (match && p.intr_ena && !p.lose_irqs) {
            p.pending = true;
        }
    }
    deliver();
}

void fire(esp_timer *t)
{
    Sim &s = sim();
    if (t->dead) {
        return;
    }
    t->armed = false;
    if (t->lose) {
        return;
    }
    ++t->fires;
    ++s.isr;
    t->cb(t->arg);
    --s.isr;
    deliver();
}

rmt_channel_t *channel_on(int gpio)
{
    for (auto &c : sim().rmt) {
        if (c->gpio == gpio) {
            return c.get();
        }
    }
    return nullptr;
}

}  // namespace

void reset()
{
    Sim &s = sim();
    for (auto &t : s.timers) {
        t->dead = true;
        if (t->ct != nullptr && s.core != nullptr) {
            t->ct->stop();
        }
    }
    s = Sim{};
}

void attach(fr::Core &core)
{
    sim().core = &core;
}

int64_t now()
{
    Sim &s = sim();
    return s.core != nullptr ? s.core->now() + s.offset : 0;
}

void set_pull(int gpio, Pull p)
{
    pin(gpio).pull_ext = p;
    update(gpio);
}

void set_drive(int gpio, Drive d)
{
    pin(gpio).drive_ext = d;
    update(gpio);
}

bool level(int gpio)
{
    return net_level(pin(gpio));
}

bool output_enabled(int gpio)
{
    return oe_effective(pin(gpio));
}

bool open_drain(int gpio)
{
    return pin(gpio).od;
}

bool pull_up(int gpio)
{
    return pin(gpio).pu;
}

bool pull_down(int gpio)
{
    return pin(gpio).pd;
}

bool out(int gpio)
{
    return pin(gpio).out != 0;
}

bool edge_irq(int gpio)
{
    const Pin &p = pin(gpio);
    return sim().isr_service && p.handler != nullptr && p.intr_ena && p.intr_type == GPIO_INTR_ANYEDGE;
}

int isr_calls(int gpio)
{
    return pin(gpio).isr_calls;
}

void lose_irqs(int gpio, bool on)
{
    pin(gpio).lose_irqs = on;
}

const std::vector<Write> &writes(int gpio)
{
    return pin(gpio).writes;
}

void clear_writes()
{
    for (Pin &p : sim().pins) {
        p.writes.clear();
    }
}

bool isr_service()
{
    return sim().isr_service;
}

int isr_service_flags()
{
    return sim().isr_flags;
}

esp_timer *timer(const char *name, const void *arg)
{
    for (auto &t : sim().timers) {
        if (!t->dead && t->name == name && t->arg == arg) {
            return t.get();
        }
    }
    return nullptr;
}

bool armed(esp_timer *t)
{
    return t->armed;
}

bool isr_dispatch(esp_timer *t)
{
    return t->dispatch == ESP_TIMER_ISR;
}

int fires(esp_timer *t)
{
    return t->fires;
}

void lose_alarms(esp_timer *t, bool on)
{
    t->lose = on;
}

void delay_alarms(esp_timer *t, uint32_t late_us)
{
    t->late_us = late_us;
}

void fail_starts(esp_timer *t, int n)
{
    t->fail_starts = n;
}

void fire_stale(esp_timer *t)
{
    Sim &s = sim();
    ++t->fires;
    ++s.isr;
    t->cb(t->arg);
    --s.isr;
    deliver();
}

void spin(uint32_t us_per_read)
{
    sim().spin_us = us_per_read;
}

void restart()
{
    Sim &s = sim();
    const std::vector<shutdown_handler_t> handlers = s.shutdown;
    for (auto it = handlers.rbegin(); it != handlers.rend(); ++it) {
        (*it)();
    }
    cpu_reset();
}

void cpu_reset()
{
    Sim &s = sim();
    for (auto &t : s.timers) {
        t->dead = true;
        t->armed = false;
        if (t->ct != nullptr) {
            t->ct->stop();
        }
    }
    s.isr_service = false;
    s.isr_flags = 0;
    for (Pin &p : s.pins) {
        p.handler = nullptr;  // the ISR service's table was in RAM; the pin's own interrupt config is GPIO block
        p.arg = nullptr;
        p.pending = false;
    }
    s.shutdown.clear();
    s.shutdown_free = 5;
    s.crit = 0;
    s.isr = 0;
    s.masked = false;
    s.rmt.clear();  // the RMT peripheral is reset at boot by its driver; its channels were RAM
    // LEDC is not reset (esp_restart_noos resets MCPWM, not LEDC): its timers and channels run on, as the GPIO matrix
    // routes them, until a driver configures them again.
}

void panic()
{
    Sim &s = sim();
    s.masked = true;  // the port's panic handler runs with interrupts off and the other CPU stalled
    __wrap_esp_panic_handler(nullptr);
}

int real_panics()
{
    return sim().real_panics;
}

void on_real_panic(std::function<void()> hook)
{
    sim().on_real_panic = std::move(hook);
}

InitFn init_fn(const char *name)
{
    for (const Registered &f : init_fns()) {
        if (std::strcmp(f.name, name) == 0) {
            return {.stage = f.stage, .priority = f.priority, .cores = f.cores};
        }
    }
    return {};
}

int boot()
{
    std::vector<Registered> fns = init_fns();
    std::stable_sort(fns.begin(), fns.end(), [](const Registered &a, const Registered &b) {
        return a.stage != b.stage ? a.stage < b.stage : a.priority < b.priority;
    });
    for (const Registered &f : fns) {
        if (const esp_err_t err = f.fn(); err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

size_t shutdown_handlers()
{
    return sim().shutdown.size();
}

void limit_shutdown_handlers(size_t free_slots)
{
    sim().shutdown_free = free_slots;
}

int logs(char level)
{
    const char *const kLevels = "EWID";
    const char *at = std::strchr(kLevels, level);
    return at != nullptr && *at != '\0' ? sim().logs[static_cast<size_t>(at - kLevels)] : 0;
}

int ledc_channel(int gpio)
{
    return pin(gpio).ledc;
}

int ledc_duty(int ch)
{
    const LedcChannel &c = sim().ledc.at(static_cast<size_t>(ch));
    return c.configured ? static_cast<int>(c.applied) : -1;
}

int ledc_timer_of(int ch)
{
    return sim().ledc.at(static_cast<size_t>(ch)).timer;
}

uint32_t ledc_freq_hz(int t)
{
    return sim().ledc_timers.at(static_cast<size_t>(t)).freq_hz;
}

int ledc_bits(int t)
{
    return sim().ledc_timers.at(static_cast<size_t>(t)).bits;
}

int ledc_timer_configs()
{
    return sim().ledc_timer_configs;
}

bool rmt_armed(int gpio)
{
    const rmt_channel_t *c = channel_on(gpio);
    return c != nullptr && c->armed;
}

bool rmt_deliver(int gpio, std::span<const uint32_t> symbols)
{
    Sim &s = sim();
    rmt_channel_t *c = channel_on(gpio);
    if (c == nullptr || !c->armed || c->cb == nullptr) {
        return false;
    }
    const size_t n = std::min(symbols.size(), c->buf_symbols);
    std::memcpy(c->buf, symbols.data(), n * sizeof(uint32_t));
    c->armed = false;  // the channel is back in its enabled state: the callback may receive again
    const rmt_rx_done_event_data_t e{.received_symbols = c->buf, .num_symbols = n};
    ++s.isr;
    c->cb(c, &e, c->user);
    --s.isr;
    deliver();
    return true;
}

void rmt_fail_receives(int gpio, int n)
{
    if (rmt_channel_t *c = channel_on(gpio)) {
        c->fail_receives = n;
    } else {
        sim().rmt_fail[static_cast<size_t>(gpio)] = n;
    }
}

uint32_t rmt_resolution_hz(int gpio)
{
    const rmt_channel_t *c = channel_on(gpio);
    return c != nullptr ? c->resolution_hz : 0;
}

size_t rmt_mem_block_symbols(int gpio)
{
    const rmt_channel_t *c = channel_on(gpio);
    return c != nullptr ? c->mem_block_symbols : 0;
}

uint32_t rmt_range_min_ns(int gpio)
{
    const rmt_channel_t *c = channel_on(gpio);
    return c != nullptr ? c->cfg.signal_range_min_ns : 0;
}

uint32_t rmt_range_max_ns(int gpio)
{
    const rmt_channel_t *c = channel_on(gpio);
    return c != nullptr ? c->cfg.signal_range_max_ns : 0;
}

std::vector<uint32_t> ws2812_symbols(uint32_t grb, int bits)
{
    // 20 MHz ticks: T1H 0.8 µs = 16, T1L 0.45 µs = 9; T0H 0.4 µs = 8, T0L 0.85 µs = 17.
    std::vector<uint32_t> out;
    for (int i = bits - 1; i >= 0; --i) {
        const bool one = ((grb >> (i % 32)) & 1u) != 0;
        const uint32_t high = one ? 16 : 8;
        const uint32_t low = i == 0 ? 0 : one ? 9 : 17;  // the receiver ends the frame in the idle low
        out.push_back(high | 0x8000u | (low << 16));
    }
    return out;
}

}  // namespace esp_sim

// ---- the idf/ functions ----

using esp_sim::pin;
using esp_sim::sim;
using esp_sim::update;

void esp_sim_log(char level, const char *tag, const char *fmt, ...)
{
    const char *const kLevels = "EWID";
    if (const char *at = std::strchr(kLevels, level); at != nullptr && *at != '\0') {
        ++sim().logs[static_cast<size_t>(at - kLevels)];
    }
    if (std::getenv("FR_SIM_LOG") != nullptr) {
        std::fprintf(stderr, "%c (%s) ", level, tag);
        va_list ap;
        va_start(ap, fmt);
        std::vfprintf(stderr, fmt, ap);
        va_end(ap);
        std::fputc('\n', stderr);
    }
}

void esp_sim_enter_critical(portMUX_TYPE *mux)
{
    ++mux->count;
    ++sim().crit;
}

void esp_sim_exit_critical(portMUX_TYPE *mux)
{
    if (mux->count <= 0 || sim().crit <= 0) {
        std::fprintf(stderr, "esp_sim: portEXIT_CRITICAL without portENTER_CRITICAL\n");
        std::abort();
    }
    --mux->count;
    --sim().crit;
    esp_sim::deliver();
}

void esp_sim_gpio_set_out(uint32_t gpio_num, uint32_t level)
{
    auto &p = pin(static_cast<int>(gpio_num));
    const uint8_t v = level != 0 ? 1 : 0;
    if (p.out != v) {
        p.out = v;
        p.writes.push_back({esp_sim::now(), v != 0});
    }
    update(static_cast<int>(gpio_num));
}

int esp_sim_gpio_read(uint32_t gpio_num)
{
    const auto &p = pin(static_cast<int>(gpio_num));
    return p.ie && esp_sim::net_level(p) ? 1 : 0;
}

void esp_sim_gpio_output_disable(uint32_t gpio_num)
{
    pin(static_cast<int>(gpio_num)).oe = false;
    update(static_cast<int>(gpio_num));
}

void esp_sim_gpio_intr_disable(uint32_t gpio_num)
{
    pin(static_cast<int>(gpio_num)).intr_ena = false;
}

void esp_sim_gpio_output_enable(uint32_t gpio_num)
{
    pin(static_cast<int>(gpio_num)).oe = true;
    update(static_cast<int>(gpio_num));
}

void esp_sim_gpio_output_enable_ctrl(uint32_t gpio_num, bool ctrl_by_periph)
{
    pin(static_cast<int>(gpio_num)).oen_periph = ctrl_by_periph;
    update(static_cast<int>(gpio_num));
}

void esp_sim_gpio_matrix_out(uint32_t gpio_num, uint32_t signal_idx)
{
    if (signal_idx == SIG_GPIO_OUT_IDX) {
        pin(static_cast<int>(gpio_num)).ledc = -1;  // other signals are not modelled: LEDC's come from ledc_channel_config
    }
    update(static_cast<int>(gpio_num));
}

esp_err_t gpio_config(const gpio_config_t *cfg)
{
    for (int n = 0; n < esp_sim::kPins; ++n) {
        if ((cfg->pin_bit_mask & (uint64_t{1} << n)) == 0) {
            continue;
        }
        if (!GPIO_IS_VALID_GPIO(n)) {
            return ESP_ERR_INVALID_ARG;
        }
        auto &p = pin(n);
        p.ie = (cfg->mode & GPIO_MODE_INPUT) != 0;
        p.oe = (cfg->mode & GPIO_MODE_OUTPUT) != 0;
        if (p.oe) {
            p.ledc = -1;  // gpio_output_enable connects SIG_GPIO_OUT_IDX
        }
        p.od = (cfg->mode & 0x4) != 0;
        p.pu = cfg->pull_up_en == GPIO_PULLUP_ENABLE;
        p.pd = cfg->pull_down_en == GPIO_PULLDOWN_ENABLE;
        p.intr_type = cfg->intr_type;
        p.intr_ena = cfg->intr_type != GPIO_INTR_DISABLE;
        update(n);
    }
    return ESP_OK;
}

esp_err_t gpio_set_level(gpio_num_t gpio_num, uint32_t level)
{
    if (!GPIO_IS_VALID_GPIO(gpio_num)) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_sim_gpio_set_out(static_cast<uint32_t>(gpio_num), level);
    return ESP_OK;
}

int gpio_get_level(gpio_num_t gpio_num)
{
    if (!GPIO_IS_VALID_GPIO(gpio_num)) {
        return 0;
    }
    return esp_sim_gpio_read(static_cast<uint32_t>(gpio_num));
}

esp_err_t gpio_set_pull_mode(gpio_num_t gpio_num, gpio_pull_mode_t pull)
{
    if (!GPIO_IS_VALID_GPIO(gpio_num)) {
        return ESP_ERR_INVALID_ARG;
    }
    auto &p = pin(gpio_num);
    p.pu = pull == GPIO_PULLUP_ONLY || pull == GPIO_PULLUP_PULLDOWN;
    p.pd = pull == GPIO_PULLDOWN_ONLY || pull == GPIO_PULLUP_PULLDOWN;
    update(gpio_num);
    return ESP_OK;
}

esp_err_t gpio_install_isr_service(int intr_alloc_flags)
{
    if (sim().isr_service) {
        return ESP_ERR_INVALID_STATE;
    }
    sim().isr_service = true;
    sim().isr_flags = intr_alloc_flags;
    return ESP_OK;
}

esp_err_t gpio_isr_handler_add(gpio_num_t gpio_num, gpio_isr_t isr_handler, void *args)
{
    if (!sim().isr_service) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!GPIO_IS_VALID_GPIO(gpio_num)) {
        return ESP_ERR_INVALID_ARG;
    }
    pin(gpio_num).handler = isr_handler;
    pin(gpio_num).arg = args;
    return ESP_OK;
}

esp_err_t gpio_isr_handler_remove(gpio_num_t gpio_num)
{
    if (!sim().isr_service) {
        return ESP_ERR_INVALID_STATE;
    }
    pin(gpio_num).handler = nullptr;
    pin(gpio_num).arg = nullptr;
    return ESP_OK;
}

esp_err_t gpio_set_intr_type(gpio_num_t gpio_num, gpio_int_type_t intr_type)
{
    if (!GPIO_IS_VALID_GPIO(gpio_num)) {
        return ESP_ERR_INVALID_ARG;
    }
    pin(gpio_num).intr_type = intr_type;
    return ESP_OK;
}

esp_err_t gpio_intr_enable(gpio_num_t gpio_num)
{
    if (!GPIO_IS_VALID_GPIO(gpio_num)) {
        return ESP_ERR_INVALID_ARG;
    }
    pin(gpio_num).intr_ena = true;
    return ESP_OK;
}

esp_err_t esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *out_handle)
{
    auto &s = sim();
    if (s.core == nullptr || args == nullptr || args->callback == nullptr || out_handle == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    auto t = std::make_unique<esp_timer>();
    esp_timer *raw = t.get();
    raw->cb = args->callback;
    raw->arg = args->arg;
    raw->name = args->name != nullptr ? args->name : "";
    raw->dispatch = args->dispatch_method;
    raw->ct = s.core->timer([raw] { esp_sim::fire(raw); });
    if (raw->ct == nullptr) {
        return ESP_ERR_NO_MEM;
    }
    s.timers.push_back(std::move(t));
    *out_handle = raw;
    return ESP_OK;
}

esp_err_t esp_timer_start_once_at(esp_timer_handle_t timer, uint64_t alarm_us)
{
    if (timer == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (timer->dead) {
        return ESP_ERR_INVALID_STATE;
    }
    if (timer->fail_starts > 0) {
        --timer->fail_starts;
        return ESP_FAIL;
    }
    const int64_t now = esp_sim::now();
    const auto at = static_cast<int64_t>(alarm_us);
    if (at + esp_sim::kMinPeriodUs < now) {
        return ESP_ERR_INVALID_ARG;
    }
    if (timer->armed) {
        return ESP_ERR_INVALID_STATE;  // timer_init: inserting it twice would loop the list
    }
    timer->armed = true;
    timer->ct->start(static_cast<uint32_t>(std::max<int64_t>(0, at - now)) + timer->late_us);
    return ESP_OK;
}

esp_err_t esp_timer_stop(esp_timer_handle_t timer)
{
    if (timer == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!timer->armed) {
        return ESP_ERR_INVALID_STATE;
    }
    timer->armed = false;
    timer->ct->stop();
    return ESP_OK;
}

int64_t esp_timer_get_time(void)
{
    auto &s = sim();
    const int64_t t = esp_sim::now();
    s.offset += s.spin_us;
    return t;
}

esp_err_t esp_register_shutdown_handler(shutdown_handler_t handler)
{
    auto &s = sim();
    if (std::find(s.shutdown.begin(), s.shutdown.end(), handler) != s.shutdown.end()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (s.shutdown_free == 0) {
        return ESP_ERR_NO_MEM;
    }
    --s.shutdown_free;
    s.shutdown.push_back(handler);
    return ESP_OK;
}

bool esp_sim_register_init_fn(esp_err_t (*fn)(void), int stage, unsigned cores, int priority, const char *name)
{
    esp_sim::init_fns().push_back({fn, stage, priority, cores, name});
    return true;
}

extern "C" void __real_esp_panic_handler(void *)
{
    auto &s = sim();
    ++s.real_panics;
    if (s.on_real_panic) {
        s.on_real_panic();
    }
}

esp_err_t rmt_new_rx_channel(const rmt_rx_channel_config_t *config, rmt_channel_handle_t *ret_chan)
{
    auto &s = sim();
    if (config == nullptr || ret_chan == nullptr || !GPIO_IS_VALID_GPIO(config->gpio_num) || s.rmt.size() == 4) {
        return ESP_ERR_INVALID_ARG;  // the S3 has 4 RX channels (rmt_ll.h); ESP_ERR_NOT_FOUND there
    }
    pin(config->gpio_num).ie = true;  // the channel takes the pin as an input through the GPIO matrix
    auto c = std::make_unique<rmt_channel_t>();
    c->gpio = config->gpio_num;
    c->resolution_hz = config->resolution_hz;
    c->mem_block_symbols = config->mem_block_symbols;
    c->fail_receives = s.rmt_fail[static_cast<size_t>(config->gpio_num)];
    *ret_chan = c.get();
    s.rmt.push_back(std::move(c));
    return ESP_OK;
}

esp_err_t rmt_rx_register_event_callbacks(rmt_channel_handle_t rx_channel, const rmt_rx_event_callbacks_t *cbs,
                                          void *user_data)
{
    if (rx_channel == nullptr || cbs == nullptr || rx_channel->enabled) {
        return ESP_ERR_INVALID_STATE;
    }
    rx_channel->cb = cbs->on_recv_done;
    rx_channel->user = user_data;
    return ESP_OK;
}

esp_err_t rmt_enable(rmt_channel_handle_t channel)
{
    if (channel == nullptr || channel->enabled) {
        return ESP_ERR_INVALID_STATE;
    }
    channel->enabled = true;
    return ESP_OK;
}

esp_err_t rmt_receive(rmt_channel_handle_t rx_channel, void *buffer, size_t buffer_size,
                      const rmt_receive_config_t *config)
{
    if (rx_channel == nullptr || buffer == nullptr || config == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!rx_channel->enabled || rx_channel->armed) {
        return ESP_ERR_INVALID_STATE;  // "channel not in enable state": a receive is in flight
    }
    if (rx_channel->fail_receives > 0) {
        --rx_channel->fail_receives;
        return ESP_FAIL;
    }
    rx_channel->armed = true;
    rx_channel->buf = buffer;
    rx_channel->buf_symbols = buffer_size / sizeof(uint32_t);
    rx_channel->cfg = *config;
    return ESP_OK;
}

esp_err_t ledc_timer_config(const ledc_timer_config_t *timer_conf)
{
    if (timer_conf == nullptr || timer_conf->speed_mode != LEDC_LOW_SPEED_MODE || timer_conf->timer_num >= LEDC_TIMER_MAX ||
        timer_conf->freq_hz == 0 || timer_conf->duty_resolution < 1 || timer_conf->duty_resolution > 14) {
        return ESP_ERR_INVALID_ARG;
    }
    ++sim().ledc_timer_configs;
    sim().ledc_timers[timer_conf->timer_num] = {.freq_hz = timer_conf->freq_hz,
                                                .bits = static_cast<int>(timer_conf->duty_resolution)};
    return ESP_OK;
}

esp_err_t ledc_channel_config(const ledc_channel_config_t *ledc_conf)
{
    if (ledc_conf == nullptr || ledc_conf->speed_mode != LEDC_LOW_SPEED_MODE || ledc_conf->channel >= LEDC_CHANNEL_MAX ||
        ledc_conf->timer_sel >= LEDC_TIMER_MAX || !GPIO_IS_VALID_OUTPUT_GPIO(ledc_conf->gpio_num)) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_sim::LedcChannel &c = sim().ledc[ledc_conf->channel];
    c = {.configured = true,
         .gpio = ledc_conf->gpio_num,
         .timer = static_cast<int>(ledc_conf->timer_sel),
         .duty = ledc_conf->duty,
         .applied = ledc_conf->duty};
    auto &p = pin(ledc_conf->gpio_num);
    p.ledc = static_cast<int>(ledc_conf->channel);
    p.oe = true;          // ledc_set_pin: the channel's signal through the GPIO matrix, output enabled ...
    p.oen_periph = true;  // ... by LEDC (OEN_SEL clear): GPIO_ENABLE no longer turns it off
    update(ledc_conf->gpio_num);
    return ESP_OK;
}

esp_err_t ledc_set_duty(ledc_mode_t speed_mode, ledc_channel_t channel, uint32_t duty)
{
    if (speed_mode != LEDC_LOW_SPEED_MODE || channel >= LEDC_CHANNEL_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_sim::LedcChannel &c = sim().ledc[channel];
    if (!c.configured) {
        return ESP_ERR_INVALID_STATE;
    }
    c.duty = duty;
    return ESP_OK;
}

esp_err_t ledc_update_duty(ledc_mode_t speed_mode, ledc_channel_t channel)
{
    if (speed_mode != LEDC_LOW_SPEED_MODE || channel >= LEDC_CHANNEL_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_sim::LedcChannel &c = sim().ledc[channel];
    if (!c.configured) {
        return ESP_ERR_INVALID_STATE;
    }
    c.applied = c.duty;
    update(c.gpio);
    return ESP_OK;
}
