// fr_diag: the serial command channel (spec 09 §9.7, design c2 §5). A request line is
// `[#<id> ]<command> [args…]`; the response is exactly one line `[#<id> ]<json>` with
// {"ok":true,...} or {"ok":false,"error":"<code>","detail":"…"}. Requests run on the core task and
// return their output; nothing here prints. fr_core owns the runtime state and implements Host.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

#include "fr/cap/capability.hpp"
#include "fr/id.h"

namespace fr::diag {

inline constexpr uint8_t kPortNode = 0;
inline constexpr uint8_t kPortDiag = 241;

/** One addressable instance: board instances plus `node` (0) and `diag` (241). */
struct PortInfo {
    uint8_t port;
    const char *name;
    cap::Capability *cap;
    bool ok;  // false: init failed
};

struct SelftestResult {
    bool ok;
    const char *detail;
};

/** Counters the runtime keeps for `stats`. */
struct RuntimeStats {
    uint32_t cmds;           // CMD envelopes dispatched
    uint32_t env_ignored;    // envelopes not for this node
    uint32_t env_bad;        // envelopes that did not decode
    uint32_t rx_dropped;     // received lines lost to a full core queue or buffer pool
    uint32_t posts_dropped;  // Core::post calls refused (queue full)
};

/** What the command channel needs from the runtime; every call happens on the core task. */
class Host
{
public:
    virtual const fr_identity_t &identity() const = 0;
    virtual const char *fw_id() const = 0;
    virtual std::span<const PortInfo> ports() const = 0;
    /** Driver self-test of the named instance; false when there is no such instance. */
    virtual bool selftest(const char *name, SelftestResult &out) = 0;
    virtual cap::Sink &sink() = 0;
    virtual RuntimeStats runtime_stats() const = 0;
    virtual void reset_runtime_stats() = 0;
    /** Restarts shortly after the response line has gone out. */
    virtual void reboot(bool bootloader) = 0;

protected:
    ~Host() = default;
};

/** Runs one request line; writes the single response line (no terminator) into `out`, returns its
 * length, or 0 for a blank line, which gets no response. */
size_t execute(std::string_view line, Host &host, std::span<char> out);

/** Whether restart(true) can reach ROM download mode on this target. */
bool can_enter_bootloader();

/** Restarts the chip; with `bootloader`, into ROM download mode (USB-Serial/JTAG targets). */
[[noreturn]] void restart(bool bootloader);

/** This boot's reset reason as the banner and `info` print it ("POWERON", "SW", "PANIC", ...). */
const char *reset_reason();

}  // namespace fr::diag
