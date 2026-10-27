# fixture_gpio (design m2-c1-hil D4): hal::FixtureLine on one GPIO of the HIL fixture. Drivers are the only code
# that includes driver/*.h (spec 03 §3.2); the public header exposes fr_core types only. src/edge_ring.hpp is
# private and IDF-free (the host suite tests it); linker.lf keeps the ISR paths in IRAM.
idf_component_register(SRCS "src/fixture_gpio.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_driver_ledc esp_timer
                       LDFRAGMENTS "linker.lf")

# Design m2-c1-hil D11 item 1: the panic hook. Every panic lets go of the lines in __wrap_esp_panic_handler
# (src/fixture_gpio.cpp) before esp_panic_handler prints and dumps; -u keeps the object in the link whenever the
# wrap is on, so no profile that builds this component can link the wrap without its target.
target_link_options(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=esp_panic_handler" "-Wl,-u,__wrap_esp_panic_handler")
