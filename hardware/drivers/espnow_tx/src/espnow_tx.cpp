// espnow_tx (design csi-c1 D9): hal::RadioTx through fr_net's ESP-NOW scheduler (fr::net::esp::air_send_plain). The
// header says what runs where. The host suite builds this file unchanged against firmware/test/host/shim (esp_timer
// on the fake clock, fr_net's ESP-NOW calls faked).
#include "fr/drv/espnow_tx.hpp"

#include <algorithm>
#include <cstring>

#include "esp_log.h"
#include "esp_timer.h"
#include "fr/net/esp.hpp"

namespace fr::drv {
namespace {

constexpr const char *TAG = "espnow_tx";

void tick_timer(void *arg)
{
    static_cast<EspnowTx *>(arg)->on_tick_timer();
}

void sent_cb(void *ctx, uint32_t token, bool ok)
{
    static_cast<EspnowTx *>(ctx)->on_done(token, ok);
}

}  // namespace

Status EspnowTx::init(Core &core)
{
    core_ = &core;
    const esp_timer_create_args_t args = {
        .callback = tick_timer,
        .arg = this,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "fr_radio_tx",
        .skip_unhandled_events = true,
    };
    esp_timer_handle_t t = nullptr;
    if (esp_timer_create(&args, &t) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    timer_ = t;
    return {};
}

Status EspnowTx::start(const std::array<uint8_t, 6> &peer, uint16_t rate_hz, uint16_t len)
{
    if ((peer[0] & 0x01) != 0 || rate_hz == 0 || len < 4 || len > kMaxLen) {
        return std::unexpected(Err::invalid_args);
    }
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const net::esp::AirStatus air = net::esp::air_status();
    if (!air.up || air.channel == 0) {
        return std::unexpected(Err::busy);  // no channel to send on
    }
    static_cast<void>(stop());
    peer_ = peer;
    len_ = len;
    seq_ = 0;
    ++run_;
    std::memset(frame_, 0, sizeof(frame_));
    if (esp_timer_start_periodic(static_cast<esp_timer_handle_t>(timer_), 1'000'000u / rate_hz) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    running_ = true;
    ESP_LOGI(TAG, "sending %u B at %u Hz to %02x%02x%02x%02x%02x%02x on channel %u", static_cast<unsigned>(len),
             static_cast<unsigned>(rate_hz), peer[0], peer[1], peer[2], peer[3], peer[4], peer[5],
             static_cast<unsigned>(air.channel));
    return {};
}

Status EspnowTx::stop()
{
    if (running_) {
        esp_timer_stop(static_cast<esp_timer_handle_t>(timer_));
        running_ = false;
    }
    return {};
}

hal::Selftest EspnowTx::selftest()
{
    const net::esp::AirStatus air = net::esp::air_status();
    if (!air.started) {
        return {false, "espnow_tx: ESP-NOW not started"};
    }
    return {true, air.up ? "espnow_tx: ESP-NOW up" : "espnow_tx: ESP-NOW started, no channel yet"};
}

void EspnowTx::on_tick_timer()
{
    // esp_timer task: the send itself is the core task's (the scheduler lives there). Ticks coalesce while one waits.
    if (core_ == nullptr || tick_posted_.exchange(true, std::memory_order_acq_rel)) {
        return;
    }
    if (!core_->post([this] {
            tick_posted_.store(false, std::memory_order_release);
            tick();
        })) {
        tick_posted_.store(false, std::memory_order_release);
    }
}

void EspnowTx::tick()
{
    if (!running_) {
        return;
    }
    if (!net::esp::air_status().up) {
        ESP_LOGW(TAG, "ESP-NOW down (no channel): stopped");
        static_cast<void>(stop());
        return;
    }
    const uint32_t seq = seq_++;
    if (in_flight_) {
        ++failed_;  // the previous frame has not ended: this one is skipped, the rate stays
        return;
    }
    frame_[0] = static_cast<uint8_t>(seq);
    frame_[1] = static_cast<uint8_t>(seq >> 8);
    frame_[2] = static_cast<uint8_t>(seq >> 16);
    frame_[3] = static_cast<uint8_t>(seq >> 24);
    // The token: the run in the top byte, the sequence below, so an earlier run's late end is told apart.
    const uint32_t token = (run_ & 0xFF) << 24 | (seq & 0x00FF'FFFF);
    const Status st = net::esp::air_send_plain(peer_, {frame_, len_}, token, sent_cb, this);
    ++sent_;
    if (!st) {
        ++failed_;  // refused (queue full, no peer slot): counted, the next tick tries again
        return;
    }
    in_flight_ = true;
    in_flight_token_ = token;
}

void EspnowTx::on_done(uint32_t token, bool ok)
{
    // Core task (the scheduler's end): one plain frame is in the scheduler at a time, a stop() leaves it to end.
    if (!in_flight_ || token != in_flight_token_) {
        return;
    }
    in_flight_ = false;
    if (ok) {
        ++acked_;
    } else {
        ++failed_;
    }
}

}  // namespace fr::drv
