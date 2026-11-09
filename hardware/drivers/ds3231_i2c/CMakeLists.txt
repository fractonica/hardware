# ds3231_i2c (design lcd-clock-c1 D7, D8): hal::Rtc on a DS3231 over fr_core's shared I2C bus. Drivers are the only code
# that includes driver/*.h (spec 03 §3.2); the register layout is fr_core's IDF-free fr/rtc/ds3231_regs.hpp.
idf_component_register(SRCS "src/ds3231_i2c.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_i2c)
