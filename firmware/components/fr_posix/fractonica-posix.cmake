# Fractonica on a POSIX host (design uno-q-host §2.5 step 2): the IDF-free framework (fr_proto, fr_caps, the fr_core
# services and display backends, the fr_net core) and fr_posix (core loop, hub links, fr.node, persistence) as one
# static library, `fr_posix`, for a Linux node's application to link. Include this file from the application's
# CMakeLists.txt; it finds the checkout from its own location. The host test suite (firmware/test/host) keeps its own
# build of the same sources.
#
#   include(<checkout>/firmware/components/fr_posix/fractonica-posix.cmake)
#   target_link_libraries(my-node PRIVATE fr_posix)
#
# FR_POSIX_TEST_HOOKS (default ON) builds the framework with FR_TEST_HOOKS, as the ESP32 debug builds are: inject,
# snapshot and the diag JSON codecs, which the hub's display_snapshot and input_simulate need.
include_guard(GLOBAL)

cmake_path(GET CMAKE_CURRENT_LIST_DIR PARENT_PATH _fr_components)
set(FR_COMPONENTS_DIR ${_fr_components} CACHE INTERNAL "")
cmake_path(GET _fr_components PARENT_PATH _fr_firmware)

option(FR_POSIX_TEST_HOOKS "Build Fractonica with FR_TEST_HOOKS (debug-build features)" ON)

if(NOT CMAKE_CXX_STANDARD)
    set(CMAKE_CXX_STANDARD 23)
    set(CMAKE_CXX_STANDARD_REQUIRED ON)
    set(CMAKE_CXX_EXTENSIONS OFF)
endif()

file(GLOB _fr_posix_srcs CONFIGURE_DEPENDS
    ${_fr_components}/fr_proto/src/*.cpp
    ${_fr_components}/fr_proto/gen/*.cpp
    ${_fr_components}/fr_caps/src/*.cpp
    ${_fr_components}/fr_caps/gen/*.cpp
    ${_fr_components}/fr_core/src/services/*.cpp
    ${_fr_components}/fr_core/src/display/*.cpp
    ${_fr_components}/fr_core/src/audio/*.cpp
    ${_fr_components}/fr_core/src/stream/*.cpp
    ${_fr_components}/fr_core/src/host/*.cpp
    ${_fr_components}/fr_net/src/core/*.cpp
    # The image GET/POST over BSD sockets (the same source on lwIP and POSIX): the audio and camera services use it.
    ${_fr_components}/fr_ota/src/http/*.cpp
    ${_fr_components}/fr_posix/src/*.cpp)

# cJSON for fr_caps/gen/diag_json.cpp: the pinned copy the host suite uses (see its PROVENANCE).
set(_fr_cjson ${_fr_firmware}/test/host/third_party/cjson)
add_library(fr_posix_cjson STATIC ${_fr_cjson}/cJSON.c)
target_include_directories(fr_posix_cjson PUBLIC ${_fr_cjson})
target_compile_options(fr_posix_cjson PRIVATE -w)

find_package(Threads REQUIRED)

add_library(fr_posix STATIC ${_fr_posix_srcs})
target_include_directories(fr_posix PUBLIC
    ${_fr_components}/fr_proto/include
    ${_fr_components}/fr_proto/gen
    ${_fr_components}/fr_caps/include
    ${_fr_components}/fr_caps/gen
    ${_fr_components}/fr_core/include
    ${_fr_components}/fr_net/include
    ${_fr_components}/fr_ota/include
    ${_fr_components}/fr_posix/include)
if(FR_POSIX_TEST_HOOKS)
    target_compile_definitions(fr_posix PUBLIC FR_TEST_HOOKS=1)
endif()
target_compile_options(fr_posix PUBLIC "$<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions;-fno-rtti>" PRIVATE -Wall -Wextra)
target_link_libraries(fr_posix PUBLIC fr_posix_cjson Threads::Threads)
