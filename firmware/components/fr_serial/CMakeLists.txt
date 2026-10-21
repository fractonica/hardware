# Sole owner of the USB-Serial/JTAG (spec 03 §3.4, 05 §5.12.3). vfs: the USJ VFS header needs it.
idf_component_register(SRCS "src/serial.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES fr_proto esp_driver_usb_serial_jtag vfs)
