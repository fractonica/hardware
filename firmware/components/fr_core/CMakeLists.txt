idf_component_register(SRCS "src/core.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_id
                       PRIV_REQUIRES app_update esp_app_format esp_partition esp_system esp_timer espcoredump)
