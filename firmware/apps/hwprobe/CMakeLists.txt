# Fractonica hardware probe (M0): identifies a board's display, LED, button, Wi-Fi link and
# latency to the hub host. Standalone ESP-IDF app; does not depend on the framework.
cmake_minimum_required(VERSION 3.22)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
project(hwprobe)
