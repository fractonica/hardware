// Outputs that must go off before a restart or a panic (design power-p1 review B1; design m2-c1-hil D11 item 1).
//
// On the C6 and the S3, esp_restart() and a panic's restart end in esp_restart_noos(), a CPU reset that leaves the
// GPIO, IO_MUX and LEDC registers as they were: a load, a solenoid's PWM or a pressed fixture line keeps running through
// the panic handler, the coredump, the bootloader and core::start() until its driver's init. A driver that drives
// such an output registers two hooks here:
//
//   - `restart` runs on the task that called esp_restart(), before the CPU reset (one esp shutdown handler for all);
//   - `panic` runs first in every panic (esp_panic_handler, wrapped by fr_core's link: -Wl,--wrap=esp_panic_handler),
//     with interrupts off and the other CPU stalled: IRAM, lock-free, no driver calls (register writes only).
//
// Either may be null. One registry, so every driver shares the one shutdown-handler slot and the one wrap.
#pragma once

namespace fr::platform {

using SafeOffHook = void (*)();

/** Registers a pair of hooks; false when the table (kSafeOffMax) is full or the shutdown handler has no slot. */
bool register_safe_off(SafeOffHook restart, SafeOffHook panic);

/** Hooks at most. */
inline constexpr int kSafeOffMax = 8;

#if FR_HOST_SHIM
/** Host suite: forget every hook (a CPU reset of the simulated chip). */
void safe_off_host_reset();
#endif

}  // namespace fr::platform
