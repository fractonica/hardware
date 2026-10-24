// Host shim (firmware/test/host/shim/esp_sim.hpp): s3k-fixture's sdkconfig, as far as the fixture drivers read it.
#pragma once

#define CONFIG_IDF_TARGET_ESP32S3 1
#define CONFIG_FREERTOS_NUMBER_OF_CORES 2
#define CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD 1  // fixture_gpio's driver.yaml `sdkconfig` list
#define CONFIG_ESP_TIMER_IN_IRAM 1
// CONFIG_RMT_RX_ISR_CACHE_SAFE is not set
