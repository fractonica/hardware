#!/bin/bash
# Buildroot post-build hook ($1 = target dir). Installs per-machine files from
# local/ (never committed) and enables the qonu services.
set -euo pipefail
TARGET_DIR=$1
LOCAL=${QONU_LOCAL_DIR:-/src/local}
SYSTEMCTL=("$HOST_DIR/bin/systemctl" "--root=$TARGET_DIR")

# SSH: authorized keys for root, and a stable host key so reflashing does not
# change the board's identity.
install -d -m 0700 "$TARGET_DIR/root/.ssh"
if [ -s "$LOCAL/authorized_keys" ]; then
	{
		cat "$LOCAL/authorized_keys"
		# The MCP client key may only start qonu-mcp: no shell, no forwarding.
		if [ -s "$LOCAL/ssh/mcp_ed25519.pub" ]; then
			echo "command=\"/usr/bin/qonu-mcp\",restrict $(cat "$LOCAL/ssh/mcp_ed25519.pub")"
		fi
	} > "$TARGET_DIR/root/.ssh/authorized_keys"
	chmod 0600 "$TARGET_DIR/root/.ssh/authorized_keys"
else
	echo "post-build: WARNING: $LOCAL/authorized_keys missing; SSH login will be impossible" >&2
fi
if [ -s "$LOCAL/ssh/ssh_host_ed25519_key" ]; then
	install -m 0600 "$LOCAL/ssh/ssh_host_ed25519_key" "$TARGET_DIR/etc/ssh/ssh_host_ed25519_key"
	install -m 0644 "$LOCAL/ssh/ssh_host_ed25519_key.pub" "$TARGET_DIR/etc/ssh/ssh_host_ed25519_key.pub"
fi

# Wi-Fi networks in iwd format (written by scripts/add-wifi.sh).
install -d -m 0700 "$TARGET_DIR/var/lib/iwd"
shopt -s nullglob
for f in "$LOCAL"/wifi/*.psk "$LOCAL"/wifi/*.open; do
	install -m 0600 "$f" "$TARGET_DIR/var/lib/iwd/"
done
shopt -u nullglob

# Arduino's per-PCB Wi-Fi calibration, if it was copied off a stock board.
if [ -s "$LOCAL/firmware/board-2.bin" ]; then
	install -m 0644 "$LOCAL/firmware/board-2.bin" \
		"$TARGET_DIR/lib/firmware/ath10k/WCN3990/hw1.0/board-2.bin"
fi

"${SYSTEMCTL[@]}" enable \
	rmtfs.service tqftpserv.service qbootctl-mark.service qonu-mcu-boot0.service \
	qonu-usb-gadget.service serial-getty@ttyGS0.service qonu-link.service qonu-dash.service \
	iwd.service sshd.service \
	systemd-networkd.service systemd-resolved.service systemd-timesyncd.service

ln -sf ../run/systemd/resolve/stub-resolv.conf "$TARGET_DIR/etc/resolv.conf"

# The PMIC RTC is read-only to Linux and reads 1970 at every power-up. PID 1
# advances the clock to this file's mtime (the build date, via SOURCE_DATE_EPOCH),
# then timesyncd restores its last saved time and NTP corrects it.
touch "$TARGET_DIR/usr/lib/clock-epoch"

cat > "$TARGET_DIR/etc/qonu-release" <<REL
QONU_GIT=$(git -c safe.directory='*' -C "$BR2_EXTERNAL_QONU_PATH" describe --always --dirty 2>/dev/null || echo uncommitted)
QONU_KERNEL=$(sed -n 's/^BR2_LINUX_KERNEL_CUSTOM_VERSION_VALUE="\(.*\)"/\1/p' "$BR2_CONFIG")
REL
