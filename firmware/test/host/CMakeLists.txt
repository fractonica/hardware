# Host C++ suite (design c2 §8): fr_proto, fr_caps and the fr_core services built without ESP-IDF,
# under ASan + UBSan. `pnpm test:host` configures, builds and runs it through tools/host-test.mjs.
# Sources are globbed, so later work only drops files into the listed directories.
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

file(GLOB FR_LIB_SRCS CONFIGURE_DEPENDS
    ${COMPONENTS_DIR}/fr_proto/src/*.cpp
    ${COMPONENTS_DIR}/fr_proto/gen/*.cpp
    ${COMPONENTS_DIR}/fr_caps/src/*.cpp
    ${COMPONENTS_DIR}/fr_caps/gen/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/services/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/host/*.cpp)
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
    ${HOST_DIR}
    ${HOST_DIR}/gen)
target_compile_definitions(fr_host_lib PUBLIC FR_TEST_HOOKS=1)
target_compile_options(fr_host_lib PUBLIC "${FR_CXX_FLAGS}" PRIVATE ${FR_CXX_WARNINGS})

# cJSON for gen/diag_json.cpp. IDF 6 dropped components/json in favour of espressif/cjson, so look in
# the old IDF location, then wherever the component manager put espressif/cjson (the version the
# firmware builds), then in any older IDF install (5.x still ships components/json), so a fresh checkout
# on a machine with IDF 5 needs no node build first.
set(FR_CJSON_CANDIDATES "")
if(DEFINED ENV{FR_CJSON_DIR})
    list(APPEND FR_CJSON_CANDIDATES $ENV{FR_CJSON_DIR})
endif()
if(DEFINED ENV{IDF_PATH})
    list(APPEND FR_CJSON_CANDIDATES $ENV{IDF_PATH}/components/json/cJSON)
else()
    list(APPEND FR_CJSON_CANDIDATES $ENV{HOME}/esp/v6.1/esp-idf/components/json/cJSON)
endif()
file(GLOB FR_CJSON_MANAGED
    ${FW_DIR}/apps/*/managed_components/espressif__cjson/cJSON
    $ENV{HOME}/Library/Caches/Espressif/ComponentManager/*/espressif__cjson_*/cJSON
    $ENV{HOME}/.cache/Espressif/ComponentManager/*/espressif__cjson_*/cJSON)
list(SORT FR_CJSON_MANAGED ORDER DESCENDING)
list(APPEND FR_CJSON_CANDIDATES ${FR_CJSON_MANAGED})
file(GLOB FR_CJSON_OLD_IDF $ENV{HOME}/esp/*/esp-idf/components/json/cJSON)
list(SORT FR_CJSON_OLD_IDF COMPARE NATURAL ORDER DESCENDING)
list(APPEND FR_CJSON_CANDIDATES ${FR_CJSON_OLD_IDF})
set(FR_CJSON_DIR "")
foreach(dir ${FR_CJSON_CANDIDATES})
    if(EXISTS ${dir}/cJSON.c)
        set(FR_CJSON_DIR ${dir})
        break()
    endif()
endforeach()

if(FR_CJSON_DIR)
    message(STATUS "cJSON: ${FR_CJSON_DIR}")
    add_library(fr_cjson STATIC ${FR_CJSON_DIR}/cJSON.c)
    target_include_directories(fr_cjson PUBLIC ${FR_CJSON_DIR})
    # Third-party C: its sprintf deprecation warnings are not ours to fix.
    target_compile_options(fr_cjson PRIVATE -w)
    target_link_libraries(fr_host_lib PUBLIC fr_cjson)
elseif(EXISTS ${COMPONENTS_DIR}/fr_caps/gen/diag_json.cpp)
    message(FATAL_ERROR "fr_caps/gen/diag_json.cpp needs cJSON, which was not found. Build a node "
                        "profile once (the component manager fetches espressif/cjson) or set FR_CJSON_DIR "
                        "to a directory containing cJSON.c.")
endif()

add_executable(fr_host_tests ${FR_TEST_SRCS} ${FR_FUZZ_TARGET_SRCS})
target_link_libraries(fr_host_tests PRIVATE fr_host_lib)
target_compile_options(fr_host_tests PRIVATE ${FR_CXX_WARNINGS})

add_executable(fr_host_fuzz ${FR_FUZZ_SRCS})
target_link_libraries(fr_host_fuzz PRIVATE fr_host_lib)
target_compile_options(fr_host_fuzz PRIVATE ${FR_CXX_WARNINGS})
