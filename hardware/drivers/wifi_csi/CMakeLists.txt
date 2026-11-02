# wifi_csi (design csi-c1 D7, D8): hal::CsiSource on the chip's own Wi-Fi radio. Drivers are the only code that
# includes esp_wifi.h and lwIP's ping (spec 03 §3.2); the public header exposes fr_core types only.
idf_component_register(SRCS "src/wifi_csi.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES esp_wifi esp_netif esp_timer lwip)
