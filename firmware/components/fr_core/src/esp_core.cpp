// fr:realtime
#include "esp_core.hpp"

#include <cinttypes>
#include <cstdint>
#include <utility>

#include "esp_log.h"
#include "sdkconfig.h"

namespace fr {
namespace {

constexpr const char *TAG = "fr_core";

}  // namespace

// ---- input slots ----

bool EspInputSlot::take(InputSample &out)
{
    bool had = false;
    portENTER_CRITICAL(&mux_);
    if (pending_) {
        out = {.level = level_, .at = at_, .edges = edges_};
        edges_ = 0;
        pending_ = false;
        had = true;
    }
    portEXIT_CRITICAL(&mux_);
    return had;
}

// ---- timers ----

void EspTimer::start(uint32_t delay_us)
{
    deadline_ = esp_timer_get_time() + delay_us;
    order_ = ++core_->order_;
    running_ = true;
    core_->rearm();
}

// ---- core ----

bool EspCore::begin()
{
    const esp_timer_create_args_t args = {
        .callback = &EspCore::on_alarm,
        .arg = this,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "fr_core",
        .skip_unhandled_events = false,
    };
    esp_err_t err = esp_timer_create(&args, &alarm_);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_timer_create: %s", esp_err_to_name(err));
        return false;
    }
    return true;
}

bool EspCore::run()
{
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1
    // S3: the core task owns core 1; Wi-Fi stays on core 0 (spec 03 §3.4).
    BaseType_t r = xTaskCreatePinnedToCore(&EspCore::task_main, "fr_core", kStack, this, kPriority, &task_, 1);
#else
    BaseType_t r = xTaskCreate(&EspCore::task_main, "fr_core", kStack, this, kPriority, &task_);
#endif
    if (r != pdPASS) {
        ESP_LOGE(TAG, "cannot create the core task");
        return false;
    }
    return true;
}

Timer *EspCore::timer(Callback<void(), 24> on_fire)
{
    EspTimer *t = nullptr;
    portENTER_CRITICAL(&pool_mux_);
    if (timers_used_ < kTimers) {
        t = &timers_[timers_used_++];
    }
    portEXIT_CRITICAL(&pool_mux_);
    if (t == nullptr) {
        ESP_LOGE(TAG, "timer pool exhausted (%u)", static_cast<unsigned>(kTimers));
        return nullptr;
    }
    t->core_ = this;
    t->on_fire_ = std::move(on_fire);
    return t;
}

InputSlot *EspCore::input_slot(Callback<void(const InputSample &), 24> on_change)
{
    EspInputSlot *s = nullptr;
    portENTER_CRITICAL(&pool_mux_);
    if (slots_used_ < kSlots) {
        s = &slots_[slots_used_];
        s->on_change = std::move(on_change);
        s->task = &task_;
        // Published only now: the core task never sees a half-built slot.
        ++slots_used_;
    }
    portEXIT_CRITICAL(&pool_mux_);
    if (s == nullptr) {
        ESP_LOGE(TAG, "input slot pool exhausted (%u)", static_cast<unsigned>(kSlots));
    }
    return s;
}

bool EspCore::post(Callback<void(), 32> fn)
{
    bool ok = posts_.push(std::move(fn), pool_mux_);
    if (ok) {
        notify(kBitPost);
    }
    return ok;
}

bool EspCore::post_net(Callback<void(), 32> fn)
{
    bool ok = net_posts_.push(std::move(fn), pool_mux_);
    if (ok) {
        notify(kBitPost);
    }
    return ok;
}

template <size_t N>
bool EspCore::run_one(PostQueue<N> &q)
{
    Callback<void(), 32> fn;
    bool have = q.pop(fn, pool_mux_);
    if (have) {
        fn();
    }
    return have;
}

void EspCore::task_main(void *arg)
{
    static_cast<EspCore *>(arg)->loop();
}

void EspCore::on_alarm(void *arg)
{
    // esp_timer task: only wake the core task, which decides what is due.
    static_cast<EspCore *>(arg)->notify(kBitTimer);
}

void EspCore::notify(uint32_t bits)
{
    if (task_ != nullptr) {
        xTaskNotify(task_, bits, eSetBits);
    }
}

void EspCore::loop()
{
    for (;;) {
        // Inputs before timers before posted work (spec 03 §3.4); one post and one received envelope per
        // round, so a burst of either never delays an edge or a due timer by more than one handler.
        bool busy = service_inputs();
        busy = service_timers() || busy;
        busy = run_one(posts_) || busy;
        busy = run_one(net_posts_) || busy;
        if (!busy) {
            xTaskNotifyWait(0, UINT32_MAX, nullptr, portMAX_DELAY);
        }
    }
}

bool EspCore::service_inputs()
{
    bool any = false;
    size_t n = slots_used_;
    for (size_t i = 0; i < n; ++i) {
        InputSample s;
        if (slots_[i].take(s)) {
            ESP_LOGD(TAG, "input %u: level=%d edges=%" PRIu32 " at=%" PRId64, static_cast<unsigned>(i), s.level,
                     s.edges, s.at);
            slots_[i].on_change(s);
            any = true;
        }
    }
    return any;
}

bool EspCore::service_timers()
{
    // Only timers started before this pass are eligible: a callback that restarts its own timer with a
    // zero delay waits for the next round instead of spinning here.
    const uint32_t pass = order_;
    const TimeUs now = esp_timer_get_time();
    bool any = false;
    for (;;) {
        EspTimer *due = nullptr;
        for (size_t i = 0; i < timers_used_; ++i) {
            EspTimer &t = timers_[i];
            if (t.running_ && t.deadline_ <= now && static_cast<int32_t>(pass - t.order_) >= 0 &&
                (due == nullptr || t.deadline_ < due->deadline_ ||
                 (t.deadline_ == due->deadline_ && static_cast<int32_t>(t.order_ - due->order_) < 0))) {
                due = &t;
            }
        }
        if (due == nullptr) {
            break;
        }
        due->running_ = false;
        due->on_fire_();
        any = true;
    }
    if (armed_at_ != 0 && armed_at_ <= now) {
        armed_at_ = 0;  // that alarm has fired (or is about to; a late one only costs an empty pass)
    }
    rearm();
    return any;
}

void EspCore::rearm()
{
    TimeUs earliest = 0;
    for (size_t i = 0; i < timers_used_; ++i) {
        const EspTimer &t = timers_[i];
        if (t.running_ && (earliest == 0 || t.deadline_ < earliest)) {
            earliest = t.deadline_;
        }
    }
    if (earliest == 0 || (armed_at_ != 0 && armed_at_ <= earliest)) {
        return;  // nothing to wait for, or the alarm in flight comes first
    }
    TimeUs now = esp_timer_get_time();
    if (earliest <= now) {
        notify(kBitTimer);
        return;
    }
    esp_timer_stop(alarm_);  // ESP_ERR_INVALID_STATE when idle: fine
    esp_err_t err = esp_timer_start_once(alarm_, static_cast<uint64_t>(earliest - now));
    if (err != ESP_OK) {
        // Not expected; without the alarm the timer would only fire on the next unrelated wake-up.
        ESP_LOGE(TAG, "esp_timer_start_once: %s", esp_err_to_name(err));
        notify(kBitTimer);
        return;
    }
    armed_at_ = earliest;
}

}  // namespace fr
