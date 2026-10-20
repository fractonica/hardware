idf_component_register(SRCS "hwprobe.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES esp_driver_gpio esp_driver_i2c esp_wifi esp_netif esp_event
                                     nvs_flash esp_timer spi_flash lwip)
