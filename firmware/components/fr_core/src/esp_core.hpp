// EspCore: fr::Core on FreeRTOS + esp_timer (spec 03 §3.4, design c2 §5). Private to fr_core.
#pragma once

#include <cstddef>
#include <cstdint>
#include <utility>

#include "esp_timer.h"
#include "fr/core/core.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

namespace fr {

class EspCore;

// Task-notification bits of the core task.
inline constexpr uint32_t kBitInput = 1u << 0;
inline constexpr uint32_t kBitTimer = 1u << 1;
inline constexpr uint32_t kBitPost = 1u << 2;

/**
 * One input pin. update_from_isr() and this class's vtable live in IRAM/DRAM (input_slot_isr.cpp,
 * linker.lf), because the driver's ISR calls it through InputSlot* even while flash is busy.
 */
class EspInputSlot final : public InputSlot
{
public:
    void update_from_isr(bool level, TimeUs at) override;
    /** Core task: moves a pending sample out; false when nothing changed. */
    bool take(InputSample &out);

    Callback<void(const InputSample &), 24> on_change;
    TaskHandle_t *task = nullptr;  // EspCore's handle: null until run() starts the core task

private:
    portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
    bool pending_ = false;
    bool level_ = false;
    TimeUs at_ = 0;
    uint32_t edges_ = 0;
};

/**
 * Logical one-shot timers multiplexed on a single esp_timer: the core task owns every deadline, and
 * the esp_timer only wakes it. A stale alarm (a timer stopped or restarted after it was armed) costs
 * one empty pass, so stop/restart never races a callback in flight, on one core or two.
 */
class EspTimer final : public Timer
{
public:
    void start(uint32_t delay_us) override;
    void stop() override { running_ = false; }
    bool running() const override { return running_; }

private:
    friend class EspCore;

    EspCore *core_ = nullptr;
    Callback<void(), 24> on_fire_;
    TimeUs deadline_ = 0;
    uint32_t order_ = 0;  // start order; breaks deadline ties and bounds one pass
    bool running_ = false;
};

/** A bounded FIFO of posted functions, filled from any task and drained by the core task. */
template <size_t N>
class PostQueue
{
public:
    bool push(Callback<void(), 32> &&fn, portMUX_TYPE &mux)
    {
        bool ok = false;
        portENTER_CRITICAL_SAFE(&mux);
        if (len_ < N) {
            fns_[(head_ + len_) % N] = std::move(fn);
            ++len_;
            ok = true;
        } else {
            ++dropped_;
        }
        portEXIT_CRITICAL_SAFE(&mux);
        return ok;
    }
    bool pop(Callback<void(), 32> &out, portMUX_TYPE &mux)
    {
        portENTER_CRITICAL_SAFE(&mux);
        bool have = len_ > 0;
        if (have) {
            out = std::move(fns_[head_]);
            fns_[head_].reset();
            head_ = (head_ + 1) % N;
            --len_;
        }
        portEXIT_CRITICAL_SAFE(&mux);
        return have;
    }
    uint32_t dropped() const { return dropped_; }
    void reset_dropped() { dropped_ = 0; }

private:
    Callback<void(), 32> fns_[N];
    size_t head_ = 0;
    size_t len_ = 0;
    uint32_t dropped_ = 0;
};

class EspCore final : public Core
{
public:
    /**
     * 23 for the board's services (fr gen firmware's budget, spec 03 §3.4) plus the runtime's own, taken
     * in start() before the board: fr_core's two (reboot, serial link poll), Net's one and Ota's one (its
     * health deadline and 1 s tick, design c4 §3), and one spare.
     */
    static constexpr size_t kTimers = 28;
    static constexpr size_t kSlots = 8;
    static constexpr size_t kPosts = 16;
    /** Received envelopes (spec 03 §3.4: a separate network queue, depth 32). */
    static constexpr size_t kNetPosts = 32;
    static constexpr UBaseType_t kPriority = 10;
    // fr.diag.exec over TCP or serial dispatches with a bulk Reply (1445 B) on this stack, under Net's own
    // frames and cJSON's recursion. 8192 by default; fr gen raises it for profiles with a panel
    // (CONFIG_FR_CORE_TASK_STACK, design m2-c5-display D3): fr.display ui_load decodes a 24-widget layout on this
    // stack, in nested copies.
    static constexpr uint32_t kStack = CONFIG_FR_CORE_TASK_STACK;

    /** Creates the wake-up esp_timer; timers may be started from then on (they fire once run() runs). */
    bool begin();
    /** Starts the core task. Everything posted, armed or sampled before runs first. */
    bool run();

    TimeUs now() const override { return esp_timer_get_time(); }
    Timer *timer(Callback<void(), 24> on_fire) override;
    InputSlot *input_slot(Callback<void(const InputSample &), 24> on_change) override;
    bool post(Callback<void(), 32> fn) override;
    /**
     * Like post(), for received envelopes: its own queue, serviced after inputs, timers and one post per
     * round, so a burst from the network can neither starve nor be starved by other posted work.
     */
    bool post_net(Callback<void(), 32> fn);

    uint32_t posts_dropped() const { return posts_.dropped() + net_posts_.dropped(); }
    void reset_posts_dropped()
    {
        posts_.reset_dropped();
        net_posts_.reset_dropped();
    }

private:
    friend class EspTimer;

    static void task_main(void *arg);
    static void on_alarm(void *arg);
    void loop();
    bool service_inputs();
    bool service_timers();
    template <size_t N>
    bool run_one(PostQueue<N> &q);
    void rearm();
    void notify(uint32_t bits);

    TaskHandle_t task_ = nullptr;
    esp_timer_handle_t alarm_ = nullptr;
    TimeUs armed_at_ = 0;  // deadline the esp_timer is set for; 0 when none
    uint32_t order_ = 0;

    portMUX_TYPE pool_mux_ = portMUX_INITIALIZER_UNLOCKED;
    EspTimer timers_[kTimers];
    size_t timers_used_ = 0;
    EspInputSlot slots_[kSlots];
    size_t slots_used_ = 0;

    PostQueue<kPosts> posts_;
    PostQueue<kNetPosts> net_posts_;
};

}  // namespace fr
