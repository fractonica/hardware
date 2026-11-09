################################################################################
#
# qonu-node
#
################################################################################

QONU_NODE_VERSION = 0.1.0
QONU_NODE_SITE = $(BR2_EXTERNAL_QONU_PATH)/../node
QONU_NODE_SITE_METHOD = local
QONU_NODE_LICENSE = Proprietary

# The local-site copy holds only hosts/uno-q/node; the Fractonica sources it builds against (fr_posix, fr_net,
# fr_core, the generated codecs) come from the checkout the Makefile mounts at /fr. Buildroot does not track
# changes there: scripts/build.sh rebuilds this package on every full build, as it does qonu-link.
QONU_NODE_FR_REPO = /fr
QONU_NODE_CONF_OPTS = \
	-DFR_REPO=$(QONU_NODE_FR_REPO) \
	-DQONU_NODE_VERSION=$(QONU_NODE_VERSION) \
	-DFR_POSIX_TEST_HOOKS=ON

define QONU_NODE_CHECK_FR_REPO
	@test -f $(QONU_NODE_FR_REPO)/firmware/components/fr_posix/fractonica-posix.cmake || \
		{ echo "qonu-node: no Fractonica checkout at $(QONU_NODE_FR_REPO) (run the build through the Makefile)"; exit 1; }
endef
QONU_NODE_PRE_CONFIGURE_HOOKS += QONU_NODE_CHECK_FR_REPO

$(eval $(cmake-package))
