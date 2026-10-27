// Spike S2's test hooks on target (design m2-c4-gateway D19): fr_diag's TestHooks over Net (the bench and the stream)
// and fr_net's ESP-NOW and Wi-Fi hooks, plus the `cpu` sampler over FreeRTOS run-time stats. core.cpp's DiagHost hands
// it out in FR_TEST_HOOKS builds. Core task.
#pragma once

#include "fr/diag.hpp"
#include "fr/net/net.hpp"

namespace fr::core {

/** The hooks over `net` (one object; the latest call's Net). */
diag::TestHooks &s2_hooks(net::Net &net);

}  // namespace fr::core
