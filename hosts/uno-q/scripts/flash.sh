#!/bin/bash
# Flashes out/flash to the UNO Q through Qualcomm EDL mode with qdl.
# Writes ONLY the efi and rootfs partitions. Qualcomm firmware, U-Boot, the GPT
# and userdata are left alone, so the Arduino Flasher can always restore stock.
set -euo pipefail
cd "$(dirname "$0")/.."
. br2-external/board/uno-q/partitions-emmc-16gb.env
FLASH=$PWD/out/flash
FW=$PWD/local/boot-firmware
BOOTZIP_URL=https://downloads.arduino.cc/debian-im/unoq-bootloader-emmc-linux-251020.zip
BOOTZIP_SHA256=c606e95d0107f8c58d0dd9494e00624d1db7c4361cca20513bc78ef02ca28dd1

command -v qdl >/dev/null || { echo "qdl not found (macOS: brew install qdl)" >&2; exit 1; }
[ -f "$FLASH/rawprogram-qonu.xml" ] || { echo "no image in out/flash: run make build" >&2; exit 1; }
(cd "$FLASH" && shasum -a 256 -c --quiet SHA256SUMS)
compgen -G 'local/wifi/*.psk' >/dev/null || compgen -G 'local/wifi/*.open' >/dev/null \
	|| echo "note: no Wi-Fi network in local/wifi; the board will be reachable over USB only (make wifi)"

# Firehose programmer, from Arduino's boot-firmware bundle (Qualcomm license, kept out of git).
if [ ! -s "$FW/prog_firehose_ddr.elf" ]; then
	mkdir -p "$FW"
	echo "Downloading Arduino boot-firmware bundle for the EDL programmer..."
	curl -fL --progress-bar -o "$FW/bootloader.zip" "$BOOTZIP_URL"
	echo "$BOOTZIP_SHA256  $FW/bootloader.zip" | shasum -a 256 -c --quiet
	unzip -o -j -q "$FW/bootloader.zip" '*prog_firehose_ddr.elf' -d "$FW"
fi

# Safety: if the board is up (stock via adb, or qonu via ssh), confirm the partition layout.
read_layout='for p in 67 68; do echo "$(grep PARTNAME /sys/class/block/mmcblk0p$p/uevent | cut -d= -f2) $(cat /sys/class/block/mmcblk0p$p/start)"; done'
live=""
if command -v adb >/dev/null && [ "$(adb get-state 2>/dev/null)" = device ]; then
	live=$(adb shell "$read_layout" | tr -d '\r')
elif [ -f local/ssh_config ] && ssh -F local/ssh_config -o BatchMode=yes uriel-usb true 2>/dev/null; then
	live=$(ssh -F local/ssh_config uriel-usb "$read_layout")
fi
if [ -n "$live" ]; then
	expected=$(printf 'efi %s\nrootfs %s' "$EFI_START" "$ROOTFS_START")
	if [ "$live" != "$expected" ]; then
		echo "Partition layout on the board does not match partitions-emmc-16gb.env:" >&2
		echo "$live" >&2
		exit 1
	fi
	echo "Partition layout on the board matches (efi @ $EFI_START, rootfs @ $ROOTFS_START)."
fi

cat <<MSG

Put the board in EDL mode:
  1. Unplug the USB-C cable.
  2. Short the JCTL header pins USB_BOOT and GND with a jumper.
  3. Plug the USB-C cable back in (no boot animation is expected).
qdl waits for the board, writes efi + rootfs, then resets it.
Afterwards remove the jumper and replug, or the board re-enters EDL.

MSG
[ -n "${QONU_FLASH_YES:-}" ] || read -r -p "Press Enter to start flashing (Ctrl-C to abort)... "
cd "$FLASH"
qdl --storage emmc "$FW/prog_firehose_ddr.elf" rawprogram-qonu.xml
echo "Done. Remove the JCTL jumper and replug USB-C. First boot takes about 30 s."
