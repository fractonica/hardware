# st7789_spi (design m2-c5-display D7): hal::Display on an ST7789 / ST7789T3 over SPI with DMA, LEDC PWM on the
# backlight. Drivers are the only code that includes driver/*.h (spec 03 §3.2); the public header exposes fr_core
# types only.
idf_component_register(SRCS "src/st7789_spi.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio esp_driver_ledc)
