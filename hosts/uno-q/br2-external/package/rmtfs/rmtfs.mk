################################################################################
#
# rmtfs
#
################################################################################

RMTFS_VERSION = 1.3
RMTFS_SITE = $(call github,linux-msm,rmtfs,v$(RMTFS_VERSION))
RMTFS_LICENSE = BSD-3-Clause
RMTFS_LICENSE_FILES = LICENSE
RMTFS_DEPENDENCIES = qrtr udev

define RMTFS_BUILD_CMDS
	$(TARGET_MAKE_ENV) $(MAKE) -C $(@D) rmtfs \
		CC="$(TARGET_CC)" \
		CFLAGS="$(TARGET_CFLAGS)" \
		LDFLAGS="$(TARGET_LDFLAGS) -lqrtr -ludev -lpthread"
endef

# The systemd unit ships in the qonu rootfs overlay.
define RMTFS_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/rmtfs $(TARGET_DIR)/usr/bin/rmtfs
endef

$(eval $(generic-package))
