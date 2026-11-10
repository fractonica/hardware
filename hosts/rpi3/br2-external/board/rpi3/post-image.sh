#!/bin/bash
# Buildroot post-image hook: assembles sdcard.img (FAT boot partition + ext4 root) with genimage.
set -euo pipefail
BOARD_DIR=$(dirname "$(readlink -f "$0")")

# genimage copies --rootpath whole; the root filesystem is already rootfs.ext4, so give it an empty one.
ROOTPATH_TMP=$(mktemp -d)
trap 'rm -rf "$ROOTPATH_TMP"' EXIT
rm -rf "$BUILD_DIR/genimage.tmp"
"$HOST_DIR/bin/genimage" \
	--rootpath "$ROOTPATH_TMP" \
	--tmppath "$BUILD_DIR/genimage.tmp" \
	--inputpath "$BINARIES_DIR" \
	--outputpath "$BINARIES_DIR" \
	--config "$BOARD_DIR/genimage.cfg"
