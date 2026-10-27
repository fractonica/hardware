# adc_oneshot (design m2-c3-inputs D3): hal::AnalogSource on one ADC1 channel. The ADC1 unit and the calibration
# handles are fr_core's (fr/platform/adc1.hpp, shared with the vbat reader); the public header exposes fr_core
# types only.
idf_component_register(SRCS "src/adc_oneshot.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_adc)
