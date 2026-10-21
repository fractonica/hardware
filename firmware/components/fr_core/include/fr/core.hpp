// Node runtime (spec 03 §3.4-3.5, design c2 §5). The app's main does, in order:
//   fr::Core &core = fr::core::start();          // NVS, identity, boot epoch, fr_serial + diag channel
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
#include "fr/hal/selftest.hpp"
#include "fr/id.h"
#include "fr/services/envelope_link.hpp"

namespace fr::core {

/** Board instances one node runs (the profile's ports 1-239; RAM is the practical limit). */
inline constexpr size_t kMaxInstances = 16;

/** fr::board::selftest: the driver self-test of one instance by name. */
using SelftestFn = hal::Selftest (*)(const char *name);

/**
 * Boot steps 1 and 4 of 03 §3.5 that need no board: initialises NVS, loads the identity, commits this
 * boot's epoch before any frame can go out, and starts fr_serial with the serial command channel.
 * It also takes the runtime's own timer (the delayed reboot) from the pool, so the board's services
 * get the other 23. Lines that arrive before run() wait in the core queue. Call once, from app_main.
 */
Core &start();

/** The Sink capabilities emit into; fr::board::init may attach with it before a service's init(). */
cap::Sink &sink();

/**
 * Registers the ports (fr.node on 0, the board's instances, fr.diag on 241), attaches every capability
 * the board left unattached, logs the C1 ready banner (plus `caps=<n> epoch=<e>`), starts the core task
 * (priority 10), which first reports every property, and then keeps the liveness log on the calling
 * task. `ok` false marks an instance whose init failed: it stays listed but answers FAILED.
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

/** Identity loaded by start(), including this boot's epoch. */
const fr_identity_t &identity();

/** First 6 bytes of the running image's appended SHA-256, as 12 hex digits (matches build_id). */
const char *fw_id();

}  // namespace fr::core
