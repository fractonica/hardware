################################################################################
#
# qonu-link
#
################################################################################

QONU_LINK_VERSION = 0.1.0
QONU_LINK_SITE = $(BR2_EXTERNAL_QONU_PATH)/../link
QONU_LINK_SITE_METHOD = local
QONU_LINK_LICENSE = MIT OR Apache-2.0

# Built in place from the repo's link/ with the same toolchain (the container's
# rustup, docker/Dockerfile), the same target dirs and the same flags as
# `make mcu-flash` and `make link-push`. The image therefore ships exactly the
# artifacts those commands produce, so `qonu-mcu verify` can confirm that an MCU
# runs the image's firmware. The local-site copy in $(@D) is not used. The
# daemon links with Buildroot's compiler and so uses the image's glibc; the
# firmware only has its debug sections stripped for the image.
QONU_LINK_SRC = $(realpath $(BR2_EXTERNAL_QONU_PATH)/../link)
QONU_LINK_TARGETS = $(abspath $(BASE_DIR)/../link-target)
QONU_LINK_CARGO = CARGO_TERM_COLOR=never CARGO_HOME=$(or $(CARGO_HOME),$(HOME)/.cargo) cargo
QONU_LINK_LLVM_STRIP = $(shell rustc --print sysroot)/lib/rustlib/aarch64-unknown-linux-gnu/bin/llvm-strip
QONU_LINK_DAEMON = $(QONU_LINK_TARGETS)/daemon/aarch64-unknown-linux-gnu/release/qonu-link
QONU_LINK_FW = $(QONU_LINK_TARGETS)/firmware/thumbv8m.main-none-eabihf/release/qonu-fw

define QONU_LINK_BUILD_CMDS
	cd $(QONU_LINK_SRC)/daemon && CARGO_TARGET_DIR=$(QONU_LINK_TARGETS)/daemon $(QONU_LINK_CARGO) \
		build --release --locked --target aarch64-unknown-linux-gnu \
		--config 'target.aarch64-unknown-linux-gnu.linker="$(TARGET_CC)"'
	cd $(QONU_LINK_SRC)/firmware && CARGO_TARGET_DIR=$(QONU_LINK_TARGETS)/firmware \
		$(QONU_LINK_CARGO) build --release --locked
endef

define QONU_LINK_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(QONU_LINK_DAEMON) $(TARGET_DIR)/usr/bin/qonu-link
	mkdir -p $(TARGET_DIR)/usr/share/qonu/mcu
	$(QONU_LINK_LLVM_STRIP) --strip-debug -o $(TARGET_DIR)/usr/share/qonu/mcu/qonu-fw.elf $(QONU_LINK_FW)
	chmod 0644 $(TARGET_DIR)/usr/share/qonu/mcu/qonu-fw.elf
endef

$(eval $(generic-package))
