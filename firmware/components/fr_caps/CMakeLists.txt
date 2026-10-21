# Capability base classes (hand-written include/) and the per-capability interfaces, codecs and
# dispatch `fr gen` writes to gen/. Host-buildable; gen/diag_json.cpp also needs cJSON.
# CONFIGURE_DEPENDS is an error in the script-mode requirements scan (early expansion).
set(glob_flags "")
if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    set(glob_flags CONFIGURE_DEPENDS)
endif()
file(GLOB gen_srcs ${glob_flags} "${CMAKE_CURRENT_LIST_DIR}/gen/*.cpp")

# diag_json.cpp is compiled in every build: diag `caps` prints traits through it. Its `call` codecs
# are under #if FR_TEST_HOOKS inside the file.
set(srcs "src/capability.cpp" ${gen_srcs})

set(include_dirs "include")
if(IS_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/gen")
    list(APPEND include_dirs "gen")
endif()

# cJSON comes from espressif/cjson (idf_component.yml; IDF 6 removed its json component).
idf_component_register(SRCS ${srcs}
                       INCLUDE_DIRS ${include_dirs}
                       REQUIRES fr_proto)

# PUBLIC: `visibility: test` members change the generated classes' vtables, so every component that
# includes them must agree on the value.
if(CONFIG_FR_TEST_HOOKS)
    target_compile_definitions(${COMPONENT_LIB} PUBLIC FR_TEST_HOOKS=1)
else()
    target_compile_definitions(${COMPONENT_LIB} PUBLIC FR_TEST_HOOKS=0)
endif()
