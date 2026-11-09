################################################################################
#
# node-official
#
################################################################################

# The same version as the Mac's hub (nvm 24.22.0), from nodejs.org's own linux-arm64 build: it links only glibc,
# libstdc++ and libgcc_s, which the image has.
NODE_OFFICIAL_VERSION = 24.22.0
NODE_OFFICIAL_SOURCE = node-v$(NODE_OFFICIAL_VERSION)-linux-arm64.tar.xz
NODE_OFFICIAL_SITE = https://nodejs.org/dist/v$(NODE_OFFICIAL_VERSION)
NODE_OFFICIAL_LICENSE = MIT
NODE_OFFICIAL_LICENSE_FILES = LICENSE

define NODE_OFFICIAL_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/bin/node $(TARGET_DIR)/usr/bin/node
	rm -rf $(TARGET_DIR)/usr/lib/node_modules/npm
	mkdir -p $(TARGET_DIR)/usr/lib/node_modules
	cp -a $(@D)/lib/node_modules/npm $(TARGET_DIR)/usr/lib/node_modules/npm
	ln -sf ../lib/node_modules/npm/bin/npm-cli.js $(TARGET_DIR)/usr/bin/npm
	ln -sf ../lib/node_modules/npm/bin/npx-cli.js $(TARGET_DIR)/usr/bin/npx
endef

$(eval $(generic-package))
