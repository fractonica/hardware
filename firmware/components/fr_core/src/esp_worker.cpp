// fr_worker (spec 03 §3.4, design c4 §3): one FreeRTOS task draining a bounded FIFO of jobs. The queue is
// the core task's PostQueue (esp_core.hpp), so posting never allocates and never blocks: a full queue
// refuses the job. The task sleeps on a task notification between jobs; a job may block (socket reads,
// flash erases) for as long as it needs, since nothing realtime waits on this task.
#include "esp_worker.hpp"

#include <utility>

#include "esp_core.hpp"  // PostQueue
#include "esp_log.h"
#include "fr/core/worker.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace fr {
namespace {

constexpr const char *TAG = "fr_worker";

class EspWorker final : public Worker
{
public:
    bool start()
    {
        if (task_ != nullptr) {
            return true;
        }
        // No core affinity: on the S3 the core task owns core 1, and the download is network-bound.
        TaskHandle_t t = nullptr;
        if (xTaskCreate(&EspWorker::task_main, "fr_worker", worker::kStackBytes, this, worker::kPriority, &t) != pdPASS) {
            ESP_LOGE(TAG, "cannot create the worker task");
            return false;
        }
        portENTER_CRITICAL(&mux_);
        task_ = t;
        portEXIT_CRITICAL(&mux_);
        // Jobs posted before the task existed found no one to notify.
        xTaskNotifyGive(t);
        return true;
    }

    bool post(Callback<void(), 32> job) override
    {
        if (!jobs_.push(std::move(job), mux_)) {
            return false;  // counted by the queue
        }
        portENTER_CRITICAL_SAFE(&mux_);
        TaskHandle_t t = task_;
        portEXIT_CRITICAL_SAFE(&mux_);
        if (t != nullptr) {
            xTaskNotifyGive(t);  // a counting notification: a job pushed while the task runs is never missed
        }
        return true;
    }

    uint32_t dropped() const { return jobs_.dropped(); }

private:
    static void task_main(void *arg) { static_cast<EspWorker *>(arg)->loop(); }

    [[noreturn]] void loop()
    {
        for (;;) {
            Callback<void(), 32> job;
            if (jobs_.pop(job, mux_)) {
                job();
                continue;
            }
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        }
    }

    TaskHandle_t task_ = nullptr;
    portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
    PostQueue<worker::kQueueDepth> jobs_;
};

EspWorker s_worker;

}  // namespace

namespace worker {

bool start()
{
    return s_worker.start();
}

uint32_t dropped()
{
    return s_worker.dropped();
}

Worker &get()
{
    return s_worker;
}

bool post(Callback<void(), 32> job)
{
    return s_worker.post(std::move(job));
}

}  // namespace worker
}  // namespace fr
