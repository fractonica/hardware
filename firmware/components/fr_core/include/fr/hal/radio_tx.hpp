// L1 frame transmitter contract (spec 07 §7.7; design csi-c1 D9): a driver sends ESP-NOW unicast frames at a fixed
// rate on the station's channel; RadioTxService checks the arguments, keeps `sending` and ends a run at its seconds.
//
// Threading: init() at board init; start(), stop() and the counters on the core task. The driver paces the frames
// itself (an esp_timer, or fr_net's ESP-NOW send path), never on the core task, and adds its peer through fr_net's
// ESP-NOW layer (the hub link shares the radio and the peer table).
#pragma once

#include <array>
#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

class RadioTx
{
public:
    virtual Status init(Core &core) = 0;
    /**
     * Sends `len` bytes (a u32 LE sequence number from 0, then zeros) to `peer` rate_hz times a second at the band's
     * robust rate (2.4 GHz 11b 1 Mbps, 5 GHz 11a 6 Mbps), until stop(); a start replaces a running one. Err::busy
     * while the station has no channel (not connected), Err::invalid_args for a group address. Unacknowledged
     * frames are not sent again.
     */
    virtual Status start(const std::array<uint8_t, 6> &peer, uint16_t rate_hz, uint16_t len) = 0;
    /** OK when stopped. */
    virtual Status stop() = 0;
    /** Still sending: false after stop(), or once the station lost its channel (the driver stops itself). */
    virtual bool running() const = 0;
    /** Frames handed to ESP-NOW, and those the peer did not acknowledge, since boot (stats radio_tx). */
    virtual uint32_t sent() const { return 0; }
    virtual uint32_t failed() const { return 0; }
    /** ESP-NOW is up (fr_net's). */
    virtual Selftest selftest() = 0;

protected:
    ~RadioTx() = default;
};

}  // namespace fr::hal
