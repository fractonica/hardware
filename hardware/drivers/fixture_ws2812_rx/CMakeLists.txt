# fixture_ws2812_rx (design m2-c1-hil D4): hal::FixtureLine that decodes a DUT's WS2812 data with RMT RX. The
# public header exposes fr_core types only (the RMT handle is forward-declared); decode() is IDF-free, so the
# host suite tests it.
idf_component_register(SRCS "src/ws2812_rx.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_driver_gpio esp_driver_rmt esp_timer)
