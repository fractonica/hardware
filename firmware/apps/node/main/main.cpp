// Generic node runtime: the core, then the generated composition root of the profile (fr_board).
#include "fr/board.hpp"
#include "fr/core.hpp"

extern "C" void app_main(void)
{
    fr::Core &core = fr::core::start();
    fr::board::attach(fr::core::sink());
    // A failure is recorded per port in the instance table; run() lists such ports with ok=false.
    (void)fr::board::init(core);
    fr::core::run(fr::board::instances(), &fr::board::selftest);
}
