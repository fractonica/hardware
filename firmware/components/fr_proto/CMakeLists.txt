# Wire runtime (design c2 §3): hand-written src/ plus the codecs `fr gen` writes to gen/. No IDF
# includes, so firmware/test/host builds the same sources on the host.
# CONFIGURE_DEPENDS is an error in the script-mode requirements scan (early expansion).
set(glob_flags "")
if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    set(glob_flags CONFIGURE_DEPENDS)
endif()
file(GLOB srcs ${glob_flags} "${CMAKE_CURRENT_LIST_DIR}/src/*.cpp" "${CMAKE_CURRENT_LIST_DIR}/gen/*.cpp")

# IDF rejects a missing include directory; gen/ appears with the first `fr gen`.
set(include_dirs "include")
if(IS_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/gen")
    list(APPEND include_dirs "gen")
endif()

idf_component_register(SRCS ${srcs}
                       INCLUDE_DIRS ${include_dirs})
