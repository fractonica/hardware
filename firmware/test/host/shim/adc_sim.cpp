// The ADC continuous-mode shim (adc_sim.hpp): handles in a table, configs kept, conversions into frames and a pool, and
// IDF v6.1's GPIO map and result parsing as on the ESP32-S3 (ADC1 channels 0-9 on GPIO1-10, ADC2 on GPIO11-20).
#include "adc_sim.hpp"

#include <algorithm>
#include <cstring>
#include <memory>

#include "esp_adc/adc_continuous.h"

struct adc_continuous_ctx_t {
    esp_sim::AdcHandle h;
    adc_continuous_evt_cbs_t cbs{};
    void *user = nullptr;
};

namespace esp_sim {
namespace {

std::vector<std::unique_ptr<adc_continuous_ctx_t>> s_handles;
int s_new_calls = 0;
uint32_t s_read_cap = 0;
std::vector<uint16_t> s_on_start;

}  // namespace

AdcHandle *adc_handle()
{
    return s_handles.empty() ? nullptr : &s_handles.back()->h;
}

int adc_new_calls()
{
    return s_new_calls;
}

void adc_convert(std::span<const uint16_t> raw, unsigned channel, unsigned unit)
{
    if (s_handles.empty()) {
        return;
    }
    adc_continuous_ctx_t &c = *s_handles.back();
    if (!c.h.started) {
        return;
    }
    for (uint16_t code : raw) {
        adc_digi_output_data_t d{};
        d.type2.data = code & 0xFFF;
        d.type2.channel = channel & 0xF;
        d.type2.unit = unit & 1;
        const auto *b = reinterpret_cast<const uint8_t *>(&d.val);
        c.h.frame.insert(c.h.frame.end(), b, b + sizeof(d.val));
        if (c.h.frame.size() < c.h.frame_bytes) {
            continue;
        }
        if (c.h.pool.size() + c.h.frame.size() <= c.h.pool_bytes) {
            c.h.pool.insert(c.h.pool.end(), c.h.frame.begin(), c.h.frame.end());
        } else {
            ++c.h.overflows;
            if (c.cbs.on_pool_ovf != nullptr) {
                adc_continuous_evt_data_t ev{};
                c.cbs.on_pool_ovf(&c, &ev, c.user);
            }
        }
        c.h.frame.clear();
    }
}

void adc_set_on_start(std::vector<uint16_t> raw)
{
    s_on_start = std::move(raw);
}

void adc_set_read_cap(uint32_t bytes)
{
    s_read_cap = bytes;
}

void adc_reset()
{
    s_handles.clear();
    s_new_calls = 0;
    s_read_cap = 0;
    s_on_start.clear();
}

}  // namespace esp_sim

esp_err_t adc_continuous_new_handle(const adc_continuous_handle_cfg_t *hdl_config, adc_continuous_handle_t *ret_handle)
{
    if (hdl_config == nullptr || ret_handle == nullptr || hdl_config->conv_frame_size % SOC_ADC_DIGI_DATA_BYTES_PER_CONV != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    auto c = std::make_unique<adc_continuous_ctx_t>();
    c->h.pool_bytes = hdl_config->max_store_buf_size;
    c->h.frame_bytes = hdl_config->conv_frame_size;
    c->h.flush_pool = hdl_config->flags.flush_pool != 0;
    *ret_handle = c.get();
    esp_sim::s_handles.push_back(std::move(c));
    ++esp_sim::s_new_calls;
    return ESP_OK;
}

esp_err_t adc_continuous_config(adc_continuous_handle_t handle, const adc_continuous_config_t *config)
{
    if (handle == nullptr || handle->h.started) {
        return ESP_ERR_INVALID_STATE;
    }
    if (config->pattern_num > SOC_ADC_PATT_LEN_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    for (uint32_t i = 0; i < config->pattern_num; ++i) {
        const adc_digi_pattern_config_t &p = config->adc_pattern[i];
        if (p.bit_width < SOC_ADC_DIGI_MIN_BITWIDTH || p.bit_width > SOC_ADC_DIGI_MAX_BITWIDTH ||
            !SOC_ADC_DIG_SUPPORTED_UNIT(p.unit) || p.atten >= SOC_ADC_ATTEN_NUM) {
            return ESP_ERR_INVALID_ARG;
        }
    }
    if (config->sample_freq_hz > SOC_ADC_SAMPLE_FREQ_THRES_HIGH || config->sample_freq_hz < SOC_ADC_SAMPLE_FREQ_THRES_LOW) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_sim::AdcHandle &h = handle->h;
    h.pattern_num = config->pattern_num;
    if (config->pattern_num > 0) {
        h.atten = config->adc_pattern[0].atten;
        h.channel = config->adc_pattern[0].channel;
        h.unit = config->adc_pattern[0].unit;
        h.bit_width = config->adc_pattern[0].bit_width;
    }
    h.sample_freq_hz = config->sample_freq_hz;
    h.conv_mode = config->conv_mode;
    ++h.configs;
    return ESP_OK;
}

esp_err_t adc_continuous_register_event_callbacks(adc_continuous_handle_t handle, const adc_continuous_evt_cbs_t *cbs, void *user_data)
{
    if (handle == nullptr || cbs == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (handle->h.started) {
        return ESP_ERR_INVALID_STATE;
    }
    handle->cbs = *cbs;
    handle->user = user_data;
    return ESP_OK;
}

esp_err_t adc_continuous_start(adc_continuous_handle_t handle)
{
    if (handle == nullptr || handle->h.started) {
        return ESP_ERR_INVALID_STATE;
    }
    handle->h.started = true;
    handle->h.frame.clear();
    ++handle->h.starts;
    if (!esp_sim::s_on_start.empty()) {
        esp_sim::adc_convert(esp_sim::s_on_start, static_cast<unsigned>(std::max(handle->h.channel, 0)));
    }
    return ESP_OK;
}

esp_err_t adc_continuous_read(adc_continuous_handle_t handle, uint8_t *buf, uint32_t length_max, uint32_t *out_length, uint32_t timeout_ms)
{
    if (handle == nullptr || !handle->h.started) {
        return ESP_ERR_INVALID_STATE;
    }
    esp_sim::AdcHandle &h = handle->h;
    ++h.reads;
    h.last_read_max = length_max;
    h.last_timeout_ms = timeout_ms;
    size_t n = std::min<size_t>(length_max, h.pool.size());
    if (esp_sim::s_read_cap != 0) {
        n = std::min<size_t>(n, esp_sim::s_read_cap);
    }
    if (n == 0) {
        *out_length = 0;
        return ESP_ERR_TIMEOUT;
    }
    std::memcpy(buf, h.pool.data(), n);
    h.pool.erase(h.pool.begin(), h.pool.begin() + static_cast<long>(n));
    *out_length = static_cast<uint32_t>(n);
    return ESP_OK;
}

esp_err_t adc_continuous_stop(adc_continuous_handle_t handle)
{
    if (handle == nullptr || !handle->h.started) {
        return ESP_ERR_INVALID_STATE;
    }
    handle->h.started = false;
    ++handle->h.stops;
    return ESP_OK;
}

esp_err_t adc_continuous_deinit(adc_continuous_handle_t handle)
{
    if (handle == nullptr || handle->h.started) {
        return ESP_ERR_INVALID_STATE;
    }
    handle->h.deinited = true;
    return ESP_OK;
}

esp_err_t adc_continuous_flush_pool(adc_continuous_handle_t handle)
{
    if (handle == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (handle->h.started) {
        return ESP_ERR_INVALID_STATE;
    }
    handle->h.pool.clear();
    ++handle->h.flushes;
    return ESP_OK;
}

esp_err_t adc_continuous_io_to_channel(int io_num, adc_unit_t *const unit_id, adc_channel_t *const channel)
{
    if (io_num < 0 || io_num > 48 || unit_id == nullptr || channel == nullptr) {
        return ESP_ERR_INVALID_ARG;  // GPIO_IS_VALID_GPIO on the S3: 0..48
    }
    if (io_num >= 1 && io_num <= 20) {
        *unit_id = io_num <= 10 ? ADC_UNIT_1 : ADC_UNIT_2;
        *channel = static_cast<adc_channel_t>((io_num - 1) % 10);
        return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}

esp_err_t adc_continuous_channel_to_io(adc_unit_t unit_id, adc_channel_t channel, int *const io_num)
{
    if (unit_id > ADC_UNIT_2 || channel > ADC_CHANNEL_9 || io_num == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    *io_num = 1 + static_cast<int>(unit_id) * 10 + static_cast<int>(channel);
    return ESP_OK;
}

esp_err_t adc_continuous_parse_data(adc_continuous_handle_t handle, const uint8_t *raw_data, uint32_t raw_data_size,
                                    adc_continuous_data_t *parsed_data, uint32_t *num_parsed_samples)
{
    if (handle == nullptr || raw_data == nullptr || parsed_data == nullptr || num_parsed_samples == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (raw_data_size == 0 || raw_data_size % SOC_ADC_DIGI_RESULT_BYTES != 0) {
        *num_parsed_samples = 0;
        return ESP_ERR_INVALID_SIZE;
    }
    const uint32_t n = raw_data_size / SOC_ADC_DIGI_RESULT_BYTES;
    for (uint32_t i = 0; i < n; ++i) {
        adc_digi_output_data_t p{};
        std::memcpy(&p.val, raw_data + i * SOC_ADC_DIGI_RESULT_BYTES, sizeof(p.val));
        parsed_data[i].unit = p.type2.unit ? ADC_UNIT_2 : ADC_UNIT_1;
        parsed_data[i].channel = static_cast<adc_channel_t>(p.type2.channel);
        parsed_data[i].raw_data = p.type2.data;
        parsed_data[i].valid = parsed_data[i].channel < SOC_ADC_CHANNEL_NUM(parsed_data[i].unit);
    }
    *num_parsed_samples = n;
    return ESP_OK;
}

esp_err_t adc_continuous_read_parse(adc_continuous_handle_t handle, adc_continuous_data_t *parsed_data, uint32_t max_samples,
                                    uint32_t *num_samples, uint32_t timeout_ms)
{
    std::vector<uint8_t> raw(static_cast<size_t>(max_samples) * SOC_ADC_DIGI_RESULT_BYTES);
    uint32_t len = 0;
    const esp_err_t e = adc_continuous_read(handle, raw.data(), static_cast<uint32_t>(raw.size()), &len, timeout_ms);
    if (e != ESP_OK) {
        *num_samples = 0;
        return e;
    }
    return adc_continuous_parse_data(handle, raw.data(), len, parsed_data, num_samples);
}
