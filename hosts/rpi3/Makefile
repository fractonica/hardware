# raphael (Raspberry Pi 3 Model B): host-side entry points (macOS or Linux, with Docker).
# Builds in the UNO Q's builder image and volume: one Buildroot tree, download cache and ccache, separate output.
IMAGE  := qonu-builder:trixie
VOLUME := qonu-build
HOST   ?= raphael
# A root-owned ~/.docker/buildx/refs blocks `docker build` on this Mac; keep buildx state here.
DOCKER := BUILDX_CONFIG=$(CURDIR)/.buildx docker
TTY    := $(shell [ -t 0 ] && echo -it)
RUN    := $(DOCKER) run --rm $(TTY) -v $(VOLUME):/work -v $(CURDIR):/src $(IMAGE)
SSH    := ssh -F local/ssh_config

.PHONY: help builder local build menuconfig shell clean wifi flash ssh console

help:
	@echo "make build              build out/sdcard.img (first run ~40-60 min, then incremental)"
	@echo "make flash DISK=diskN   write it to an SD card (find it with diskutil list; needs sudo)"
	@echo "make wifi               add a Wi-Fi network to the next image (prompts, stays in local/)"
	@echo "make ssh                ssh root@$(HOST).local"
	@echo "make console            serial console through a USB-UART adapter on GPIO 14/15"
	@echo "make menuconfig | shell | clean"

# Builds the image only when it is missing: hosts/uno-q owns its Dockerfile and rebuilds it, and a rebuild here
# would contact Docker Hub every time.
builder:
	@docker image inspect $(IMAGE) >/dev/null 2>&1 || $(DOCKER) build -q -t $(IMAGE) ../uno-q/docker/ >/dev/null

local:
	@scripts/setup-local.sh

build: builder local
	$(RUN) /src/scripts/build.sh

menuconfig clean: builder
	$(RUN) /src/scripts/build.sh $@

shell: builder
	$(DOCKER) run --rm -it -v $(VOLUME):/work -v $(CURDIR):/src $(IMAGE) bash

wifi:
	@scripts/add-wifi.sh

flash:
	@scripts/flash.sh $(DISK)

ssh: local
	$(SSH) $(HOST)

console:
	@dev=$$(ls /dev/cu.usbserial* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial* 2>/dev/null | head -n1); \
	[ -n "$$dev" ] || { echo "no USB-UART adapter found"; exit 1; }; \
	echo "screen $$dev 115200  (exit: Ctrl-A then K)"; screen $$dev 115200
