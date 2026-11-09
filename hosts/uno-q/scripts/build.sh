#!/bin/bash
# Runs inside the build container. Usage: build.sh [buildroot targets...]
set -euo pipefail
BR=/work/buildroot
O=/work/output
EXT=/src/br2-external
export BR2_DL_DIR=/work/dl BR2_CCACHE_DIR=/work/ccache QONU_LOCAL_DIR=/src/local

if [ ! -f "$O/.config" ] || [ "$EXT/configs/qonu_uno_q_defconfig" -nt "$O/.config" ]; then
	make -C "$BR" O="$O" BR2_EXTERNAL="$EXT" qonu_uno_q_defconfig
fi
make -C "$O" "$@"

if [ $# -eq 0 ] || [ "$1" = all ]; then
	mkdir -p /src/out
	rm -rf /src/out/flash
	cp -rL "$O/images/flash" /src/out/flash
	cp "$O/images/qrb2210-arduino-imola.dtb" "$O/images/Image" /src/out/ 2>/dev/null || true
	echo "== images: $(du -sh /src/out/flash | cut -f1) in out/flash"
	ls -la /src/out/flash
fi
