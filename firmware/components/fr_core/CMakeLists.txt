# Core task, input slots, timers, fr_worker, L1 HAL contracts, L2 services, boot, the hub link wiring and
# fr_app_desc (spec 03 §3.3-3.5, 06 §6.8, design c2 §5, c3 §3, c4 §2). src/services and src/display (the fr.display
# backend contract and the mono renderer, design m2-c5-display D3) are IDF-free: the host suite (firmware/test/host)
# builds the same files (the services and the node descriptor). src/audio (design audio-a1 D5: the audio services' DSP,
# rings and fr_audio/fr_stream engine) is IDF-free too; src/audio_rt_esp.cpp is its FreeRTOS layer (src/host/audio_rt.cpp
# on the Mac). The audio services stream through fr_ota's src/http clients (HttpPost, HttpGet), hence fr_ota below.
# src/stream (design csi-c1 D11) is what every stream shares (fr/stream/stream.hpp), fr.csi's CsiService one of them;
# src/services/csi_record.cpp its ring and motion feature (fr/csi/csi.hpp). Both IDF-free. src/services/camera_service.cpp
# (design camera-c1 D8) is fr.camera over hal::Camera and its optional hal::BlockStore store, IDF-free too;
# src/services/scale_service.cpp (design scale-round-c1 D7) fr.scale over hal::LoadCell and hal::Settings, IDF-free;
# src/nvs_settings.cpp is hal::Settings in NVS (fr/platform/nvs_settings.hpp), its writes on fr_worker.
# src/services/battery_service.cpp and haptic_service.cpp (design power-p1 D2-D7) are fr.battery over hal::PowerCell
# and hal::Settings, and fr.haptic over hal::HapticOutput drawing from an fr.battery; both IDF-free.
# src/services/storage_service.cpp and clock_service.cpp (design lcd-clock-c1 D5-D8) are fr.storage over hal::FileStore
# and fr.clock over hal::Rtc; both IDF-free.
idf_component_register(SRCS "src/adc1.cpp"
                            "src/app_desc.cpp"
                            "src/audio/dsp.cpp"
                            "src/audio/engine.cpp"
                            "src/audio/rings.cpp"
                            "src/audio_rt_esp.cpp"
                            "src/core.cpp"
                            "src/display/crc32.cpp"
                            "src/display/font5x7.cpp"
                            "src/display/mono_backend.cpp"
                            "src/esp_core.cpp"
                            "src/esp_worker.cpp"
                            "src/gpio_isr.cpp"
                            "src/i2c_bus.cpp"
                            "src/input_slot_isr.cpp"
                            "src/nvs_settings.cpp"
                            "src/services/analog_in_service.cpp"
                            "src/services/audio_in_service.cpp"
                            "src/services/audio_out_service.cpp"
                            "src/services/battery_service.cpp"
                            "src/services/button_service.cpp"
                            "src/services/camera_service.cpp"
                            "src/services/clock_service.cpp"
                            "src/services/csi_record.cpp"
                            "src/services/csi_service.cpp"
                            "src/services/descriptor.cpp"
                            "src/services/display_service.cpp"
                            "src/services/fixture_service.cpp"
                            "src/services/haptic_service.cpp"
                            "src/services/led_service.cpp"
                            "src/services/radio_tx_service.cpp"
                            "src/services/scale_service.cpp"
                            "src/services/storage_service.cpp"
                            "src/services/touch_service.cpp"
                            "src/s2_hooks.cpp"
                            "src/safe_off.cpp"
                            "src/spi_bus.cpp"
                            "src/stream/stream.cpp"
                            "src/test_pin.cpp"
                       INCLUDE_DIRS "include"
                       # Public: the generated capability classes (and fr_caps' FR_TEST_HOOKS definition,
                       # which changes their vtables) reach every component that includes fr_core.
                       REQUIRES fr_caps fr_id fr_proto
                       # fr_serial and fr_diag sit below fr_core: start() brings them up. fr_net runs the hub
                       # link; it requires fr_core in turn (a cycle IDF links by repeating the libraries), as
                       # fr_ota does (its Kconfig also holds FR_TEST_FAULT_HEALTH, which fr_app_desc reports).
                       # esp_driver_gpio: the T-LAT test pin (src/test_pin.cpp, design c6 D24) and the one GPIO ISR
                       # service installer (src/gpio_isr.cpp, fr/platform/gpio_isr.hpp). esp_adc: the shared
                       # ADC1 unit (src/adc1.cpp, fr/platform/adc1.hpp) and the vitals' vbat_mv (design m2-c3-inputs
                       # D3, D11); adc_oneshot, the one other includer of fr/platform/adc1.hpp, requires it itself.
                       # fr_gw: the gateway's bridge (design m2-c4-gateway D8), which core.cpp builds in role gateway
                       # only (requirements cannot follow CONFIG_FR_ROLE, so every image compiles it; others link none
                       # of it). It requires fr_core in turn, a cycle like fr_net's.
                       # esp_driver_i2c: the shared I2C buses (src/i2c_bus.cpp, fr/platform/i2c_bus.hpp, design
                       # m2-c5-display D4, D8); its includers (ssd1306_i2c, cst816_i2c) require it themselves. esp_driver_spi: the shared
                       # SPI buses (src/spi_bus.cpp, fr/platform/spi_bus.hpp, design lcd-clock-c1 D3), likewise.
                       PRIV_REQUIRES fr_serial fr_diag fr_net fr_gw fr_ota app_update esp_app_format esp_partition
                                     esp_system esp_timer espcoredump nvs_flash esp_driver_gpio esp_adc esp_driver_i2c
                                     esp_driver_spi
                       LDFRAGMENTS "linker.lf")

# fr_app_desc is referenced by nothing: without this the linker would leave app_desc.cpp's object out of
# the image, and the hub's ingest would fail on a missing descriptor at offset 288 (spec 06 §6.8).
target_link_libraries(${COMPONENT_LIB} INTERFACE "-u fr_app_desc")

# The panic hook (src/safe_off.cpp, fr/platform/safe_off.hpp; design power-p1 review B1, m2-c1-hil D11 item 1): every
# image wraps esp_panic_handler so the drivers' registered outputs (fixture lines, haptic PWM, test loads, charge gates)
# go off before the backtrace, the coredump and the CPU reset that would keep them running; -u keeps the object linked.
target_link_options(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=esp_panic_handler" "-Wl,-u,__wrap_esp_panic_handler")
