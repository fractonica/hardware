# gc9a01_spi (design scale-round-c1 D3): hal::Display on a GC9A01 round panel over SPI with DMA, no backlight. Drivers
# are the only code that includes driver/*.h (spec 03 §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/gc9a01_spi.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_spi esp_driver_gpio)
