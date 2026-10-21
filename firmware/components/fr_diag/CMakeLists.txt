# Serial command channel (design c2 §5, spec 09 §9.7). It sits below fr_core, which starts it and
# implements fr::diag::Host, so fr_core can bring up the whole channel from fr::core::start().
idf_component_register(SRCS "src/diag.cpp" "src/restart.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_caps fr_id
                       PRIV_REQUIRES fr_proto fr_serial app_update esp_app_format esp_timer)
