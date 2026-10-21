# Generic Fractonica node runtime. Built per profile through `fr build`, which runs `fr gen firmware`
# and passes -DFR_GEN_DIR=<build>/fr_gen and the layered SDKCONFIG_DEFAULTS (framework, app, generated
# board fragment, build type).
cmake_minimum_required(VERSION 3.22)

# The composition root (fr_board) and the profile's drivers come from the generated directory; without
# it there is no profile to build.
if(NOT FR_GEN_DIR)
    message(FATAL_ERROR "FR_GEN_DIR is not set. Build with `fr build --profile <profile>`, which generates "
                        "<build>/fr_gen with `fr gen firmware` and passes -DFR_GEN_DIR.")
endif()
if(NOT EXISTS "${FR_GEN_DIR}/components.cmake")
    message(FATAL_ERROR "${FR_GEN_DIR}/components.cmake not found: run `fr gen firmware --profile <profile> "
                        "--out ${FR_GEN_DIR}` (or `fr build`, which does it).")
endif()

# Framework components plus what the profile binds: fr_board and only the bound drivers (spec 03 §3.8).
set(EXTRA_COMPONENT_DIRS ${CMAKE_CURRENT_LIST_DIR}/../../components)
include(${FR_GEN_DIR}/components.cmake)
if(NOT FR_PROFILE)
    message(FATAL_ERROR "${FR_GEN_DIR}/components.cmake does not set FR_PROFILE: it predates the per-profile "
                        "dependency lock; regenerate it with `fr gen firmware` (or `fr build`).")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
# One committed lock per profile, not per target: the registry dependencies come from the bound drivers,
# which differ between profiles of one target (c6-pad pulls espressif/led_strip, c6-pad-mono does not).
idf_build_set_property(DEPENDENCIES_LOCK ${CMAKE_CURRENT_LIST_DIR}/dependencies.lock.${FR_PROFILE})
project(fr_node)
