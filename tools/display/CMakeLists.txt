# The desktop renderer (design m2-c5-display D5, D6): fr_display_render draws a script of fr.display commands at a
# panel's size, format and rotation into a PNG with the board's own code: fr_ui's LvglBackend over the same LVGL
# release and lv_conf.h as the firmware (ui panels), or fr_core's MonoBackend (mono1 panels), behind fr_core's
# DisplayService and TouchService, on a virtual clock. fr_display_tests checks it. `node tools/display-build.mjs`
# configures and builds this project into build/host-display (README.md has the renderer's contract).
cmake_minimum_required(VERSION 3.24)

# Homebrew clang, as the host suite (firmware/test/host): one C++23 toolchain on every Mac.
if(NOT DEFINED CMAKE_CXX_COMPILER AND EXISTS /opt/homebrew/opt/llvm/bin/clang++)
    set(CMAKE_CXX_COMPILER /opt/homebrew/opt/llvm/bin/clang++)
    set(CMAKE_C_COMPILER /opt/homebrew/opt/llvm/bin/clang)
endif()

project(fr_display LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_C_STANDARD 11)

cmake_path(ABSOLUTE_PATH CMAKE_CURRENT_LIST_DIR NORMALIZE OUTPUT_VARIABLE DISPLAY_DIR)
cmake_path(GET DISPLAY_DIR PARENT_PATH TOOLS_DIR)
cmake_path(GET TOOLS_DIR PARENT_PATH REPO_DIR)
set(COMPONENTS_DIR ${REPO_DIR}/firmware/components)
set(HOST_DIR ${REPO_DIR}/firmware/test/host)
set(FR_UI_DIR ${COMPONENTS_DIR}/fr_ui)

if(APPLE AND EXISTS /opt/homebrew/opt/llvm/lib/c++)
    add_link_options(-L/opt/homebrew/opt/llvm/lib/c++ -Wl,-rpath,/opt/homebrew/opt/llvm/lib/c++)
endif()

# ---- LVGL: the release fr_ui's idf_component.yml pins (lvgl/lvgl 9.6.0~1 = tag v9.6.0 + an IDF<6 fallback for the
# P4's PPA, which no build here compiles). The archive's SHA256 is pinned; the download is shared by every build dir.
include(FetchContent)
set(FR_LVGL_TAG v9.6.0)
set(FR_LVGL_SHA256 b20ee3acc1bba13c62d854f9ebd62e4c51e0b443b1e0225892e86442defa84df)
FetchContent_Declare(lvgl
    URL https://github.com/lvgl/lvgl/archive/refs/tags/${FR_LVGL_TAG}.tar.gz
    URL_HASH SHA256=${FR_LVGL_SHA256}
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    # LVGL's own CMake is not used: the sources are compiled below with fr_ui's lv_conf.h.
    SOURCE_SUBDIR fr-no-cmake
    SOURCE_DIR ${REPO_DIR}/build/_deps/lvgl-${FR_LVGL_TAG}
    SUBBUILD_DIR ${CMAKE_BINARY_DIR}/_deps/lvgl-subbuild
    BINARY_DIR ${CMAKE_BINARY_DIR}/_deps/lvgl-build)
FetchContent_MakeAvailable(lvgl)

file(GLOB_RECURSE FR_LVGL_SRCS CONFIGURE_DEPENDS ${lvgl_SOURCE_DIR}/src/*.c)
add_library(fr_lvgl STATIC ${FR_LVGL_SRCS})
target_include_directories(fr_lvgl PUBLIC ${lvgl_SOURCE_DIR})
# As on the board (fr_ui/CMakeLists.txt): fr_ui's lv_conf.h. The Mac has no sdkconfig.h; the board does, and lv_conf.h
# sets every option LVGL would take from it (lv-conf-check.mjs compares the two builds' effective LV_* values).
target_compile_definitions(fr_lvgl PUBLIC "LV_CONF_PATH=\"${FR_UI_DIR}/config/lv_conf.h\"" LV_KCONFIG_IGNORE)
# Third-party C, optimised (the renderer's pixels do not depend on it: integer code only, D5).
target_compile_options(fr_lvgl PRIVATE -w -O2)
# FR_LV_MEM_SIZE (bytes): a pool of a board's size instead of the Mac's 128 KB, for the heap tests (scale-round-c1 D4:
# 32768, the boards without PSRAM). Empty: the Mac's pool.
set(FR_LV_MEM_SIZE "" CACHE STRING "LVGL pool size in bytes (empty: lv_conf.h's)")
if(FR_LV_MEM_SIZE)
    target_compile_definitions(fr_lvgl PUBLIC FR_LV_MEM_SIZE=${FR_LV_MEM_SIZE})
endif()

# ---- Our code: ASan + UBSan (the host suite's flags), not on LVGL. ----
set(FR_SANITIZE -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
set(FR_CXX_WARNINGS -Wall -Wextra -Werror)
set(FR_CXX_FLAGS "$<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions;-fno-rtti>")

# fr_proto, fr_caps (codecs, dispatch, the JSON args codec), fr_core's display parts and services, fr_ui's IDF-free
# sources with its host runtime: the firmware's files, unchanged. Unused objects (other services) are not linked.
file(GLOB FR_LIB_SRCS CONFIGURE_DEPENDS
    ${COMPONENTS_DIR}/fr_proto/src/*.cpp
    ${COMPONENTS_DIR}/fr_proto/gen/*.cpp
    ${COMPONENTS_DIR}/fr_caps/src/*.cpp
    ${COMPONENTS_DIR}/fr_caps/gen/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/display/*.cpp
    ${COMPONENTS_DIR}/fr_core/src/services/display_service.cpp
    ${COMPONENTS_DIR}/fr_core/src/services/touch_service.cpp
    ${FR_UI_DIR}/src/*.cpp
    ${FR_UI_DIR}/src/host/*.cpp)
add_library(fr_display_lib STATIC ${FR_LIB_SRCS}
    ${DISPLAY_DIR}/src/session.cpp
    ${DISPLAY_DIR}/src/png.cpp)
target_include_directories(fr_display_lib PUBLIC
    ${COMPONENTS_DIR}/fr_proto/include
    ${COMPONENTS_DIR}/fr_proto/gen
    ${COMPONENTS_DIR}/fr_caps/include
    ${COMPONENTS_DIR}/fr_caps/gen
    ${COMPONENTS_DIR}/fr_core/include
    ${FR_UI_DIR}/include
    ${DISPLAY_DIR}/src
    PRIVATE ${FR_UI_DIR}/src)
# FR_TEST_HOOKS: snapshot and snapshot_read exist, as in the debug builds T-DISPLAY compares against.
target_compile_definitions(fr_display_lib PUBLIC FR_TEST_HOOKS=1)
target_compile_options(fr_display_lib PUBLIC "${FR_CXX_FLAGS}" ${FR_SANITIZE} PRIVATE ${FR_CXX_WARNINGS})
target_link_options(fr_display_lib PUBLIC ${FR_SANITIZE})

# cJSON for the script (fr_caps' generated JSON args codec): the host suite's pinned copy.
add_library(fr_display_cjson STATIC ${HOST_DIR}/third_party/cjson/cJSON.c)
target_include_directories(fr_display_cjson PUBLIC ${HOST_DIR}/third_party/cjson)
target_compile_options(fr_display_cjson PRIVATE -w)
# The PNG writer's deflate: the SDK's libz, linked by name (ZLIB::ZLIB would put the SDK's usr/include ahead of
# libc++'s headers as -isystem).
target_link_libraries(fr_display_lib PUBLIC fr_lvgl fr_display_cjson z)

# ---- fr_display_render, with the SDL2 window when Homebrew's SDL2 is there (pkg-config sdl2). ----
add_executable(fr_display_render ${DISPLAY_DIR}/src/main.cpp ${DISPLAY_DIR}/src/window.cpp)
target_link_libraries(fr_display_render PRIVATE fr_display_lib)
target_compile_options(fr_display_render PRIVATE ${FR_CXX_WARNINGS})
if(EXISTS /opt/homebrew/lib/pkgconfig)
    set(ENV{PKG_CONFIG_PATH} "/opt/homebrew/lib/pkgconfig:$ENV{PKG_CONFIG_PATH}")
endif()
find_package(PkgConfig QUIET)
if(PKG_CONFIG_FOUND)
    pkg_check_modules(SDL2 QUIET IMPORTED_TARGET sdl2)
endif()
if(SDL2_FOUND)
    message(STATUS "fr_display_render: --window with SDL2 ${SDL2_VERSION}")
    target_compile_definitions(fr_display_render PRIVATE FR_DISPLAY_SDL=1)
    target_link_libraries(fr_display_render PRIVATE PkgConfig::SDL2)
else()
    message(STATUS "fr_display_render: no SDL2 (pkg-config sdl2): --window answers with an error")
endif()

# ---- fr_display_tests: the host suite's framework (firmware/test/host/tests/main.cpp, test.hpp). ----
file(GLOB FR_DISPLAY_TEST_SRCS CONFIGURE_DEPENDS ${DISPLAY_DIR}/tests/*.cpp)
add_executable(fr_display_tests ${FR_DISPLAY_TEST_SRCS} ${HOST_DIR}/tests/main.cpp)
target_include_directories(fr_display_tests PRIVATE ${HOST_DIR})
target_link_libraries(fr_display_tests PRIVATE fr_display_lib)
target_compile_options(fr_display_tests PRIVATE ${FR_CXX_WARNINGS})
