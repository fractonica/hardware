# dvp_camera (design camera-c1 D9): hal::Camera over espressif/esp32-camera (the managed component's name is
# espressif__esp32-camera). Drivers are the only code that includes esp_camera.h (spec 03 §3.2); the public header exposes
# fr_core types only. esp_driver_ledc: XCLK; esp_timer: the frame timestamps; esp_driver_gpio: the power-down pin at stop().
idf_component_register(SRCS "src/dvp_camera.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core
                       PRIV_REQUIRES espressif__esp32-camera esp_driver_ledc esp_driver_gpio esp_timer)
