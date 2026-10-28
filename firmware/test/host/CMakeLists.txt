# Host C++ suite (design c2 §8, c3 §5, c4 §5): fr_proto, fr_caps, the fr_core services, the fr_net and fr_ota cores
# built without ESP-IDF, under ASan + UBSan. `pnpm test:host` configures, builds and runs it through
# tools/host-test.mjs. Sources are globbed, so later work only drops files into the listed directories.
# M2-C2 (design m2-c2 D1, D14) adds the T2 fleet kit (sim/, library fr_sim) and fr_fleet, which
# `host-test.mjs --fleet` builds alone into build/host-fleet without sanitizers (FR_HOST_SANITIZE=OFF).
cmake_minimum_required(VERSION 3.24)

# Homebrew clang 22: one C++23 toolchain on every Mac (Apple clang lags on the library side).
if(NOT DEFINED CMAKE_CXX_COMPILER AND EXISTS /opt/homebrew/opt/llvm/bin/clang++)
    set(CMAKE_CXX_COMPILER /opt/homebrew/opt/llvm/bin/clang++)
    set(CMAKE_C_COMPILER /opt/homebrew/opt/llvm/bin/clang)
endif()

project(fr_host_tests LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

cmake_path(ABSOLUTE_PATH CMAKE_CURRENT_LIST_DIR NORMALIZE OUTPUT_VARIABLE HOST_DIR)
cmake_path(GET HOST_DIR PARENT_PATH TEST_DIR)
cmake_path(GET TEST_DIR PARENT_PATH FW_DIR)
cmake_path(GET FW_DIR PARENT_PATH REPO_DIR)
set(COMPONENTS_DIR ${FW_DIR}/components)
# The HIL fixture drivers (design m2-c1-hil D4): their public headers and fixture_gpio's private edge_ring.hpp, for
# the fixture tests and for fr_net_node's fake fixture lines. The suite also builds their .cpp files unchanged over
# the IDF shim in shim/ (fr_fixture_sim below), so FixtureService's tests run the drivers' own code.
set(FR_FIXTURE_INCLUDES
    ${REPO_DIR}/hardware/drivers/fixture_gpio/include
    ${REPO_DIR}/hardware/drivers/fixture_gpio/src
    ${REPO_DIR}/hardware/drivers/fixture_ws2812_rx/include)

# -fno-sanitize-recover: a UBSan finding fails the run instead of scrolling past. OFF only for the fleet build: the
# T2 gates time a 30-node fr_fleet, and ASan costs it about 2-3x CPU (design m2-c2 D14).
option(FR_HOST_SANITIZE "Build under ASan + UBSan" ON)
set(FR_SANITIZE "")
if(FR_HOST_SANITIZE)
    set(FR_SANITIZE -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
endif()
add_compile_options(-g ${FR_SANITIZE})
add_link_options(${FR_SANITIZE})

# Homebrew clang compiles against its own libc++ headers; link the matching library.
if(APPLE AND EXISTS /opt/homebrew/opt/llvm/lib/c++)
    add_link_options(-L/opt/homebrew/opt/llvm/lib/c++ -Wl,-rpath,/opt/homebrew/opt/llvm/lib/c++)
endif()

set(FR_CXX_WARNINGS -Wall -Wextra -Werror)
set(FR_CXX_FLAGS "$<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions;-fno-rtti>")

# fr_net/src/core and fr_ota/src/core are IDF-free like fr_core/src/services (design c3 §3, c4 §3); their
# src/esp directories are not built here. fr_gw (the gateway's bridge, design m2-c4-gateway D8) is IDF-free whole.
# fr_ota/src/http is the image GET over BSD sockets, the same source on lwIP and POSIX: fr_net_node downloads
# with it. fr_core/src/services includes FixtureService (design m2-c1-hil D3), so every target below links it; a
# target that uses it defines fr::core::link_info() (fr/core/node_net.hpp), which core.cpp defines on target:
# fr_net_node in tools/net_node.cpp, the suite in
# tests/fixture_link.cpp.
file(GLOB FR_LIB_SRCS CONFIGURE_DEPENDS
    ${COMPONENTS_DIR}/fr_proto/src/*.cpp
    ${COMPONENTS_DIR}/fr_proto/gen/*.cpp
    ${COMPONENTS_DIR}/fr_caps/src/*.cpp
    ${COMPONENTS_DIR}/fr_caps/gen/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/services/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/display/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/host/*.cpp
    ${COMPONENTS_DIR}/fr_net/src/core/*.cpp
    ${COMPONENTS_DIR}/fr_gw/src/*.cpp
    ${COMPONENTS_DIR}/fr_ota/src/core/*.cpp
    ${COMPONENTS_DIR}/fr_ota/src/http/*.cpp)
file(GLOB FR_TEST_SRCS CONFIGURE_DEPENDS ${HOST_DIR}/tests/*.cpp)
file(GLOB FR_FUZZ_SRCS CONFIGURE_DEPENDS ${HOST_DIR}/fuzz/*.cpp)
# Fuzz targets are also linked into the test binary, which checks their digests against the TS suite.
set(FR_FUZZ_TARGET_SRCS ${FR_FUZZ_SRCS})
list(FILTER FR_FUZZ_TARGET_SRCS EXCLUDE REGEX "/fuzz/main\\.cpp$")

add_library(fr_host_lib STATIC ${FR_LIB_SRCS})
target_include_directories(fr_host_lib PUBLIC
    ${COMPONENTS_DIR}/fr_proto/include
    ${COMPONENTS_DIR}/fr_proto/gen
    ${COMPONENTS_DIR}/fr_caps/include
    ${COMPONENTS_DIR}/fr_caps/gen
    ${COMPONENTS_DIR}/fr_core/include
    ${COMPONENTS_DIR}/fr_net/include
    ${COMPONENTS_DIR}/fr_gw/include
    ${COMPONENTS_DIR}/fr_ota/include
    ${HOST_DIR}
    ${HOST_DIR}/gen)
target_compile_definitions(fr_host_lib PUBLIC FR_TEST_HOOKS=1)
target_compile_options(fr_host_lib PUBLIC "${FR_CXX_FLAGS}" PRIVATE ${FR_CXX_WARNINGS})

# cJSON for gen/diag_json.cpp: the pinned copy in third_party/cjson (the version the firmware's
# espressif/cjson component carries; see its PROVENANCE), so a fresh checkout needs neither an IDF install
# nor managed_components. FR_CJSON_DIR (a directory holding cJSON.c and cJSON.h) overrides it.
set(FR_CJSON_DIR ${HOST_DIR}/third_party/cjson)
if(DEFINED ENV{FR_CJSON_DIR})
    set(FR_CJSON_DIR $ENV{FR_CJSON_DIR})
endif()
if(NOT EXISTS ${FR_CJSON_DIR}/cJSON.c)
    message(FATAL_ERROR "cJSON not found in ${FR_CJSON_DIR}")
endif()
add_library(fr_cjson STATIC ${FR_CJSON_DIR}/cJSON.c)
target_include_directories(fr_cjson PUBLIC ${FR_CJSON_DIR})
# Third-party C: its sprintf deprecation warnings are not ours to fix.
target_compile_options(fr_cjson PRIVATE -w)
target_link_libraries(fr_host_lib PUBLIC fr_cjson)

# fixture_gpio.cpp and ws2812_rx.cpp as the fixture's image builds them (with fr_core's shared GPIO ISR installer,
# src/gpio_isr.cpp, which esp_sim::reset() resets), against shim/idf (the IDF calls they make,
# on FakeCore's clock: shim/esp_sim.cpp). Only the test binary links it; shim/esp_sim.hpp is the tests' side.
add_library(fr_fixture_sim STATIC
    ${HOST_DIR}/shim/esp_sim.cpp
    ${COMPONENTS_DIR}/fr_core/src/gpio_isr.cpp
    ${REPO_DIR}/hardware/drivers/fixture_gpio/src/fixture_gpio.cpp
    ${REPO_DIR}/hardware/drivers/fixture_ws2812_rx/src/ws2812_rx.cpp)
target_include_directories(fr_fixture_sim PRIVATE ${HOST_DIR}/shim/idf PUBLIC ${HOST_DIR}/shim ${FR_FIXTURE_INCLUDES})
target_compile_definitions(fr_fixture_sim PRIVATE FR_HOST_SHIM=1)
target_link_libraries(fr_fixture_sim PUBLIC fr_host_lib)
target_compile_options(fr_fixture_sim PRIVATE ${FR_CXX_WARNINGS})

# The display and touch drivers (design m2-c5-display D4, D7, D8) and fr_core's shared I2C buses, unchanged, against
# shim/idf's I2C and SPI (shim/panel_sim.cpp) and esp_sim's GPIO, LEDC and esp_timer: the tests check the bytes the
# drivers put on the bus.
set(FR_PANEL_INCLUDES
    ${REPO_DIR}/hardware/drivers/st7789_spi/include
    ${REPO_DIR}/hardware/drivers/ssd1306_i2c/include
    ${REPO_DIR}/hardware/drivers/cst816_i2c/include)
add_library(fr_panel_sim STATIC
    ${HOST_DIR}/shim/panel_sim.cpp
    ${COMPONENTS_DIR}/fr_core/src/i2c_bus.cpp
    ${REPO_DIR}/hardware/drivers/st7789_spi/src/st7789_spi.cpp
    ${REPO_DIR}/hardware/drivers/ssd1306_i2c/src/ssd1306_i2c.cpp
    ${REPO_DIR}/hardware/drivers/cst816_i2c/src/cst816_i2c.cpp)
target_include_directories(fr_panel_sim PRIVATE ${HOST_DIR}/shim/idf PUBLIC ${HOST_DIR}/shim ${FR_PANEL_INCLUDES})
target_compile_definitions(fr_panel_sim PRIVATE FR_HOST_SHIM=1)
target_link_libraries(fr_panel_sim PUBLIC fr_fixture_sim fr_host_lib)
target_compile_options(fr_panel_sim PRIVATE ${FR_CXX_WARNINGS})

# The T2 fleet kit (design m2-c2 §3 item 5, D1-D8; namespace frsim): the N-node medium, each node's radio over the
# real air::Scheduler, a core per node and the executor, and the node classes fr_net_node and fr_fleet share. The
# driver's air_sched.hpp is private to fr_net/src/esp, so only this library gets that directory. Threads: the wall
# mode's worker strands for blocking OTA downloads (D1).
find_package(Threads REQUIRED)
file(GLOB FR_SIM_SRCS CONFIGURE_DEPENDS ${HOST_DIR}/sim/*.cpp)
add_library(fr_sim STATIC ${FR_SIM_SRCS})
target_include_directories(fr_sim PUBLIC ${HOST_DIR} PRIVATE ${COMPONENTS_DIR}/fr_net/src/esp)
target_link_libraries(fr_sim PUBLIC fr_host_lib Threads::Threads)
target_compile_options(fr_sim PRIVATE ${FR_CXX_WARNINGS})

add_executable(fr_host_tests ${FR_TEST_SRCS} ${FR_FUZZ_TARGET_SRCS})
target_link_libraries(fr_host_tests PRIVATE fr_sim fr_panel_sim fr_fixture_sim fr_host_lib)
target_include_directories(fr_host_tests PRIVATE ${FR_FIXTURE_INCLUDES})
target_compile_options(fr_host_tests PRIVATE ${FR_CXX_WARNINGS})

add_executable(fr_host_fuzz ${FR_FUZZ_SRCS})
target_link_libraries(fr_host_fuzz PRIVATE fr_host_lib)
target_compile_options(fr_host_fuzz PRIVATE ${FR_CXX_WARNINGS})

# fr_net_node: the fr_net core and the real services over POSIX TCP/UDP, a node for interop runs against a
# hub on loopback (packages/hub/test/interop.test.ts and the C3 loopback check; design c3 §5), with the real
# fr_ota core (interop-ota.test.ts, design c4 §5) and, with --air-dir, a fake ESP-NOW medium between
# several such processes under the real driver's send discipline (interop-air.test.ts, design c5 §5).
add_executable(fr_net_node ${HOST_DIR}/tools/net_node.cpp)
target_link_libraries(fr_net_node PRIVATE fr_sim fr_host_lib)
target_include_directories(fr_net_node PRIVATE ${FR_FIXTURE_INCLUDES})  # --fixture's fake lines (design m2-c1-hil §4 S2)
target_compile_options(fr_net_node PRIVATE ${FR_CXX_WARNINGS})

# fr_fleet (design m2-c2 D1, D8): N nodes, the medium, an AP model and the executor in one process against a
# private hub, for the T2-*-30 gates. Its contract (spec file, ready line, control lines) is in tools/fleet.cpp.
add_executable(fr_fleet ${HOST_DIR}/tools/fleet.cpp)
target_link_libraries(fr_fleet PRIVATE fr_sim fr_host_lib)
target_compile_options(fr_fleet PRIVATE ${FR_CXX_WARNINGS})
