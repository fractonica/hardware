################################################################################
#
# tqftpserv
#
################################################################################

TQFTPSERV_VERSION = 1.3
TQFTPSERV_SITE = $(call github,linux-msm,tqftpserv,v$(TQFTPSERV_VERSION))
TQFTPSERV_LICENSE = BSD-3-Clause
TQFTPSERV_LICENSE_FILES = LICENSE
TQFTPSERV_DEPENDENCIES = qrtr \
	$(if $(BR2_PACKAGE_XZ),xz) \
	$(if $(BR2_PACKAGE_ZSTD),zstd)

# The systemd unit ships in the qonu rootfs overlay. The upstream
# populate-readwrite helper copies modem data from the persist partition, which
# is empty on the UNO Q (stock never runs it), so it would only fail at boot.
define TQFTPSERV_REMOVE_UPSTREAM_UNIT
	rm -f $(TARGET_DIR)/usr/lib/systemd/system/tqftpserv.service \
		$(TARGET_DIR)/usr/lib/systemd/system/tqftpserv-populate-readwrite.service \
		$(TARGET_DIR)/etc/systemd/system/multi-user.target.wants/tqftpserv-populate-readwrite.service \
		$(TARGET_DIR)/usr/bin/populate-readwrite.sh
endef
TQFTPSERV_POST_INSTALL_TARGET_HOOKS += TQFTPSERV_REMOVE_UPSTREAM_UNIT

$(eval $(meson-package))
