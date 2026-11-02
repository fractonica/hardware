// L1 CSI contract (spec 07 §7.7; design csi-c1 D7, D8, D10, §12): a driver turns the Wi-Fi CSI hardware on and hands
// each valid record to its sink; CsiService does everything else (the ring, the features, the stream).
//
// Threading: init() runs at board init (fr::board::init, the core task's start); capture() and stop() on the core
// task. CsiSink::on_csi runs on the Wi-Fi task (IDF's CSI callback): it copies and returns, never blocks, never
// touches the core. The driver owns everything IDF-specific: esp_wifi_set_csi_config / _rx_cb / esp_wifi_set_csi,
// CONFIG_ESP_WIFI_CSI_ENABLED (its driver.yaml `sdkconfig`), and the router source's pings (lwIP esp_ping).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** Which frames' CSI is kept (fr.csi SourceMode, same values). */
enum class CsiMode : uint8_t { router = 0, peer = 1, any = 2 };

/** The CSI asked of the hardware (fr.csi Format, same values); auto: every format the frames carry, LLTF on. */
enum class CsiFormat : uint8_t { auto_ = 0, lltf = 1, ht = 2, he = 3 };

/**
 * A record's frame format, the wire record's `bb_format` (design csi-c1 §12): IDF's wifi_rx_bb_format_t values on MAC
 * v3 chips (the C5's rx_ctrl.cur_bb_format, verbatim); on the C3, C6 and S3 the driver maps rx_ctrl.sig_mode (0 non-HT
 * as legacy, 1 HT, 3 VHT) and rate (11b) onto the same values.
 */
enum class CsiBbFormat : uint8_t { b11 = 0, legacy = 1, ht = 2, vht = 3, he_su = 4, he_mu = 5, he_ersu = 6, he_tb = 7, vht_mu = 11 };

/** The wire record's `flags` bits (design csi-c1 §12); the others are zero. */
inline constexpr uint8_t kCsiFlagFirstWordInvalid = 1u << 0;  // IDF first_word_invalid: data[0..3] are not valid
inline constexpr uint8_t kCsiFlagGroup = 1u << 1;             // a group-addressed frame (rx_ctrl.is_group)
inline constexpr uint8_t kCsiFlagMatched = 1u << 2;           // from the source's sender (the AP's BSSID, peer_mac)

/** The longest record data the C5 delivers (HE20: 245 subcarriers x 2 bytes = 490), rounded up. */
inline constexpr size_t kCsiDataMax = 512;

/** One record as IDF delivered it: the wire record's fields (design csi-c1 §12), `data` only valid inside on_csi. */
struct CsiRecord {
    uint32_t t_us;                 // rx_ctrl.timestamp: the chip's µs clock at reception (wraps every ~71.6 min)
    int8_t rssi;                   // dBm
    int8_t noise;                  // rx_ctrl.noise_floor, dBm
    uint8_t channel;               // the primary channel
    CsiBbFormat bb_format;
    uint8_t flags;                 // kCsiFlag*
    std::array<uint8_t, 6> mac;    // the sender
    std::span<const int8_t> data;  // (imaginary, real) per subcarrier, as IDF orders them; at most kCsiDataMax
};

/** What to capture: CsiService's effective source (the config's, or a stream's). */
struct CsiCapture {
    CsiMode mode = CsiMode::router;
    /** router: pings to the default gateway per second. */
    uint16_t rate_hz = 100;
    /** peer: the transmitter's station MAC (valid when has_peer). */
    std::array<uint8_t, 6> peer{};
    bool has_peer = false;
    CsiFormat format = CsiFormat::auto_;
};

/** Implemented by CsiService. */
class CsiSink
{
public:
    /**
     * A record whose rx_ctrl.rx_channel_estimate_info_vld is set and whose sender the capture keeps (any: all of
     * them). Wi-Fi task: copy what is kept, return at once; `r.data` is gone after the return.
     */
    virtual void on_csi(const CsiRecord &r) = 0;

protected:
    ~CsiSink() = default;
};

/** Wi-Fi CSI on ESP32 chips with SOC_WIFI_CSI_SUPPORT (wifi_csi). */
class CsiSource
{
public:
    /** Remembers the sink; touches no Wi-Fi state (the station may not be started yet). Board init. */
    virtual Status init(Core &core, CsiSink &sink) = 0;
    /**
     * Captures `c` from now on, replacing what ran: applied at once when the station has an IP, else as soon as it
     * gets one, and again after every reconnect (a new channel, a new gateway). Err::invalid_args for mode peer
     * without has_peer, or a rate_hz outside 10..200. Core task; does not block.
     */
    virtual Status capture(const CsiCapture &c) = 0;
    /** No more records, no pings; OK when stopped. Core task. */
    virtual Status stop() = 0;
    /** Router pings sent and those that got no reply, since boot (stats csi). */
    virtual uint32_t pings_sent() const { return 0; }
    virtual uint32_t pings_lost() const { return 0; }
    /** CONFIG_ESP_WIFI_CSI_ENABLED is on and the CSI callback is registered (once the station started). */
    virtual Selftest selftest() = 0;

protected:
    ~CsiSource() = default;
};

}  // namespace fr::hal
