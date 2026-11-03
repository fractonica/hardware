# Sole owner of the serial link's port (spec 03 §3.4, 05 §5.12.3): the USB-Serial/JTAG, or UART0 under
# CONFIG_FR_SERIAL_UART (design camera-c1 D2: boards behind a USB-UART bridge). Both drivers are required (the
# requirements are resolved before sdkconfig is read); the one not built for the target is an empty component, and
# serial.cpp includes only the backend it uses. vfs: the USJ and UART VFS headers need it. esp_timer: the net log
# ring's push stamp is fr::Core's clock (design m2-c2 D20). Kconfig: the backend and the rings' sizes (`memory: small`).
idf_component_register(SRCS "src/serial.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES fr_proto esp_driver_usb_serial_jtag esp_driver_uart vfs esp_timer)
