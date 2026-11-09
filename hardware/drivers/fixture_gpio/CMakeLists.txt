# fixture_gpio (design m2-c1-hil D4): hal::FixtureLine on one GPIO of the HIL fixture. Drivers are the only code
# that includes driver/*.h (spec 03 §3.2); the public header exposes fr_core types only. src/edge_ring.hpp is
# private and IDF-free (the host suite tests it); linker.lf keeps the ISR paths in IRAM.
idf_component_register(SRCS "src/fixture_gpio.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_driver_ledc esp_timer
                       LDFRAGMENTS "linker.lf")

# Design m2-c1-hil D11 item 1: the panic hook and the restart handler are fr_core's (fr/platform/safe_off.hpp), shared
# with every driver that drives an output a CPU reset would leave running; this driver registers its two hooks there.
