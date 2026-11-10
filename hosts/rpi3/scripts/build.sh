#!/bin/bash
# Runs inside the build container (the UNO Q's builder image and volume). Usage: build.sh [buildroot targets...]
set -euo pipefail
BR=/work/buildroot
O=/work/output-rpi3
EXT=/src/br2-external
export BR2_DL_DIR=/work/dl BR2_CCACHE_DIR=/work/ccache RPI3_LOCAL_DIR=/src/local

if [ ! -f "$O/.config" ] || [ "$EXT/configs/raphael_rpi3_defconfig" -nt "$O/.config" ]; then
	make -C "$BR" O="$O" BR2_EXTERNAL="$EXT" raphael_rpi3_defconfig
fi
make -C "$O" "$@"

if [ $# -eq 0 ] || [ "$1" = all ]; then
	mkdir -p /src/out
	cp "$O/images/sdcard.img" /src/out/sdcard.img
	(cd /src/out && sha256sum sdcard.img > SHA256SUMS)
	echo "== out/sdcard.img: $(du -h /src/out/sdcard.img | cut -f1); root filesystem in use: $(du -sh "$O/target" | cut -f1)"
fi
