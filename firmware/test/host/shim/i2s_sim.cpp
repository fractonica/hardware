// The I2S shim (i2s_sim.hpp): channels in a table, configs kept, reads from fed frames, writes recorded.
#include "i2s_sim.hpp"

#include <algorithm>
#include <cstring>
#include <memory>

#include "driver/i2s_std.h"
#include "fr/platform/i2s_pair.hpp"

struct i2s_channel_obj_t {
    esp_sim::I2sChannel c;
    i2s_event_callbacks_t cbs{};
};

namespace esp_sim {
namespace {

std::vector<std::unique_ptr<i2s_channel_obj_t>> s_channels;
int s_new_calls = 0;

i2s_channel_obj_t *find(int port, bool tx)
{
    for (auto &ch : s_channels) {
        if (ch->c.port == port && ch->c.tx == tx) {
            return ch.get();
        }
    }
    return nullptr;
}

/** A duplex slave runs on its master's BCLK and WS: only while the master's channel is enabled. */
bool clocked(const I2sChannel &c)
{
    if (!c.duplex_slave) {
        return true;
    }
    const i2s_channel_obj_t *m = find(c.port, !c.tx);
    return m != nullptr && m->c.enabled;
}

}  // namespace

I2sChannel *i2s_channel(int port, bool tx)
{
    i2s_channel_obj_t *o = find(port, tx);
    return o != nullptr ? &o->c : nullptr;
}

int i2s_new_calls()
{
    return s_new_calls;
}

void i2s_feed(int port, std::span<const int32_t> frames)
{
    if (I2sChannel *c = i2s_channel(port, false)) {
        c->rx.insert(c->rx.end(), frames.begin(), frames.end());
    }
}

void i2s_isr_event(int port, bool tx)
{
    i2s_channel_obj_t *o = find(port, tx);
    if (o == nullptr) {
        return;
    }
    i2s_isr_callback_t cb = tx ? o->cbs.on_send_q_ovf : o->cbs.on_recv_q_ovf;
    if (cb != nullptr) {
        i2s_event_data_t ev{};
        cb(o, &ev, o->c.cb_ctx);
    }
}

void i2s_reset()
{
    s_channels.clear();
    s_new_calls = 0;
    fr::platform::i2s::pairs() = {};
}

}  // namespace esp_sim

using esp_sim::I2sChannel;

esp_err_t i2s_new_channel(const i2s_chan_config_t *chan_cfg, i2s_chan_handle_t *ret_tx_handle, i2s_chan_handle_t *ret_rx_handle)
{
    // I2S_NUM_AUTO is not taken: codegen resolves every port.
    if (chan_cfg == nullptr || (ret_tx_handle == nullptr && ret_rx_handle == nullptr) || chan_cfg->id < I2S_NUM_0 ||
        chan_cfg->id > I2S_NUM_1) {
        return ESP_ERR_INVALID_ARG;
    }
    const int port = static_cast<int>(chan_cfg->id);
    if ((ret_tx_handle != nullptr && esp_sim::find(port, true) != nullptr) ||
        (ret_rx_handle != nullptr && esp_sim::find(port, false) != nullptr)) {
        return ESP_ERR_NOT_FOUND;  // the controller's direction is taken
    }
    auto make = [&](bool tx) {
        auto o = std::make_unique<i2s_channel_obj_t>();
        o->c.port = port;
        o->c.tx = tx;
        o->c.master = chan_cfg->role == I2S_ROLE_MASTER;
        o->c.dma_desc = chan_cfg->dma_desc_num;
        o->c.dma_frames = chan_cfg->dma_frame_num;
        o->c.auto_clear = chan_cfg->auto_clear_after_cb;
        o->c.duplex = ret_tx_handle != nullptr && ret_rx_handle != nullptr;
        esp_sim::s_channels.push_back(std::move(o));
        return esp_sim::s_channels.back().get();
    };
    if (ret_tx_handle != nullptr) {
        *ret_tx_handle = make(true);
    }
    if (ret_rx_handle != nullptr) {
        *ret_rx_handle = make(false);
    }
    ++esp_sim::s_new_calls;
    return ESP_OK;
}

esp_err_t i2s_del_channel(i2s_chan_handle_t handle)
{
    auto &v = esp_sim::s_channels;
    const auto it = std::find_if(v.begin(), v.end(), [handle](const auto &o) { return o.get() == handle; });
    if (it == v.end()) {
        return ESP_ERR_INVALID_ARG;
    }
    v.erase(it);
    return ESP_OK;
}

esp_err_t i2s_channel_init_std_mode(i2s_chan_handle_t handle, const i2s_std_config_t *std_cfg)
{
    if (handle == nullptr || std_cfg == nullptr || handle->c.enabled) {
        return ESP_ERR_INVALID_ARG;
    }
    const i2s_std_slot_config_t &sl = std_cfg->slot_cfg;
    const i2s_std_gpio_config_t &g = std_cfg->gpio_cfg;
    I2sChannel &c = handle->c;
    c.data_bits = sl.data_bit_width;
    c.slot_bits = sl.slot_bit_width;
    c.slot_mode = sl.slot_mode;
    c.slot_mask = sl.slot_mask;
    c.bit_shift = sl.bit_shift;
    c.ws_width = sl.ws_width;
    c.mclk_multiple = std_cfg->clk_cfg.mclk_multiple;
    c.bclk = g.bclk;
    c.ws = g.ws;
    c.dout = g.dout;
    c.din = g.din;
    c.clock_hz = std_cfg->clk_cfg.sample_rate_hz;
    // IDF's i2s_channel_try_to_constitute_duplex: the later of two master halves becomes the internal slave.
    if (c.duplex && c.master) {
        if (const i2s_channel_obj_t *other = esp_sim::find(c.port, !c.tx); other != nullptr && other->c.inited) {
            c.master = false;
            c.duplex_slave = true;
        }
    }
    handle->c.inited = true;
    return ESP_OK;
}

esp_err_t i2s_channel_reconfig_std_clock(i2s_chan_handle_t handle, const i2s_std_clk_config_t *clk_cfg)
{
    if (handle == nullptr || clk_cfg == nullptr || !handle->c.inited) {
        return ESP_ERR_INVALID_ARG;
    }
    if (handle->c.enabled) {
        return ESP_ERR_INVALID_STATE;  // IDF: only a disabled channel takes a new clock
    }
    handle->c.clock_hz = clk_cfg->sample_rate_hz;
    handle->c.mclk_multiple = clk_cfg->mclk_multiple;
    return ESP_OK;
}

esp_err_t i2s_channel_enable(i2s_chan_handle_t handle)
{
    if (handle == nullptr || !handle->c.inited || handle->c.enabled) {
        return ESP_ERR_INVALID_STATE;
    }
    handle->c.enabled = true;
    ++handle->c.enables;
    return ESP_OK;
}

esp_err_t i2s_channel_disable(i2s_chan_handle_t handle)
{
    if (handle == nullptr || !handle->c.enabled) {
        return ESP_ERR_INVALID_STATE;
    }
    handle->c.enabled = false;
    return ESP_OK;
}

esp_err_t i2s_channel_read(i2s_chan_handle_t handle, void *dest, size_t size, size_t *bytes_read, uint32_t)
{
    *bytes_read = 0;
    if (handle == nullptr || handle->c.tx || !handle->c.enabled) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!esp_sim::clocked(handle->c)) {
        return ESP_ERR_TIMEOUT;  // no BCLK: the DMA fills nothing
    }
    std::vector<int32_t> &rx = handle->c.rx;
    const size_t n = std::min(size / sizeof(int32_t), rx.size());
    if (n > 0) {
        std::memcpy(dest, rx.data(), n * sizeof(int32_t));
        rx.erase(rx.begin(), rx.begin() + static_cast<long>(n));
    }
    *bytes_read = n * sizeof(int32_t);
    return *bytes_read == size ? ESP_OK : ESP_ERR_TIMEOUT;
}

esp_err_t i2s_channel_write(i2s_chan_handle_t handle, const void *src, size_t size, size_t *bytes_written, uint32_t)
{
    *bytes_written = 0;
    if (handle == nullptr || !handle->c.tx || !handle->c.enabled) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!esp_sim::clocked(handle->c)) {
        return ESP_ERR_TIMEOUT;  // no BCLK: the DMA takes nothing
    }
    const size_t n = size / sizeof(int16_t);
    const auto *p = static_cast<const int16_t *>(src);
    handle->c.written.insert(handle->c.written.end(), p, p + n);
    *bytes_written = n * sizeof(int16_t);
    return ESP_OK;
}

esp_err_t i2s_channel_register_event_callback(i2s_chan_handle_t handle, const i2s_event_callbacks_t *callbacks, void *user_data)
{
    if (handle == nullptr || callbacks == nullptr || handle->c.enabled) {
        return ESP_ERR_INVALID_STATE;
    }
    handle->cbs = *callbacks;
    handle->c.cbs = &handle->cbs;
    handle->c.cb_ctx = user_data;
    return ESP_OK;
}
