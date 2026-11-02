// The host suite's I2S shim (design audio-a1 D6): the test side of idf/driver/i2s_std.h. The suite builds
// hardware/drivers/{i2s_mic,i2s_amp} unchanged against idf/ (FR_HOST_SHIM), so their tests check the channels the drivers
// make (one i2s_new_channel call for a share_with pair), their configuration, the clock as start() sets it, and what
// read() and write() move. The shutdown pin is esp_sim's GPIO. No clock runs: a read takes what the test fed. As IDF
// v6.1 does, the half of a duplex pair set up second becomes an internal slave, which moves nothing while the master's
// channel is disabled (its BCLK and WS come from the master).
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace esp_sim {

/** One channel i2s_new_channel made: its configuration in plain numbers (IDF's enum values: slot_mode 1 mono, 2
 * stereo; slot_mask 1 left, 2 right, 3 both; slot_bits 0 auto; pins -1 unused). */
struct I2sChannel {
    int port = -1;
    bool tx = false;
    bool inited = false;  // i2s_channel_init_std_mode ran
    bool enabled = false;
    // i2s_chan_config_t
    bool master = false;
    bool duplex = false;        // made with its other direction by one i2s_new_channel call
    bool duplex_slave = false;  // switched to slave at init_std_mode: the other half was set up first
    uint32_t dma_desc = 0;
    uint32_t dma_frames = 0;
    bool auto_clear = false;
    // i2s_std_config_t
    int data_bits = 0;
    int slot_bits = 0;
    int slot_mode = 0;
    int slot_mask = 0;
    bool bit_shift = false;  // Philips (true) or MSB framing
    uint32_t ws_width = 0;   // BCLK ticks
    uint32_t mclk_multiple = 0;  // MCLK / rate, the std config's, then each reconfig_std_clock
    int bclk = -1;
    int ws = -1;
    int dout = -1;
    int din = -1;
    uint32_t clock_hz = 0;  // the std config's, then each reconfig_std_clock
    uint32_t enables = 0;
    void *cbs = nullptr;  // the registered i2s_event_callbacks_t (shim side)
    void *cb_ctx = nullptr;
    std::vector<int16_t> written;  // TX: every int16 written (both slots carry each sample: written once)
    std::vector<int32_t> rx;       // RX: frames still to read
};

/** The channel of `port` in a direction (nullptr: none made). */
I2sChannel *i2s_channel(int port, bool tx);
/** i2s_new_channel calls that succeeded. */
int i2s_new_calls();
/** Frames the next reads of `port`'s RX channel return. */
void i2s_feed(int port, std::span<const int32_t> frames);
/** The DMA overflowed (RX) or starved (TX) once: the channel's callback runs, as from the ISR. */
void i2s_isr_event(int port, bool tx);
/** Every channel gone, and fr::platform::i2s's pair table empty again. */
void i2s_reset();

}  // namespace esp_sim
