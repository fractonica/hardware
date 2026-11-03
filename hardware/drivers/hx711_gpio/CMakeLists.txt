# hx711_gpio (design scale-round-c1 D8): hal::LoadCell on an HX711 by two GPIOs; a DOUT edge interrupt wakes the
# driver's task, which clocks the conversion out. Drivers are the only code that includes driver/*.h (spec 03 §3.2); the
# public headers expose fr_core types only (include/fr/drv/hx711_bits.hpp is IDF-free: the host suite tests it).
idf_component_register(SRCS "src/hx711_gpio.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_timer)
