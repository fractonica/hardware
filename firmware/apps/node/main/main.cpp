// Generic node runtime: the core, then the generated composition root of the profile (fr_board).
#include "fr/board.hpp"
#include "fr/core.hpp"

extern "C" void app_main(void)
{
    if constexpr (fr::board::kHasBattery) {
        // fr_core cannot include the generated board header: the battery input comes from here (vbat_mv). Before
        // start(), which starts the core task whose vitals read it: set_battery() writes it unsynchronised, and
        // start() leaves it as set.
        constexpr auto b = fr::board::kBattery;
        fr::core::set_battery({b.gpio, b.divider_milli, b.low_mv});
    }
    fr::Core &core = fr::core::start();
    fr::board::attach(fr::core::sink());
    // A failure is recorded per port in the instance table; run() lists such ports with ok=false.
    (void)fr::board::init(core);
    fr::core::run(fr::board::instances(), &fr::board::selftest);
}
