# haptic_ledc (design power-p1 D7): hal::HapticOutput on one GPIO through LEDC. Drivers are the only code that includes
# driver/*.h (spec 03 §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/haptic_ledc.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_driver_ledc)
