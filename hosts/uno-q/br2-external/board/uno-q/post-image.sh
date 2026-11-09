#!/bin/bash
# Buildroot post-image hook. Builds the efi partition image and a qdl flash
# bundle that writes only the efi and rootfs partitions.
set -euo pipefail
BOARD_DIR=$(dirname "$(readlink -f "$0")")
. "$BOARD_DIR/partitions-emmc-16gb.env"

CMDLINE="root=PARTLABEL=rootfs rootfstype=ext4 rootwait ro console=ttyMSM0,115200"
# Same clock/power-domain handling as Arduino's image (some clocks have no consumer driver)
CMDLINE="$CMDLINE clk_ignore_unused pd_ignore_unused deferred_probe_timeout=30 audit=0"

EFI=$BINARIES_DIR/efi-part
rm -rf "$EFI/loader" "$EFI/qonu"
mkdir -p "$EFI/loader/entries" "$EFI/qonu"
cp "$BINARIES_DIR/Image" "$EFI/qonu/Image"
cp "$BINARIES_DIR/qrb2210-arduino-imola.dtb" "$EFI/qonu/qrb2210-arduino-imola.dtb"
cat > "$EFI/loader/loader.conf" <<CONF
timeout 0
default qonu.conf
editor no
CONF
cat > "$EFI/loader/entries/qonu.conf" <<CONF
title      qonu
linux      /qonu/Image
devicetree /qonu/qrb2210-arduino-imola.dtb
options    $CMDLINE
CONF

rm -rf "$BUILD_DIR/genimage.tmp"
"$HOST_DIR/bin/genimage" \
	--rootpath "$TARGET_DIR" \
	--tmppath "$BUILD_DIR/genimage.tmp" \
	--inputpath "$BINARIES_DIR" \
	--outputpath "$BINARIES_DIR" \
	--config "$BOARD_DIR/genimage.cfg"

fits() { # file sectors
	local bytes; bytes=$(stat -L -c %s "$1")
	[ "$bytes" -le $(( $2 * SECTOR_SIZE )) ] || { echo "post-image: $1 ($bytes B) does not fit its partition" >&2; exit 1; }
}
fits "$BINARIES_DIR/efi.vfat" "$EFI_SECTORS"
fits "$BINARIES_DIR/rootfs.ext4" "$ROOTFS_SECTORS"

prog() { # label file start sectors
	local kb; kb=$(( $(stat -L -c %s "$BINARIES_DIR/$2") / 1024 ))
	printf '  <program SECTOR_SIZE_IN_BYTES="%s" file_sector_offset="0" filename="%s" label="%s" num_partition_sectors="%s" partofsingleimage="false" physical_partition_number="0" readbackverify="false" size_in_KB="%s.0" sparse="false" start_byte_hex="0x%x" start_sector="%s"/>\n' \
		"$SECTOR_SIZE" "$2" "$1" "$4" "$kb" $(( $3 * SECTOR_SIZE )) "$3"
}
FLASH=$BINARIES_DIR/flash
rm -rf "$FLASH" && mkdir -p "$FLASH"
ln -L "$BINARIES_DIR/efi.vfat" "$FLASH/efi.vfat"
ln -L "$BINARIES_DIR/rootfs.ext4" "$FLASH/rootfs.ext4"
{
	echo '<?xml version="1.0" ?>'
	echo '<data>'
	prog efi efi.vfat "$EFI_START" "$EFI_SECTORS"
	prog rootfs rootfs.ext4 "$ROOTFS_START" "$ROOTFS_SECTORS"
	echo '</data>'
} > "$FLASH/rawprogram-qonu.xml"
( cd "$FLASH" && sha256sum efi.vfat rootfs.ext4 > SHA256SUMS )
echo "post-image: flash bundle in $FLASH"
