// fr::platform::register_safe_off (fr/platform/safe_off.hpp): one esp shutdown handler and one panic wrap for every
// driver whose outputs a CPU reset would leave running (fixture_gpio's lines, haptic_ledc's PWM, ChargerGpio's load
// and gate). The host suite builds this file against shim/idf with the fixture drivers (FR_HOST_SHIM).
#include "fr/platform/safe_off.hpp"

#include "esp_attr.h"
#include "esp_system.h"

namespace fr::platform {
namespace {

// Constant-initialized (no constructor runs before a driver's init registers): a panic reads them as they are.
SafeOffHook s_restart[kSafeOffMax] = {};
SafeOffHook s_panic[kSafeOffMax] = {};
int s_count = 0;
bool s_handler = false;

void run_restart_hooks()
{
    // Last registered first, as esp_restart runs its own handlers.
    for (int i = s_count - 1; i >= 0; --i) {
        if (s_restart[i] != nullptr) {
            s_restart[i]();
        }
    }
}

/** Every registered panic hook, in IRAM: called from the wrap below with interrupts off. */
IRAM_ATTR void run_panic_hooks()
{
    for (int i = 0; i < s_count; ++i) {
        if (s_panic[i] != nullptr) {
            s_panic[i]();
        }
    }
}

}  // namespace

bool register_safe_off(SafeOffHook restart, SafeOffHook panic)
{
    if (s_count == kSafeOffMax) {
        return false;
    }
    if (!s_handler) {
        // Five slots in IDF; none left means the caller must not drive what a restart could leave on.
        const esp_err_t err = esp_register_shutdown_handler(&run_restart_hooks);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            return false;
        }
        s_handler = true;
    }
    s_restart[s_count] = restart;
    s_panic[s_count] = panic;
    ++s_count;
    return true;
}

#if FR_HOST_SHIM
void safe_off_host_reset()
{
    for (int i = 0; i < kSafeOffMax; ++i) {
        s_restart[i] = nullptr;
        s_panic[i] = nullptr;
    }
    s_count = 0;
    s_handler = false;
}
#endif

}  // namespace fr::platform

// The panic hook: every panic (a task or interrupt watchdog with CONFIG_ESP_TASK_WDT_PANIC, abort, an assert, a fault)
// reaches esp_panic_handler from the port's handler, with the other CPU stalled; fr_core's CMakeLists.txt links every
// image with -Wl,--wrap=esp_panic_handler. The outputs go off here, before the backtrace and the coredump (which take
// up to seconds) and the restart's CPU reset, which keeps them as they are. IRAM (noflash).
extern "C" void __real_esp_panic_handler(void *info);
extern "C" IRAM_ATTR void __wrap_esp_panic_handler(void *info)
{
    fr::platform::run_panic_hooks();
    __real_esp_panic_handler(info);
}
