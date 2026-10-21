# button_gpio (design c2 §6): hal::ButtonSource on one GPIO. Drivers are the only code that includes
# driver/*.h (spec 03 §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/button_gpio.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_timer)
