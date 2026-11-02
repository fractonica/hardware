# i2s_amp (design audio-a1 D6): hal::AudioSink on an I2S TX channel in standard mode, the shutdown pin on a GPIO.
# Drivers are the only code that includes driver/*.h (spec 03 §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/i2s_amp.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_i2s esp_driver_gpio)
