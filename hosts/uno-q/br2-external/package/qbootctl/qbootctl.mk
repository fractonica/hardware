################################################################################
#
# qbootctl
#
################################################################################

QBOOTCTL_VERSION = 0.2.2
QBOOTCTL_SITE = $(call github,linux-msm,qbootctl,$(QBOOTCTL_VERSION))
QBOOTCTL_LICENSE = GPL-3.0
QBOOTCTL_LICENSE_FILES = LICENSE

$(eval $(meson-package))
