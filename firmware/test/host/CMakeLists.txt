# Host C++ suite (design c2 §8, c3 §5, c4 §5): fr_proto, fr_caps, the fr_core services, the fr_net and fr_ota cores
# built without ESP-IDF, under ASan + UBSan. `pnpm test:host` configures, builds and runs it through
# tools/host-test.mjs. Sources are globbed, so later work only drops files into the listed directories.
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
set(COMPONENTS_DIR ${FW_DIR}/components)

# -fno-sanitize-recover: a UBSan finding fails the run instead of scrolling past.
set(FR_SANITIZE -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
add_compile_options(-g ${FR_SANITIZE})
add_link_options(${FR_SANITIZE})

# Homebrew clang compiles against its own libc++ headers; link the matching library.
if(APPLE AND EXISTS /opt/homebrew/opt/llvm/lib/c++)
    add_link_options(-L/opt/homebrew/opt/llvm/lib/c++ -Wl,-rpath,/opt/homebrew/opt/llvm/lib/c++)
endif()

set(FR_CXX_WARNINGS -Wall -Wextra -Werror)
set(FR_CXX_FLAGS "$<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions;-fno-rtti>")

# fr_net/src/core and fr_ota/src/core are IDF-free like fr_core/src/services (design c3 §3, c4 §3); their
# src/esp directories are not built here. fr_ota/src/http is the image GET over BSD sockets, the same source
# on lwIP and POSIX: fr_net_node downloads with it.
file(GLOB FR_LIB_SRCS CONFIGURE_DEPENDS
    ${COMPONENTS_DIR}/fr_proto/src/*.cpp
    ${COMPONENTS_DIR}/fr_proto/gen/*.cpp
    ${COMPONENTS_DIR}/fr_caps/src/*.cpp
    ${COMPONENTS_DIR}/fr_caps/gen/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/services/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/host/*.cpp
    ${COMPONENTS_DIR}/fr_net/src/core/*.cpp
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

add_executable(fr_host_tests ${FR_TEST_SRCS} ${FR_FUZZ_TARGET_SRCS})
target_link_libraries(fr_host_tests PRIVATE fr_host_lib)
target_compile_options(fr_host_tests PRIVATE ${FR_CXX_WARNINGS})

add_executable(fr_host_fuzz ${FR_FUZZ_SRCS})
target_link_libraries(fr_host_fuzz PRIVATE fr_host_lib)
target_compile_options(fr_host_fuzz PRIVATE ${FR_CXX_WARNINGS})

# fr_net_node: the fr_net core and the real services over POSIX TCP/UDP, a node for interop runs against a
# hub on loopback (packages/hub/test/interop.test.ts and the C3 loopback check; design c3 §5), with the real
# fr_ota core (interop-ota.test.ts, design c4 §5) and, with --air-dir, a fake ESP-NOW medium between
# several such processes under the real driver's send discipline (interop-air.test.ts, design c5 §5).
add_executable(fr_net_node ${HOST_DIR}/tools/net_node.cpp)
target_link_libraries(fr_net_node PRIVATE fr_host_lib)
target_compile_options(fr_net_node PRIVATE ${FR_CXX_WARNINGS})
