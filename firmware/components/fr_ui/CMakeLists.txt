# fr.display's LVGL backend (design m2-c5-display D3, D5): fr::ui::LvglBackend over the pinned LVGL (idf_component.yml).
# src/ (but src/esp) is IDF-free: tools/display builds the same files with src/host on the Mac. One lv_conf.h
# (config/) for both builds, through LV_CONF_PATH. LV_KCONFIG_IGNORE alone does not keep menuconfig's CONFIG_LV_* out
# of LVGL on IDF 6.1 (picolibc's stdint.h includes sdkconfig.h): lv_conf.h sets every option LVGL would take from them,
# and tools/display/lv-conf-check.mjs checks that against a build.
idf_component_register(SRCS "src/engine.cpp"
                            "src/lvgl_backend.cpp"
                            "src/esp/runtime.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_INCLUDE_DIRS "src"
                       REQUIRES fr_core fr_caps
                       PRIV_REQUIRES esp_timer freertos heap log)

if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    idf_component_get_property(lvgl_lib lvgl__lvgl COMPONENT_LIB)
    target_compile_definitions(${lvgl_lib} PUBLIC "LV_CONF_PATH=\"${CMAKE_CURRENT_LIST_DIR}/config/lv_conf.h\""
                                                  LV_KCONFIG_IGNORE)
    # lv_conf.h's LV_MEM_POOL_INCLUDE: the pool from PSRAM (config/fr_ui_pool.h).
    target_include_directories(${lvgl_lib} PRIVATE "${CMAKE_CURRENT_LIST_DIR}/config")
    # LVGL is third-party C: its warnings are not ours to fix.
    target_compile_options(${lvgl_lib} PRIVATE -w)
endif()
