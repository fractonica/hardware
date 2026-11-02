# Sole owner of the USB-Serial/JTAG (spec 03 §3.4, 05 §5.12.3). vfs: the USJ VFS header needs it. esp_timer: the
# net log ring's push stamp is fr::Core's clock (design m2-c2 D20). Kconfig: the rings' sizes (`memory: small`).
idf_component_register(SRCS "src/serial.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES fr_proto esp_driver_usb_serial_jtag vfs esp_timer)
