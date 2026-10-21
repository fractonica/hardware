// fr:realtime
// The only fr_core code an ISR runs. linker.lf maps this object `noflash`: the function goes to IRAM
// and its rodata (EspInputSlot's vtable, emitted here with its key function) to DRAM, so a driver ISR
// registered with ESP_INTR_FLAG_IRAM can call it while flash is busy (spec 03 §3.4).
#include "esp_attr.h"
#include "esp_core.hpp"

namespace fr {

IRAM_ATTR void EspInputSlot::update_from_isr(bool level, TimeUs at)
{
    portENTER_CRITICAL_SAFE(&mux_);
    level_ = level;
    at_ = at;
    ++edges_;
    pending_ = true;
    portEXIT_CRITICAL_SAFE(&mux_);

    TaskHandle_t t = *task;
    if (t == nullptr) {
        return;  // before run(): the core task services the slot when it starts
    }
    if (xPortInIsrContext()) {
        BaseType_t woken = pdFALSE;
        xTaskNotifyFromISR(t, kBitInput, eSetBits, &woken);
        portYIELD_FROM_ISR(woken);
    } else {
        // Polled drivers (an esp_timer callback, say) call it from a task.
        xTaskNotify(t, kBitInput, eSetBits);
    }
}

}  // namespace fr
