# qonu: host-side entry points (macOS or Linux, with Docker).
IMAGE  := qonu-builder:trixie
VOLUME := qonu-build
HOST   ?= uriel
# A root-owned ~/.docker/buildx/refs blocks `docker build` on this Mac; keep buildx state here.
DOCKER := BUILDX_CONFIG=$(CURDIR)/.buildx docker
TTY    := $(shell [ -t 0 ] && echo -it)
RUN    := $(DOCKER) run --rm $(TTY) -v $(VOLUME):/work -v $(CURDIR):/src $(IMAGE)
SSH    := ssh -F local/ssh_config

.PHONY: help builder local build kernel-config menuconfig linux-menuconfig shell wifi flash ssh ssh-usb console clean \
	link-test mcu-flash link-push

help:
	@echo "make build          build the image (first run ~45-75 min, then incremental)"
	@echo "make wifi           add a Wi-Fi network to the next image (prompts, stays in local/)"
	@echo "make flash          write efi + rootfs to the board over EDL (needs the JCTL jumper)"
	@echo "make ssh            ssh root@$(HOST).local      make ssh-usb   ssh over USB (10.55.0.1)"
	@echo "make console        serial console over USB (ttyGS0)"
	@echo "make kernel-config  regenerate br2-external/board/uno-q/linux.config"
	@echo "make link-test      protocol unit tests"
	@echo "make mcu-flash      build the STM32 firmware and flash it over SWD (board must be up)"
	@echo "make link-push      build qonu-link, install it on the board, restart the daemon"
	@echo "make menuconfig | linux-menuconfig | shell | clean"

builder:
	@$(DOCKER) build -q -t $(IMAGE) docker/ >/dev/null

local:
	@scripts/setup-local.sh

build: builder local
	$(RUN) /src/scripts/build.sh

kernel-config: builder
	$(RUN) /src/scripts/gen-kernel-config.sh

menuconfig linux-menuconfig clean: builder
	$(RUN) /src/scripts/build.sh $@

shell: builder
	$(DOCKER) run --rm -it -v $(VOLUME):/work -v $(CURDIR):/src $(IMAGE) bash

wifi:
	@scripts/add-wifi.sh

flash:
	@scripts/flash.sh

ssh: local
	$(SSH) $(HOST)

ssh-usb: local
	$(SSH) $(HOST)-usb

console:
	@dev=$$(ls /dev/cu.usbmodem* 2>/dev/null | head -n1); [ -n "$$dev" ] || { echo "no USB serial device"; exit 1; }; \
	echo "screen $$dev 115200  (exit: Ctrl-A then K)"; screen $$dev 115200

# STM32 link development loop (board reachable over USB, see local/ssh_config).
FW_ELF := /work/link-target/firmware/thumbv8m.main-none-eabihf/release/qonu-fw
LINKD  := /work/link-target/daemon/aarch64-unknown-linux-gnu/release/qonu-link

link-test: builder
	$(RUN) /src/scripts/link.sh test

mcu-flash: builder local
	$(RUN) /src/scripts/link.sh firmware
	$(DOCKER) run --rm -v $(VOLUME):/work $(IMAGE) cat $(FW_ELF) | $(SSH) $(HOST)-usb 'cat > /tmp/qonu-fw.elf && qonu-mcu flash /tmp/qonu-fw.elf'

link-push: builder local
	$(RUN) /src/scripts/link.sh daemon
	$(DOCKER) run --rm -v $(VOLUME):/work $(IMAGE) cat $(LINKD) | $(SSH) $(HOST)-usb 'cat > /tmp/qonu-link && install -m 0755 /tmp/qonu-link /usr/bin/qonu-link && systemctl restart qonu-link && sleep 1 && qonu-link ping 2'
