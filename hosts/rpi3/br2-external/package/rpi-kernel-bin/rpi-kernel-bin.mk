################################################################################
#
# rpi-kernel-bin: Raspberry Pi's prebuilt 64-bit kernel and modules
#
################################################################################

# Nothing to download: everything comes from the rpi-firmware tree.
RPI_KERNEL_BIN_SOURCE =
RPI_KERNEL_BIN_DEPENDENCIES = rpi-firmware
RPI_KERNEL_BIN_INSTALL_IMAGES = YES

# The firmware repository carries several builds; *-v8+ is the 64-bit one for the Pi 3 and 4 (4K pages, not RT).
# Its modules directory comes with modules.dep and the other depmod indexes.
define RPI_KERNEL_BIN_INSTALL_TARGET_CMDS
	rel=$$(cd $(RPI_FIRMWARE_DIR)/modules && ls -d *-v8+) && \
	rm -rf $(TARGET_DIR)/lib/modules/$$rel && \
	mkdir -p $(TARGET_DIR)/lib/modules && \
	cp -a $(RPI_FIRMWARE_DIR)/modules/$$rel $(TARGET_DIR)/lib/modules/
endef

define RPI_KERNEL_BIN_INSTALL_IMAGES_CMDS
	$(INSTALL) -D -m 0644 $(RPI_FIRMWARE_DIR)/boot/kernel8.img $(BINARIES_DIR)/kernel8.img
	$(INSTALL) -D -m 0644 $(RPI_FIRMWARE_DIR)/boot/bcm2710-rpi-3-b.dtb $(BINARIES_DIR)/bcm2710-rpi-3-b.dtb
	$(INSTALL) -D -m 0644 $(RPI_FIRMWARE_DIR)/boot/bcm2710-rpi-3-b-plus.dtb $(BINARIES_DIR)/bcm2710-rpi-3-b-plus.dtb
endef

$(eval $(generic-package))
