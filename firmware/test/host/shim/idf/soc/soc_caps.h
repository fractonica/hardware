// Host shim (firmware/test/host/shim/esp_sim.hpp): soc/soc_caps.h, the ESP32-S3's, as far as fr_core and the drivers
// read it (IDF v6.1 components/soc/esp32s3/include/soc/soc_caps.h).
#pragma once

#define SOC_I2C_NUM (2U)

// ADC (adc_audio, shim/adc_sim.cpp)
#define SOC_ADC_DMA_SUPPORTED 1
#define SOC_ADC_DIG_SUPPORTED_UNIT(UNIT) ((UNIT == 0) ? 1 : 0)
#define SOC_ADC_PERIPH_NUM (2)
#define SOC_ADC_CHANNEL_NUM(PERIPH_NUM) (10)
#define SOC_ADC_MAX_CHANNEL_NUM (10)
#define SOC_ADC_ATTEN_NUM (4)
#define SOC_ADC_PATT_LEN_MAX (24)
#define SOC_ADC_DIGI_MIN_BITWIDTH (12)
#define SOC_ADC_DIGI_MAX_BITWIDTH (12)
#define SOC_ADC_DIGI_RESULT_BYTES (4)
#define SOC_ADC_DIGI_DATA_BYTES_PER_CONV (4)
#define SOC_ADC_SAMPLE_FREQ_THRES_HIGH 83333
#define SOC_ADC_SAMPLE_FREQ_THRES_LOW 611
