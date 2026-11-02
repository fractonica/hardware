# espnow_tx (design csi-c1 D9): hal::RadioTx on the chip's own Wi-Fi radio, through fr_net's ESP-NOW layer (the hub
# link shares the radio and the peer table). Drivers are the only code that includes esp_now.h (spec 03 §3.2); the
# public header exposes fr_core types only.
idf_component_register(SRCS "src/espnow_tx.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES fr_net esp_wifi esp_timer)
