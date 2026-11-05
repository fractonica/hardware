# tp4056 (design power-p1 D4): hal::PowerCell on a charger module by bare pins (ChargerGpio, which tp5000 shares). The
# ADC1 unit and calibration handles are fr_core's (fr/platform/adc1.hpp, shared with adc_oneshot and the vbat reader).
# Drivers are the only code that includes driver/*.h (spec 03 §3.2); the public headers expose fr_core types only.
idf_component_register(SRCS "src/charger_gpio.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_adc esp_driver_gpio)
