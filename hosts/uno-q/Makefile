# qonu: host-side entry points (macOS or Linux, with Docker).
IMAGE  := qonu-builder:trixie
VOLUME := qonu-build
HOST   ?= uriel
# A root-owned ~/.docker/buildx/refs blocks `docker build` on this Mac; keep buildx state here.
DOCKER := BUILDX_CONFIG=$(CURDIR)/.buildx docker
TTY    := $(shell [ -t 0 ] && echo -it)
# The Fractonica checkout this folder lives in, read-only at /fr: qonu-node builds against its fr_posix.
FR_REPO := $(abspath $(CURDIR)/../..)
RUN    := $(DOCKER) run --rm $(TTY) -v $(VOLUME):/work -v $(CURDIR):/src -v $(FR_REPO):/fr:ro $(IMAGE)
SSH    := ssh -F local/ssh_config

.PHONY: help builder local build kernel-config menuconfig linux-menuconfig shell wifi flash ssh ssh-usb console clean \
	link-test mcu-flash link-push mcp-push dash-push node-push web-push hub-push hub-tunnel

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
	@echo "make mcp-push       build qonu-mcp and install it on the board"
	@echo "make dash-push      build qonu-dash, install it on the board, restart the dashboard"
	@echo "make node-push      build qonu-node (Fractonica device), install it and its service on the board"
	@echo "make web-push       build qonu-web (LAN terminal), install it and its service on the board"
	@echo "make hub-push       stage the Fractonica hub (linux-arm64) and install it in /data on the board"
	@echo "make hub-tunnel     forward the board hub's API to 127.0.0.1:7520 (FR_HUB=http://127.0.0.1:7520)"
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
	$(DOCKER) run --rm -it -v $(VOLUME):/work -v $(CURDIR):/src -v $(FR_REPO):/fr:ro $(IMAGE) bash

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
MCPD   := /work/link-target/mcp/aarch64-unknown-linux-gnu/release/qonu-mcp
DASHD  := /work/link-target/dash/aarch64-unknown-linux-gnu/release/qonu-dash
WEBD   := /work/link-target/web/aarch64-unknown-linux-gnu/release/qonu-web

link-test: builder
	$(RUN) /src/scripts/link.sh test

mcu-flash: builder local
	$(RUN) /src/scripts/link.sh firmware
	$(DOCKER) run --rm -v $(VOLUME):/work $(IMAGE) cat $(FW_ELF) | $(SSH) $(HOST)-usb 'cat > /tmp/qonu-fw.elf && qonu-mcu flash /tmp/qonu-fw.elf'

link-push: builder local
	$(RUN) /src/scripts/link.sh daemon
	$(DOCKER) run --rm -v $(VOLUME):/work $(IMAGE) cat $(LINKD) | $(SSH) $(HOST)-usb 'cat > /tmp/qonu-link && install -m 0755 /tmp/qonu-link /usr/bin/qonu-link && systemctl restart qonu-link && sleep 1 && qonu-link ping 2'

mcp-push: builder local
	$(RUN) /src/scripts/link.sh mcp
	$(DOCKER) run --rm -v $(VOLUME):/work $(IMAGE) cat $(MCPD) | $(SSH) $(HOST)-usb 'cat > /tmp/qonu-mcp && install -m 0755 /tmp/qonu-mcp /usr/bin/qonu-mcp && echo "qonu-mcp installed"'

dash-push: builder local
	$(RUN) /src/scripts/link.sh dash
	$(DOCKER) run --rm -v $(VOLUME):/work $(IMAGE) cat $(DASHD) | $(SSH) $(HOST)-usb 'cat > /tmp/qonu-dash && install -m 0755 /tmp/qonu-dash /usr/bin/qonu-dash && systemctl restart qonu-dash && echo "qonu-dash restarted"'

# qonu-node: built by Buildroot against /fr (the Fractonica checkout); its unit comes straight from the overlay.
node-push: builder local
	$(RUN) /src/scripts/build.sh qonu-node-rebuild
	scripts/push.sh /usr/bin/qonu-node
	tar -C br2-external/board/uno-q/rootfs-overlay -cf - --uid 0 --gid 0 ./usr/lib/systemd/system/qonu-node.service \
		| $(SSH) $(HOST)-usb 'tar -C / -xf - && systemctl daemon-reload && systemctl enable qonu-node 2>/dev/null; systemctl restart qonu-node; sleep 1; systemctl --no-pager status qonu-node | head -12'

web-push: builder local
	$(RUN) /src/scripts/link.sh web
	$(DOCKER) run --rm -v $(VOLUME):/work $(IMAGE) cat $(WEBD) | $(SSH) $(HOST)-usb 'cat > /tmp/qonu-web && install -m 0755 /tmp/qonu-web /usr/bin/qonu-web'
	tar -C br2-external/board/uno-q/rootfs-overlay -cf - --uid 0 --gid 0 ./usr/lib/systemd/system/qonu-web.service \
		| $(SSH) $(HOST)-usb 'tar -C / -xf - && systemctl daemon-reload && systemctl enable qonu-web 2>/dev/null; systemctl restart qonu-web; sleep 1; systemctl is-active qonu-web'

# The Fractonica hub on the board: staged in the container against /fr, then swapped into /data/fractonica/hub whole.
hub-push: builder local
	$(RUN) /src/scripts/hub-stage.sh
	$(DOCKER) run --rm -v $(VOLUME):/work $(IMAGE) tar -C /work/hub-stage -cf - . \
		| $(SSH) $(HOST)-usb 'set -e; d=/data/fractonica; rm -rf $$d/hub.new; mkdir -p $$d/hub.new $$d/home; tar -C $$d/hub.new -xf -; \
			rm -rf $$d/hub.old; if [ -d $$d/hub ]; then mv $$d/hub $$d/hub.old; fi; mv $$d/hub.new $$d/hub; rm -rf $$d/hub.old'
	tar -C br2-external/board/uno-q/rootfs-overlay -cf - --uid 0 --gid 0 ./usr/lib/systemd/system/fractonica-hub.service \
		| $(SSH) $(HOST)-usb 'tar -C / -xf - && systemctl daemon-reload && systemctl enable fractonica-hub 2>/dev/null; systemctl restart fractonica-hub; sleep 8; systemctl is-active fractonica-hub; journalctl -u fractonica-hub -b --no-pager -n 4 -o cat'

# The board hub's API (port 7520) stays on its loopback; this forwards it to the Mac. Then: FR_HUB=http://127.0.0.1:7520 fr …
hub-tunnel: local
	@echo "board hub API on http://127.0.0.1:7520 (Ctrl-C ends the tunnel)"
	$(SSH) -N -L 7520:127.0.0.1:7520 $(HOST)
