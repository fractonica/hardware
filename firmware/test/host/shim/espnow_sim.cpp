// fr_net's ESP-NOW calls for espnow_tx on the host (shim/espnow_sim.hpp).
#include "espnow_sim.hpp"

#include <algorithm>

#include "esp_timer.h"
#include "fr/net/esp.hpp"

namespace esp_sim {

AirSim &air()
{
    static AirSim a;
    return a;
}

void air_reset()
{
    air() = AirSim{};
}

void end_frame(size_t i, bool ok)
{
    AirSim &a = air();
    if (i < a.frames.size() && a.done != nullptr) {
        a.done(a.ctx, a.frames[i].token, ok);
    }
}

}  // namespace esp_sim

namespace fr::net::esp {

AirStatus air_status()
{
    AirStatus s;
    s.started = esp_sim::air().started;
    s.up = esp_sim::air().up;
    s.channel = esp_sim::air().channel;
    return s;
}

fr::Status air_send_plain(const Mac &dst, std::span<const uint8_t> bytes, uint32_t token, PlainDone done, void *ctx)
{
    esp_sim::AirSim &a = esp_sim::air();
    if (!a.up) {
        return std::unexpected(Err::failed);
    }
    if ((dst[0] & 0x01) != 0 || bytes.empty() || bytes.size() > 250) {
        return std::unexpected(Err::invalid_args);
    }
    if (a.refuse > 0) {
        --a.refuse;
        return std::unexpected(Err::busy);
    }
    a.done = done;
    a.ctx = ctx;
    a.frames.push_back({.dst = dst, .bytes = {bytes.begin(), bytes.end()}, .token = token, .at = esp_timer_get_time()});
    return {};
}

}  // namespace fr::net::esp
