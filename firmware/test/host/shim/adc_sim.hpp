// The host suite's ADC continuous-mode shim (design audio-a2 D2): the test side of idf/esp_adc/adc_continuous.h. The
// suite builds hardware/drivers/adc_audio unchanged against idf/ (FR_HOST_SHIM), so its tests check the handle and
// pattern the driver sets up, the rate it asks for, and what read() makes of the DMA's results. No clock runs: the test
// makes conversions (adc_convert), which fill frames of conv_frame_size bytes as the DMA does; each whole frame goes
// into the pool (max_store_buf_size bytes) or, when the pool has no room for it, is lost and the on_pool_ovf callback
// runs, as IDF's ISR does with flags.flush_pool 0. A read takes what the pool holds (up to length_max, or the cap a
// test sets: IDF's byte ring returns only its contiguous part) and answers ESP_ERR_TIMEOUT at once when it is empty.
// The state checks are IDF v6.1's (config, callbacks and flush_pool only while stopped, read only while started).
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace esp_sim {

/** One handle adc_continuous_new_handle made, in plain numbers (IDF's enum values). */
struct AdcHandle {
    // adc_continuous_handle_cfg_t
    uint32_t pool_bytes = 0;
    uint32_t frame_bytes = 0;
    bool flush_pool = false;
    // adc_continuous_config_t (the last one taken)
    uint32_t pattern_num = 0;
    int atten = -1;
    int channel = -1;
    int unit = -1;
    int bit_width = -1;
    uint32_t sample_freq_hz = 0;
    int conv_mode = 0;
    bool started = false;
    bool deinited = false;
    uint32_t configs = 0;
    uint32_t starts = 0;
    uint32_t stops = 0;
    uint32_t flushes = 0;
    uint32_t reads = 0;
    uint32_t last_read_max = 0;     // length_max of the newest read
    uint32_t last_timeout_ms = 0;   // its timeout
    uint32_t overflows = 0;         // frames the pool lost
    std::vector<uint8_t> pool;      // what reads take, oldest first
    std::vector<uint8_t> frame;     // the DMA frame filling
};

/** The newest handle (nullptr: none made). */
AdcHandle *adc_handle();
/** adc_continuous_new_handle calls that succeeded. */
int adc_new_calls();
/**
 * The DMA converts `raw` (12-bit codes) on ADC `unit` (0: ADC1) channel `channel`, while started: TYPE2 result words
 * into frames, each whole frame into the pool, or lost (on_pool_ovf) when it does not fit.
 */
void adc_convert(std::span<const uint16_t> raw, unsigned channel, unsigned unit = 0);
/** Conversions the DMA makes right after every adc_continuous_start, on the configured channel (a self-test's). */
void adc_set_on_start(std::vector<uint16_t> raw);
/** Reads return at most `bytes` (0: no cap). */
void adc_set_read_cap(uint32_t bytes);
/** Every handle gone. */
void adc_reset();

}  // namespace esp_sim
