# tp5000 (design power-p1 D4): tp4056's ChargerGpio under its own driver id; the code is tp4056's component, which codegen
# puts on the component path with it (driver.yaml `uses`).
idf_component_register(INCLUDE_DIRS "include"
                       REQUIRES fr_core tp4056)
