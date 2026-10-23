# Core task, input slots, timers, fr_worker, L1 HAL contracts, L2 services, boot, the hub link wiring and
# fr_app_desc (spec 03 §3.3-3.5, 06 §6.8, design c2 §5, c3 §3, c4 §2). src/services is IDF-free: the host
# suite (firmware/test/host) builds the same files (the services and the node descriptor).
idf_component_register(SRCS "src/app_desc.cpp"
                            "src/core.cpp"
                            "src/esp_core.cpp"
                            "src/esp_worker.cpp"
                            "src/input_slot_isr.cpp"
                            "src/services/button_service.cpp"
                            "src/services/descriptor.cpp"
                            "src/services/led_service.cpp"
                            "src/test_pin.cpp"
                       INCLUDE_DIRS "include"
                       # Public: the generated capability classes (and fr_caps' FR_TEST_HOOKS definition,
                       # which changes their vtables) reach every component that includes fr_core.
                       REQUIRES fr_caps fr_id fr_proto
                       # fr_serial and fr_diag sit below fr_core: start() brings them up. fr_net runs the hub
                       # link; it requires fr_core in turn (a cycle IDF links by repeating the libraries), as
                       # fr_ota does (its Kconfig also holds FR_TEST_FAULT_HEALTH, which fr_app_desc reports).
                       # esp_driver_gpio: the T-LAT test pin (src/test_pin.cpp, design c6 D24).
                       PRIV_REQUIRES fr_serial fr_diag fr_net fr_ota app_update esp_app_format esp_partition
                                     esp_system esp_timer espcoredump nvs_flash esp_driver_gpio
                       LDFRAGMENTS "linker.lf")

# fr_app_desc is referenced by nothing: without this the linker would leave app_desc.cpp's object out of
# the image, and the hub's ingest would fail on a missing descriptor at offset 288 (spec 06 §6.8).
target_link_libraries(${COMPONENT_LIB} INTERFACE "-u fr_app_desc")
