// The shared-clock duplex pair of design audio-a1 D6 (`share_with`): an i2s_mic and an i2s_amp on one I2S controller,
// BCLK and WS shared, the TX and RX channels made by one i2s_new_channel call. Whichever driver of the pair inits first
// makes both channels and leaves its partner's half here; the other takes it. Both run at one rate: the first to start
// sets it, the other must start at the same one while it runs. IDF-free (the handles are opaque, the driver hands its
// IDF calls in as Ops) and header-only, so both driver components share the one table without requiring each other.
// Board init and fr_audio only, one at a time (fr/hal/audio.hpp), so no lock.
//
// The clock: IDF (v6.1 i2s_channel_try_to_constitute_duplex) keeps the half whose std mode was set up first as the
// master and switches the later one to an internal slave, whose BCLK and WS come from the master's. The master's
// clock runs only while its channel is enabled (*inferred* from the TRM's tx_start/rx_start, not measured: no C3/C6
// audio board yet), so start() enables the master too when only the slave's driver starts, and stop() keeps the master
// enabled while the slave still runs (an amplifier's TX then plays the DMA's cleared buffers, muted by its shutdown
// pin; a microphone's RX overwrites buffers nobody reads). Each half's clock divider is its own in IDF, so a new rate
// is set on both halves, which are then both disabled (the partner is stopped: one rate while both run).
#pragma once

#include <array>
#include <cstdint>

#include "fr/base.hpp"

namespace fr::platform::i2s {

/** I2S controllers on any target the drivers take (the S3 has two). */
inline constexpr uint8_t kPorts = 2;

struct Pair {
    void *tx = nullptr;  // i2s_chan_handle_t: the amplifier's half
    void *rx = nullptr;  // the microphone's
    bool made = false;   // i2s_new_channel ran for this controller
    bool tx_ready = false;  // i2s_channel_init_std_mode ran for that half
    bool rx_ready = false;
    bool master_tx = false;  // the half set up first: IDF's duplex master (valid once a half is ready)
    bool tx_on = false;      // the channel is enabled (a master may run for its slave's clock only)
    bool rx_on = false;
    uint32_t tx_hz = 0;  // the rate each driver's half runs at (0: stopped)
    uint32_t rx_hz = 0;
    uint32_t clock_hz = 0;  // both halves' clock as last configured
};

/** The IDF calls on a half's opaque handle, from the driver calling in. */
struct Ops {
    Status (*enable)(void *chan);
    Status (*disable)(void *chan);
    /** The pair's clock config at `hz` (fr::drv's duplex mclk multiple) on a disabled half. */
    Status (*set_clock)(void *chan, uint32_t hz);
};

inline std::array<Pair, kPorts> &pairs()
{
    static std::array<Pair, kPorts> table{};
    return table;
}

/** The pair of controller `port` (nullptr for a port out of range). */
inline Pair *pair(uint8_t port)
{
    return port < kPorts ? &pairs()[port] : nullptr;
}

/** The rate the pair's other half runs at, for a half about to start (0: free to choose). */
inline uint32_t partner_hz(const Pair &p, bool tx)
{
    return tx ? p.rx_hz : p.tx_hz;
}

/** A half's std mode was set up (init): the first one is the master. */
inline void mark_ready(Pair &p, bool tx)
{
    if (!p.tx_ready && !p.rx_ready) {
        p.master_tx = tx;
    }
    (tx ? p.tx_ready : p.rx_ready) = true;
}

/**
 * Starts the half `tx` at `hz`: invalid_args while the partner runs at another rate; a new rate on both halves (both
 * stopped then); the master's channel enabled first (for a slave starting alone it runs for the clock only), then
 * this half's. Its rate is recorded.
 */
inline Status start(Pair &p, bool tx, uint32_t hz, const Ops &ops)
{
    const uint32_t other = partner_hz(p, tx);
    if (other != 0 && other != hz) {
        return std::unexpected(Err::invalid_args);  // one clock: the partner runs at another rate
    }
    if (p.clock_hz != hz) {
        // Neither channel is enabled here: the partner is stopped, and a master runs for its slave only.
        for (const bool half : {true, false}) {
            if ((half ? p.tx_ready : p.rx_ready)) {
                if (auto st = ops.set_clock(half ? p.tx : p.rx, hz); !st) {
                    return st;
                }
            }
        }
        p.clock_hz = hz;
    }
    const bool master = p.master_tx;
    bool &master_on = master ? p.tx_on : p.rx_on;
    if (tx != master && !master_on) {
        if (auto st = ops.enable(master ? p.tx : p.rx); !st) {
            return st;
        }
        master_on = true;
    }
    bool &own_on = tx ? p.tx_on : p.rx_on;
    if (!own_on) {
        if (auto st = ops.enable(tx ? p.tx : p.rx); !st) {
            return st;
        }
        own_on = true;
    }
    (tx ? p.tx_hz : p.rx_hz) = hz;
    return {};
}

/**
 * Stops the half `tx`: its channel is disabled unless it is the master and the slave still runs; a slave stopping
 * also disables a master that ran for its clock only.
 */
inline void stop(Pair &p, bool tx, const Ops &ops)
{
    (tx ? p.tx_hz : p.rx_hz) = 0;
    const bool master = p.master_tx;
    bool &own_on = tx ? p.tx_on : p.rx_on;
    if (tx == master && partner_hz(p, tx) != 0) {
        return;  // the slave's BCLK and WS come from this channel
    }
    if (own_on) {
        static_cast<void>(ops.disable(tx ? p.tx : p.rx));
        own_on = false;
    }
    bool &master_on = master ? p.tx_on : p.rx_on;
    if (tx != master && master_on && (master ? p.tx_hz : p.rx_hz) == 0) {
        static_cast<void>(ops.disable(master ? p.tx : p.rx));
        master_on = false;
    }
}

}  // namespace fr::platform::i2s
