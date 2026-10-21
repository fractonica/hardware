# OTA, node side (spec 06 §6.5-6.6, design c4 §3). src/core is IDF-free (CHECK, the job state machine,
# resume bookkeeping, the health gate) over the Flash, Fetch and Store interfaces, and the host suite in
# firmware/test/host builds it; src/http is the Fetch both sides use, an HTTP/1.1 GET over BSD sockets (lwIP
# here, POSIX on the host); src/esp implements the rest (esp_ota_ops, nvs:fr_ota) and is built only by IDF.
# CONFIGURE_DEPENDS is an error in the script-mode requirements scan (early expansion).
set(glob_flags "")
if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    set(glob_flags CONFIGURE_DEPENDS)
endif()
file(GLOB core_srcs ${glob_flags} "${CMAKE_CURRENT_LIST_DIR}/src/core/*.cpp")
file(GLOB http_srcs ${glob_flags} "${CMAKE_CURRENT_LIST_DIR}/src/http/*.cpp")
file(GLOB esp_srcs ${glob_flags} "${CMAKE_CURRENT_LIST_DIR}/src/esp/*.cpp")

# Public: ota.hpp takes fr::Core and fr::Worker (fr_core), net::OtaReply (fr_net) and the protocol
# constants (fr_proto); src/esp/include (fr/ota/esp.hpp, what fr_core binds Ota to) adds nothing IDF.
# fr_core owns the Ota in turn (a cycle IDF links by repeating the libraries).
# Private: what src/esp and src/http run on. The image download is plain HTTP on the LAN (spec 06 §6.9 L0)
# over lwIP sockets (lwip, and vfs for close/fcntl/select): no esp_http_client, so no tcp_transport, esp-tls
# or mbedTLS SSL/x509 in the image (design c4 §4).
idf_component_register(SRCS ${core_srcs} ${http_srcs} ${esp_srcs}
                       INCLUDE_DIRS "include" "src/esp/include"
                       REQUIRES fr_core fr_net fr_proto
                       PRIV_REQUIRES app_update esp_app_format esp_partition esp_system lwip nvs_flash vfs)
