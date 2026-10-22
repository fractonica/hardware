// What the Wi-Fi STA (wifi_sta.cpp, fr_net task) and the ESP-NOW driver (espnow.cpp) tell each other
// (design c5 §3, spec 05 §5.3-5.4): the STA knows channel C, which ESP-NOW's receive filter and
// AirLink::up() follow; the driver knows when a neighbour was last heard, and when one last reported Wi-Fi
// up, which decide the STA's all-channel sweep (a sweep takes the radio off C, and ESP-NOW with it; see
// sta_rules.hpp). Private to fr_net/src/esp.
#pragma once

#include <cstdint>

#include "fr/base.hpp"

namespace fr::net::esp::detail {

/** A time on the esp_timer clock as the stamps below hold it: uptime seconds, plus one; 0 (never) stays 0. */
inline uint32_t stamp_s(TimeUs at)
{
    return at > 0 ? static_cast<uint32_t>(at / 1'000'000) + 1 : 0;
}

/** fr_net task: channel C changed (0: unknown, e.g. no pin before the first association). */
void air_set_channel(uint8_t channel);

/** Any task: stamp_s of when a frame last passed ESP-NOW's receive filter; 0: never. */
uint32_t air_last_heard_s();

/** Any task: stamp_s of when a neighbour's ESP-NOW heartbeat last reported Wi-Fi up (Net's
 * wifi_up_neighbor_heard_at, refreshed after each received batch); 0: never. */
uint32_t air_wifi_up_heard_s();

}  // namespace fr::net::esp::detail
