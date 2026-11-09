#!/bin/bash
# Copies files from the last Buildroot build's target tree onto the running
# board over SSH, for quick iteration without reflashing. Paths are absolute
# paths inside the image, e.g.: scripts/push.sh /usr/bin/openocd /etc/openocd
# A later `make flash` makes the board match the image again.
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -gt 0 ] || { echo "usage: $0 /path/in/image..." >&2; exit 2; }
HOST=${QONU_HOST:-uriel-usb}
rel=()
for p in "$@"; do rel+=(".${p}"); done
BUILDX_CONFIG=$PWD/.buildx docker run --rm -v qonu-build:/work qonu-builder:trixie \
	tar -C /work/output/target -cf - --owner=0 --group=0 --numeric-owner "${rel[@]}" \
	| ssh -F local/ssh_config "$HOST" "tar -C / -xf -"
printf 'pushed to %s:\n' "$HOST"; printf '  %s\n' "$@"
