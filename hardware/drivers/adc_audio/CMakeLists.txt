# adc_audio (design audio-a2 D2): hal::AudioSource on one ADC1 channel through IDF adc_continuous (DMA). Drivers are the
# only code that includes esp_adc/*.h (spec 03 §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/adc_audio.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_adc)
