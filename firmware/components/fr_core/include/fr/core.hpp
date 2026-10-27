// Node runtime (spec 03 §3.4-3.5, design c2 §5, c3 §3). The app's main does, in order:
//   fr::core::set_battery({...});                // the board's kBattery, when kHasBattery (vbat_mv)
//   fr::Core &core = fr::core::start();          // NVS, identity, boot epoch, hub link core, fr_serial + diag
//   fr::board::attach(fr::core::sink());         // generated: ports and names, before any emission
//   fr::board::init(core);                       // generated: drivers -> services, failures per port
//   fr::core::run(fr::board::instances(), &fr::board::selftest);   // never returns
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/cap/capability.hpp"
#include "fr/core/core.hpp"
#include "fr/core/port.hpp"
#include "fr/hal/selftest.hpp"
#include "fr/id.h"

namespace fr::core {

/** Board instances one node runs (the profile's ports 1-239; RAM is the practical limit). */
inline constexpr size_t kMaxInstances = 16;

/** fr::board::selftest: the driver self-test of one instance by name. */
using SelftestFn = hal::Selftest (*)(const char *name);

/**
 * Boot steps 1, 2 and 4 of 03 §3.5 that need no board: initialises NVS, loads the identity, commits this
 * boot's epoch before any frame can go out, starts fr_worker, builds the hub link's protocol core (fr_net's
 * Net) with its serial, TCP and UDP links attached (the TCP and UDP ones stay down until run() starts
 * Wi-Fi), runs fr_ota's boot checks (a PENDING_VERIFY image's health deadline starts here) and starts
 * fr_serial with the serial command channel. It also takes the runtime's own timers (the delayed reboot,
 * the serial link poll), Net's and Ota's from the pool, so the board's services get their 23. Lines and
 * frames that arrive before run() wait in the core queues; HELLO waits for the core task. Call once, from
 * app_main.
 */
Core &start();

/**
 * The Sink capabilities emit into: fr_net's Net, which turns emissions into EVENT/STATE envelopes to the
 * hub. Valid after start(); fr::board::attach takes it before any service's init().
 */
cap::Sink &sink();

/**
 * Registers the ports (fr.node on 0, the board's instances, fr.diag on 241), attaches every capability
 * the board left unattached, builds the descriptor HELLO carries the hash of, logs the C1 ready banner
 * (plus `caps=<n> epoch=<e>`), starts the core task (priority 10), which first reports every property,
 * then starts Wi-Fi and with it the TCP/UDP links (03 §3.5 step 5) unless CONFIG_FR_NET_RADIO=n (the serial
 * link only, design m2-c1-hil D6), and keeps the liveness log on the calling task. `ok` false marks an instance whose init failed: it stays listed but answers FAILED.
 */
[[noreturn]] void run_ports(std::span<const PortEntry> instances, SelftestFn selftest, size_t left_out = 0);

/**
 * run_ports() for the generated board table: anything iterable whose elements have `port`, `name` and
 * `cap` (fr/board.hpp's Instance). A null `cap`, or a member `ok`/`status` that says so, marks a port
 * whose init failed. Instances beyond kMaxInstances are left out and logged.
 */
template <class Instances>
[[noreturn]] void run(const Instances &instances, SelftestFn selftest = nullptr)
{
    static PortEntry table[kMaxInstances];
    size_t n = 0;
    size_t left_out = 0;
    for (const auto &inst : instances) {
        if (n == kMaxInstances) {
            ++left_out;
            continue;
        }
        bool ok = inst.cap != nullptr;
        if constexpr (requires { inst.ok; }) {
            ok = ok && static_cast<bool>(inst.ok);
        }
        if constexpr (requires { static_cast<bool>(*inst.status); }) {
            ok = ok && inst.status != nullptr && static_cast<bool>(*inst.status);  // const Status *
        } else if constexpr (requires { inst.status; }) {
            ok = ok && static_cast<bool>(inst.status);
        }
        table[n++] = {inst.port, inst.name, inst.cap, ok};
    }
    run_ports({table, n}, selftest, left_out);
}

/** The board's battery input (fr/board.hpp kBattery; design m2-c3-inputs D11). fr_core cannot include the
 * generated board header (fr_board depends on fr_core), so the app's main hands it over. */
struct Battery {
    int8_t gpio;             // -1: none (HEARTBEAT vbat_mv stays 0, "not measured")
    uint16_t divider_milli;  // battery mV = pin mV * divider_milli / 1000
    uint16_t low_mv;         // HEARTBEAT low_batt when 0 < vbat_mv < low_mv
};

/**
 * Makes the vitals measure vbat_mv: once per heartbeat, 8 conversions on `gpio` through the shared ADC1 unit
 * (fr/platform/adc1.hpp, 12 dB, curve fitting), averaged, times the divider. Call before start(): the core task
 * start() creates reads it without a lock (the vitals), and start() does not reset it. Without it (or with gpio
 * -1) vbat_mv stays 0. A pin the ADC refuses is logged once and reads 0.
 */
void set_battery(const Battery &battery);

/** Identity loaded by start(), including this boot's epoch (and a later fr.node.set_alias). */
const fr_identity_t &identity();

/** First 6 bytes of the running image's appended SHA-256, as 12 hex digits (matches build_id). */
const char *fw_id();

}  // namespace fr::core
