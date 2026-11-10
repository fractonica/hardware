#!/bin/bash
# Writes out/sdcard.img to an SD card on macOS. Usage: scripts/flash.sh diskN
# Refuses anything that is not a whole, removable SD or USB disk under 256 GB, shows what it found and asks
# before writing. The raw write needs sudo.
set -euo pipefail
cd "$(dirname "$0")/.."
disk=${1:-}
img=out/sdcard.img
[[ "$disk" =~ ^disk[0-9]+$ ]] || { echo "usage: make flash DISK=diskN   (find it with: diskutil list; the built-in reader is listed as internal)" >&2; exit 1; }
[ -s "$img" ] || { echo "no $img; run make build first" >&2; exit 1; }

info=$(diskutil info "/dev/$disk") || { echo "no such disk: $disk" >&2; exit 1; }
field() { awk -F': *' -v k="$1" '$1 ~ "^ *"k"$" {print $2; exit}' <<<"$info"; }
removable=$(field "Removable Media")
protocol=$(field "Protocol")
whole=$(field "Whole")
name=$(field "Device / Media Name")
bytes=$(field "Disk Size" | sed -n 's/.*(\([0-9]*\) Bytes).*/\1/p')
[ "$whole" = Yes ] || { echo "$disk is a partition; give the whole disk" >&2; exit 1; }
[ "$removable" = Removable ] || { echo "$disk is not removable media ($removable); refusing" >&2; exit 1; }
case "$protocol" in
	"Secure Digital" | USB) ;;
	*) echo "$disk is a $protocol disk, not an SD card or USB stick; refusing" >&2; exit 1 ;;
esac
[ -n "$bytes" ] && [ "$bytes" -lt 256000000000 ] || { echo "$disk is larger than 256 GB; refusing" >&2; exit 1; }

echo "Target: /dev/$disk  $name  $protocol  $(( bytes / 1000000000 )) GB"
diskutil list "/dev/$disk" | tail -n +2
echo "Image:  $img  $(du -h "$img" | cut -f1)"
read -r -p "Erase /dev/$disk and write the image? Type the disk name ($disk) to confirm: " answer
[ "$answer" = "$disk" ] || { echo "not confirmed; nothing written"; exit 1; }

diskutil unmountDisk "/dev/$disk"
sudo dd if="$img" of="/dev/r$disk" bs=4m status=progress
sync
diskutil eject "/dev/$disk"
echo "Done. Put the card in the Pi and power it; the first boot grows the root partition. Then: make ssh"
