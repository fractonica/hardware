// hx711_gpio (design scale-round-c1 D8): see include/fr/drv/hx711_gpio.hpp.
#include "fr/drv/hx711_gpio.hpp"

#include <cinttypes>
#include <cstdio>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "fr/platform/gpio_isr.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "hx711";
// The train's critical section: masks interrupts on this core (and, on the S3, keeps the other core's IPC off it for
// the ~60-80 µs it lasts), so PD_SCK is never held high long enough to power the part down.
portMUX_TYPE s_train_mux = portMUX_INITIALIZER_UNLOCKED;
// PD_SCK high and low per pulse: the datasheet's T3/T4 are >= 0.2 µs (high at most 50 µs); DOUT is valid 0.1 µs
// after the rising edge (T2), so it is read before the falling one.
constexpr uint32_t kHalfPeriodUs = 1;

uint32_t now_ms()
{
    return static_cast<uint32_t>(esp_timer_get_time() / 1000);
}

}  // namespace

Status Hx711Gpio::init(Core &)
{
    if (task_ != nullptr) {
        return {};
    }
    const auto sck = static_cast<gpio_num_t>(cfg_.sck);
    const auto dout = static_cast<gpio_num_t>(cfg_.dout);
    // PD_SCK high before it becomes an output: the part stays powered down until start().
    gpio_set_level(sck, 1);
    gpio_config_t out = {};
    out.pin_bit_mask = 1ULL << cfg_.sck;
    out.mode = GPIO_MODE_OUTPUT;
    out.intr_type = GPIO_INTR_DISABLE;
    if (gpio_config(&out) != ESP_OK || gpio_set_level(sck, 1) != ESP_OK) {
        ESP_LOGE(TAG, "PD_SCK GPIO%u: gpio_config refused", static_cast<unsigned>(cfg_.sck));
        return std::unexpected(Err::failed);
    }
    // DOUT is push-pull on the part; the pull-up makes a missing wire read "not ready" (never a conversion).
    gpio_config_t in = {};
    in.pin_bit_mask = 1ULL << cfg_.dout;
    in.mode = GPIO_MODE_INPUT;
    in.pull_up_en = GPIO_PULLUP_ENABLE;
    in.pull_down_en = GPIO_PULLDOWN_DISABLE;
    in.intr_type = GPIO_INTR_DISABLE;  // enabled by the task once the part is powered
    if (gpio_config(&in) != ESP_OK) {
        ESP_LOGE(TAG, "DOUT GPIO%u: gpio_config refused", static_cast<unsigned>(cfg_.dout));
        return std::unexpected(Err::failed);
    }
    TaskHandle_t t = nullptr;
    if (xTaskCreate(&Hx711Gpio::task_main, "fr_hx711", kStackBytes, this, kTaskPriority, &t) != pdPASS) {
        ESP_LOGE(TAG, "cannot create the task");
        return std::unexpected(Err::failed);
    }
    task_ = t;
    // The per-pin ISR service is shared with the other GPIO drivers (installed once through fr_core); not IRAM.
    if (!platform::gpio_isr_service(0) || gpio_set_intr_type(dout, GPIO_INTR_NEGEDGE) != ESP_OK ||
        gpio_isr_handler_add(dout, &Hx711Gpio::isr, this) != ESP_OK) {
        ESP_LOGE(TAG, "DOUT GPIO%u: no edge interrupt (the task polls every %" PRIu32 " ms)",
                 static_cast<unsigned>(cfg_.dout), kWaitMs);
        // Not fatal: the task's poll still reads every conversion it finds ready (at most 10 a second).
    }
    ESP_LOGI(TAG, "DOUT GPIO%u, PD_SCK GPIO%u", static_cast<unsigned>(cfg_.dout), static_cast<unsigned>(cfg_.sck));
    return {};
}

Status Hx711Gpio::start(hal::LoadCellGain gain)
{
    if (task_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    want_gain_.store(static_cast<uint8_t>(gain), std::memory_order_relaxed);
    want_on_.store(true, std::memory_order_release);
    xTaskNotifyGive(static_cast<TaskHandle_t>(task_));
    return {};
}

Status Hx711Gpio::stop()
{
    if (task_ == nullptr) {
        return {};
    }
    want_on_.store(false, std::memory_order_release);
    xTaskNotifyGive(static_cast<TaskHandle_t>(task_));
    return {};
}

void Hx711Gpio::isr(void *arg)
{
    auto *self = static_cast<Hx711Gpio *>(arg);
    // DOUT toggles with the data bits during the train: off until the task has read the conversion.
    gpio_intr_disable(static_cast<gpio_num_t>(self->cfg_.dout));
    self->edge_at_ = esp_timer_get_time();
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(static_cast<TaskHandle_t>(self->task_), &woken);
    portYIELD_FROM_ISR(woken);
}

void Hx711Gpio::task_main(void *arg)
{
    static_cast<Hx711Gpio *>(arg)->loop();
}

void Hx711Gpio::loop()
{
    const auto sck = static_cast<gpio_num_t>(cfg_.sck);
    const auto dout = static_cast<gpio_num_t>(cfg_.dout);
    for (;;) {
        const bool edge = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(kWaitMs)) > 0;
        const TimeUs now = esp_timer_get_time();
        const bool want = want_on_.load(std::memory_order_acquire);
        if (want != on_) {
            on_ = want;
            if (on_) {
                // PD_SCK low after more than 60 µs high: the part resets, powers up at channel A gain 128 and settles.
                gpio_set_level(sck, 0);
                gain_ = want_gain_.load(std::memory_order_relaxed);
                drop_ = kSettleDrops;
                on_at_ = now;
                since_on_ = 0;
                logged_dead_ = false;
                window_.reset();
            } else {
                gpio_intr_disable(dout);
                gpio_set_level(sck, 1);  // powered down (< 1 µA)
                window_.reset();
            }
        }
        if (on_) {
            const uint8_t g = want_gain_.load(std::memory_order_relaxed);
            if (g != gain_) {
                gain_ = g;
                drop_ = kSettleDrops;  // the conversion in progress is at the old gain, then the part settles
            }
            const TimeUs missed = missed_at_;
            missed_at_ = 0;
            if (gpio_get_level(dout) == 0) {
                convert(missed != 0 ? missed : edge ? static_cast<TimeUs>(edge_at_) : now);
            }
            // Re-armed after the train: its own DOUT edges fell while the interrupt was off (a stale pending edge only
            // wakes the task to find DOUT high). The next conversion's falling edge may fall between the read of
            // DOUT high and the arming, and the interrupt would never see it: DOUT high before arming and low after
            // means exactly that, so the task wakes itself for it. (DOUT low all along, a part that does not
            // answer, is left to the kWaitMs poll: no busy loop.)
            const bool high_before = gpio_get_level(dout) != 0;
            gpio_intr_enable(dout);
            if (high_before && gpio_get_level(dout) == 0) {
                missed_at_ = esp_timer_get_time();
                xTaskNotifyGive(xTaskGetCurrentTaskHandle());
            }
            if (since_on_ == 0 && !logged_dead_ && now - on_at_ >= static_cast<TimeUs>(kDeadLogMs) * 1000) {
                logged_dead_ = true;
                ESP_LOGW(TAG, "no conversion %" PRIu32 " ms after power-up: DOUT GPIO%u never ready (wiring or power?)",
                         kDeadLogMs, static_cast<unsigned>(cfg_.dout));
            }
        }
        rate_.store(window_.tick(esp_timer_get_time()), std::memory_order_relaxed);
    }
}

void Hx711Gpio::convert(TimeUs at)
{
    const auto sck = static_cast<gpio_num_t>(cfg_.sck);
    const auto dout = static_cast<gpio_num_t>(cfg_.dout);
    const auto gain = static_cast<hal::LoadCellGain>(gain_);
    portENTER_CRITICAL(&s_train_mux);
    const uint32_t code = hx711::clock_train(gain, [&] {
        gpio_set_level(sck, 1);
        esp_rom_delay_us(kHalfPeriodUs);
        const bool bit = gpio_get_level(dout) != 0;
        gpio_set_level(sck, 0);
        esp_rom_delay_us(kHalfPeriodUs);
        return bit;
    });
    portEXIT_CRITICAL(&s_train_mux);
    // The 25th pulse pulls DOUT high until the next conversion: still low, the part did not answer (unpowered, or the
    // line held low), and the bits are not a conversion.
    if (gpio_get_level(dout) == 0) {
        bad_trains_.store(bad_trains_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
        if (!logged_low_) {
            logged_low_ = true;
            ESP_LOGW(TAG, "DOUT GPIO%u stays low after a read: the part does not answer (power?)",
                     static_cast<unsigned>(cfg_.dout));
        }
        return;
    }
    window_.count();
    ++since_on_;
    last_code_.store(code, std::memory_order_relaxed);
    last_ms_.store(now_ms(), std::memory_order_relaxed);
    conversions_.store(conversions_.load(std::memory_order_relaxed) + 1, std::memory_order_release);
    if (drop_ > 0) {
        --drop_;  // settling: counted for the rate, not handed over
        return;
    }
    (void)ring_.push({hx711::sign_extend24(code), at});  // a full ring counts the loss (overruns())
}

hal::Selftest Hx711Gpio::selftest()
{
    if (task_ == nullptr) {
        return {false, "not initialized"};
    }
    if (!want_on_.load(std::memory_order_acquire)) {
        return {false, "powered down (stopped)"};
    }
    // A conversion within 200 ms: the newest one is recent enough, else wait for the next.
    constexpr uint32_t kWithinMs = 200;
    const uint32_t before = conversions_.load(std::memory_order_acquire);
    const uint32_t t0 = now_ms();
    for (;;) {
        const uint32_t n = conversions_.load(std::memory_order_acquire);
        if (n != before || (n != 0 && now_ms() - last_ms_.load(std::memory_order_relaxed) <= kWithinMs)) {
            break;
        }
        if (now_ms() - t0 >= kWithinMs) {
            std::snprintf(detail_, sizeof(detail_), "no conversion in %" PRIu32 " ms: DOUT GPIO%u never ready (%" PRIu32
                          " trains without an answer)", kWithinMs, static_cast<unsigned>(cfg_.dout),
                          bad_trains_.load(std::memory_order_relaxed));
            return {false, detail_};
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    const uint32_t code = last_code_.load(std::memory_order_relaxed);
    if (hx711::at_limit(code)) {
        std::snprintf(detail_, sizeof(detail_), "raw stuck at 0x%06" PRIX32 " (saturated, or the bridge not wired)", code);
        return {false, detail_};
    }
    std::snprintf(detail_, sizeof(detail_), "raw %" PRId32 ", %u conversions/s, %" PRIu32 " since boot, %" PRIu32
                  " overruns", hx711::sign_extend24(code), static_cast<unsigned>(rate_hz()),
                  conversions_.load(std::memory_order_relaxed), overruns());
    return {true, detail_};
}

}  // namespace fr::drv
