# Generic Fractonica node runtime. Built per profile through `fr build`, which passes the
# layered SDKCONFIG_DEFAULTS (framework, app, generated board fragment, build type).
cmake_minimum_required(VERSION 3.22)
set(EXTRA_COMPONENT_DIRS ${CMAKE_CURRENT_LIST_DIR}/../../components)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
idf_build_set_property(DEPENDENCIES_LOCK ${CMAKE_CURRENT_LIST_DIR}/dependencies.lock.${IDF_TARGET})
project(fr_node)
