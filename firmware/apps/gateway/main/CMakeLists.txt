# fr_board is generated per profile by `fr gen firmware` into the build's fr_gen/ directory. fr_gw is the bridge
# (design m2-c4-gateway D8), which fr_core runs in role gateway; named here so the app states what it is.
idf_component_register(SRCS "main.cpp"
                       PRIV_REQUIRES fr_core fr_gw fr_board)
