# Core task, input slots, timers, L1 HAL contracts, L2 services and boot (spec 03 §3.3, design c2 §5).
# src/services is IDF-free: the host suite (firmware/test/host) builds the same files.
idf_component_register(SRCS "src/core.cpp"
                            "src/esp_core.cpp"
                            "src/input_slot_isr.cpp"
                            "src/services/button_service.cpp"
                            "src/services/envelope_link.cpp"
                            "src/services/led_service.cpp"
                       INCLUDE_DIRS "include"
                       # Public: the generated capability classes (and fr_caps' FR_TEST_HOOKS definition,
                       # which changes their vtables) reach every component that includes fr_core.
                       REQUIRES fr_caps fr_id fr_proto
                       # fr_serial and fr_diag sit below fr_core: start() brings them up.
                       PRIV_REQUIRES fr_serial fr_diag app_update esp_app_format esp_partition esp_system
                                     esp_timer espcoredump nvs_flash
                       LDFRAGMENTS "linker.lf")
