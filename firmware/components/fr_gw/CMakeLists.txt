# The gateway's ESP-NOW <-> serial bridge (design m2-c4-gateway D8, D9). IDF-free: the host suite
# (firmware/test/host) builds the same source, and fr_core implements its Air, Line and Indicator on target
# (Net's air tap and air_send_raw, fr_serial, the status LED) in role gateway only.
# Public: the header takes fr::Core (fr_core), net::Mac and RxMeta (fr_net's air.hpp) and the generated GW_*
# bodies (fr_proto). fr_core in turn builds the bridge in role gateway, a cycle IDF links by repeating the libraries.
idf_component_register(SRCS "src/bridge.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES fr_core fr_net fr_proto)
