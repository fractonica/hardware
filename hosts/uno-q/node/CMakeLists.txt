# qonu-node: the UNO Q as a Fractonica device (design docs/design/uno-q-host.md). Builds against the Fractonica
# checkout this folder lives in (FR_REPO, three levels up), through fr_posix.
cmake_minimum_required(VERSION 3.24)
project(qonu_node LANGUAGES C CXX)

set(FR_REPO ${CMAKE_CURRENT_LIST_DIR}/../../.. CACHE PATH "The Fractonica checkout")
if(NOT EXISTS ${FR_REPO}/firmware/components/fr_posix/fractonica-posix.cmake)
    message(FATAL_ERROR "No Fractonica checkout at FR_REPO=${FR_REPO}. In the qonu builder it is mounted at /fr "
                        "(the Makefile does this); pass -DFR_REPO=<checkout> otherwise.")
endif()
include(${FR_REPO}/firmware/components/fr_posix/fractonica-posix.cmake)

set(QONU_NODE_VERSION "0.1.0" CACHE STRING "qonu-node version (HELLO's fw prefix)")

add_executable(qonu-node src/main.cpp src/qonu_link.cpp src/qonu_hal.cpp)
target_compile_definitions(qonu-node PRIVATE QONU_NODE_VERSION="${QONU_NODE_VERSION}")
target_compile_options(qonu-node PRIVATE -Wall -Wextra)
target_link_libraries(qonu-node PRIVATE fr_posix)
install(TARGETS qonu-node DESTINATION bin)
