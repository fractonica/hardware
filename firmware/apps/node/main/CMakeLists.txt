# fr_board is generated per profile by `fr gen firmware` into the build's fr_gen/ directory.
idf_component_register(SRCS "main.cpp"
                       PRIV_REQUIRES fr_core fr_board)
