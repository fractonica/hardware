// fr_worker on FreeRTOS (spec 03 §3.4): what fr_core needs beyond fr/core/worker.hpp. Private to fr_core.
#pragma once

#include <cstdint>

namespace fr::worker {

/** Creates the fr_worker task; jobs posted earlier run first. False if FreeRTOS cannot create it. */
bool start();
/** Jobs refused because the queue was full, since boot. */
uint32_t dropped();

}  // namespace fr::worker
