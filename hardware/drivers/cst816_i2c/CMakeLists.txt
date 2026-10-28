# cst816_i2c (design m2-c5-display D4): hal::TouchSource on a CST816S/D/T over I2C, on fr_core's shared bus
# (fr/platform/i2c_bus.hpp); INT feeds a core input slot. Drivers are the only code that includes driver/*.h (spec 03
# §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/cst816_i2c.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_i2c esp_driver_gpio esp_timer)
