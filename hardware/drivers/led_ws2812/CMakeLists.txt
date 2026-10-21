# led_ws2812 (design c2 §6): hal::LightOutput on one WS2812 pixel through espressif/led_strip (RMT).
# led_strip comes from idf_component.yml as a private requirement; the public header only
# forward-declares its handle.
idf_component_register(SRCS "src/led_ws2812.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_driver_rmt)
