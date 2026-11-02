// Host shim (firmware/test/host/shim/adc_sim.hpp): hal/adc_types.h (IDF v6.1: components/esp_hal_ana_conv/include/hal),
// as far as hardware/drivers/adc_audio uses it, with v6.1's names, values and field order, and the ESP32-S3's
// adc_digi_output_data_t (the TYPE2 result word: data 12, reserved 1, channel 4, unit 1).
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_attr.h"
#include "soc/soc_caps.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    ADC_UNIT_1,
    ADC_UNIT_2,
} adc_unit_t;

typedef enum {
    ADC_CHANNEL_0,
    ADC_CHANNEL_1,
    ADC_CHANNEL_2,
    ADC_CHANNEL_3,
    ADC_CHANNEL_4,
    ADC_CHANNEL_5,
    ADC_CHANNEL_6,
    ADC_CHANNEL_7,
    ADC_CHANNEL_8,
    ADC_CHANNEL_9,
    ADC_CHANNEL_10,
} adc_channel_t;

typedef enum {
    ADC_ATTEN_DB_0 = 0,
    ADC_ATTEN_DB_2_5 = 1,
    ADC_ATTEN_DB_6 = 2,
    ADC_ATTEN_DB_12 = 3,
} adc_atten_t;

typedef enum {
    ADC_BITWIDTH_DEFAULT = 0,
    ADC_BITWIDTH_9 = 9,
    ADC_BITWIDTH_10 = 10,
    ADC_BITWIDTH_11 = 11,
    ADC_BITWIDTH_12 = 12,
    ADC_BITWIDTH_13 = 13,
} adc_bitwidth_t;

typedef enum {
    ADC_CONV_SINGLE_UNIT_1 = 1,
    ADC_CONV_SINGLE_UNIT_2 = 2,
    ADC_CONV_BOTH_UNIT = 3,
    ADC_CONV_ALTER_UNIT = 7,
} adc_digi_convert_mode_t;

typedef enum {
    ADC_DIGI_OUTPUT_FORMAT_TYPE1,
    ADC_DIGI_OUTPUT_FORMAT_TYPE2,
} adc_digi_output_format_t;

typedef struct {
    uint8_t atten;
    uint8_t channel;
    uint8_t unit;
    uint8_t bit_width;
} adc_digi_pattern_config_t;

/** The ESP32-S3's (SOC_IS(ESP32S3)): one 4-byte conversion result in the DMA buffer. */
typedef struct {
    union {
        struct {
            uint32_t data : 12;
            uint32_t reserved12 : 1;
            uint32_t channel : 4;
            uint32_t unit : 1;
            uint32_t reserved17_31 : 14;
        } type2;
        uint32_t val;
    };
} adc_digi_output_data_t;

#ifdef __cplusplus
}
#endif
