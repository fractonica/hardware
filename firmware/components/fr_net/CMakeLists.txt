# Hub link (design c3 §3, spec 05 §5.8-5.12). src/core is IDF-free (sessions, windows, retries, presence;
# the host suite in firmware/test/host builds it); src/esp holds the links (Wi-Fi STA, TCP and UDP sockets,
# mDNS resolution of hub_host) and is built only by IDF.
# CONFIGURE_DEPENDS is an error in the script-mode requirements scan (early expansion).
set(glob_flags "")
if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    set(glob_flags CONFIGURE_DEPENDS)
endif()
file(GLOB core_srcs ${glob_flags} "${CMAKE_CURRENT_LIST_DIR}/src/core/*.cpp")
file(GLOB esp_srcs ${glob_flags} "${CMAKE_CURRENT_LIST_DIR}/src/esp/*.cpp")

# Public: net.hpp includes fr::Core (fr_core), cap::Sink/Reply (fr_caps) and the protocol constants
# (fr_proto); src/esp/include (fr/net/esp.hpp, the links fr_core attaches) takes fr_id's credential types.
# fr_core in turn runs Net, a cycle IDF links by repeating the libraries.
# Private: what the links run on. espressif/mdns comes from idf_component.yml (private).
idf_component_register(SRCS ${core_srcs} ${esp_srcs}
                       INCLUDE_DIRS "include" "src/esp/include"
                       REQUIRES fr_caps fr_core fr_proto fr_id
                       PRIV_REQUIRES esp_wifi esp_netif esp_event lwip vfs esp_timer)
