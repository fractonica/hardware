################################################################################
#
# uno-q-openocd
#
################################################################################

# Upstream master (no release since 0.12.0), pinned; libgpiod v2 support.
UNO_Q_OPENOCD_VERSION = d2f72d49efed744eaa489ce931393b6e69122e66
UNO_Q_OPENOCD_SITE = $(call github,openocd-org,openocd,$(UNO_Q_OPENOCD_VERSION))
UNO_Q_OPENOCD_LICENSE = GPL-2.0+
UNO_Q_OPENOCD_LICENSE_FILES = COPYING
UNO_Q_OPENOCD_AUTORECONF = YES
UNO_Q_OPENOCD_DEPENDENCIES = host-pkgconf jimtcl libgpiod2
UNO_Q_OPENOCD_CONF_ENV = CFLAGS="$(TARGET_CFLAGS) -std=gnu99"
UNO_Q_OPENOCD_CONF_OPTS = \
	--disable-doxygen-html \
	--disable-doxygen-pdf \
	--disable-internal-jimtcl \
	--disable-internal-libjaylink \
	--disable-shared \
	--disable-werror \
	--enable-linuxgpiod \
	--disable-jlink \
	--disable-dummy \
	--disable-remote-bitbang \
	--disable-jtag_vpi \
	--disable-jtag_dpi \
	--disable-vdebug \
	--disable-parport \
	--disable-bcm2835gpio \
	--disable-am335xgpio \
	--disable-imx_gpio \
	--disable-ep93xx \
	--disable-at91rm9200 \
	--disable-xlnx-pcie-xvc \
	--disable-rshim \
	--disable-dmem \
	--disable-sysfsgpio \
	--disable-buspirate

# The board needs only the STM32U5 target scripts; drop the other ~2000 files.
define UNO_Q_OPENOCD_TRIM_SCRIPTS
	cd $(TARGET_DIR)/usr/share/openocd/scripts && \
		find . -type f ! -path './target/stm32u5x.cfg' \
			! -path './target/stm32x5x_common.cfg' \
			! -path './target/swj-dp.tcl' \
			! -name 'mem_helper.tcl' ! -name 'bitsbytes.tcl' \
			-delete && \
		find . -type d -empty -delete
	rm -rf $(TARGET_DIR)/usr/share/openocd/contrib \
		$(TARGET_DIR)/usr/share/info/openocd* $(TARGET_DIR)/usr/share/man/man1/openocd*
endef
UNO_Q_OPENOCD_POST_INSTALL_TARGET_HOOKS += UNO_Q_OPENOCD_TRIM_SCRIPTS

$(eval $(autotools-package))
