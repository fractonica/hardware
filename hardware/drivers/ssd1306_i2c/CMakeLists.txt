# ssd1306_i2c (design m2-c5-display D8): hal::Display on an SSD1306 / SSD1306B OLED over I2C, on fr_core's shared bus
# (fr/platform/i2c_bus.hpp). Drivers are the only code that includes driver/*.h (spec 03 §3.2); the public header
# exposes fr_core types only.
idf_component_register(SRCS "src/ssd1306_i2c.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_i2c)
