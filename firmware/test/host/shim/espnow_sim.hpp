// The host suite's fr_net ESP-NOW fake for espnow_tx (design csi-c1 D9): fr::net::esp::air_status() and air_send_plain()
// as fr_net/src/esp/espnow.cpp answers them, the scheduler's one frame in flight left to the test: each accepted frame
// is recorded and ends when the test says (end_frame), through the driver's done callback, as service() would.
#pragma once

#include <array>
#include <cstdint>
#include <vector>

namespace esp_sim {

struct PlainFrame {
    std::array<uint8_t, 6> dst{};
    std::vector<uint8_t> bytes;
    uint32_t token = 0;
    int64_t at = 0;  // esp_timer_get_time()
};

struct AirSim {
    bool started = true;
    bool up = true;
    uint8_t channel = 36;
    int refuse = 0;  // the next n sends are refused (busy)
    std::vector<PlainFrame> frames;  // accepted, in order
    void (*done)(void *, uint32_t, bool) = nullptr;
    void *ctx = nullptr;
};

AirSim &air();
void air_reset();
/** Ends accepted frame `i` (MAC-ACKed or not) through the driver's callback. */
void end_frame(size_t i, bool ok);

}  // namespace esp_sim
