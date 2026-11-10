#!/bin/bash
# Buildroot post-build hook ($1 = target dir). Installs per-machine files from local/ (never committed)
# and enables the services.
set -euo pipefail
TARGET_DIR=$1
LOCAL=${RPI3_LOCAL_DIR:-/src/local}
SYSTEMCTL=("$HOST_DIR/bin/systemctl" "--root=$TARGET_DIR")

# SSH: authorized keys for root, and a stable host key so reflashing does not change the Pi's identity.
install -d -m 0700 "$TARGET_DIR/root/.ssh"
if [ -s "$LOCAL/authorized_keys" ]; then
	install -m 0600 "$LOCAL/authorized_keys" "$TARGET_DIR/root/.ssh/authorized_keys"
else
	echo "post-build: WARNING: $LOCAL/authorized_keys missing; SSH login will be impossible" >&2
fi
if [ -s "$LOCAL/ssh/ssh_host_ed25519_key" ]; then
	install -m 0600 "$LOCAL/ssh/ssh_host_ed25519_key" "$TARGET_DIR/etc/ssh/ssh_host_ed25519_key"
	install -m 0644 "$LOCAL/ssh/ssh_host_ed25519_key.pub" "$TARGET_DIR/etc/ssh/ssh_host_ed25519_key.pub"
fi

# Wi-Fi networks in iwd format (scripts/add-wifi.sh writes them).
install -d -m 0700 "$TARGET_DIR/var/lib/iwd"
shopt -s nullglob
for f in "$LOCAL"/wifi/*.psk "$LOCAL"/wifi/*.open; do
	install -m 0600 "$f" "$TARGET_DIR/var/lib/iwd/"
done
shopt -u nullglob

# Time zone, from local/timezone (scripts/setup-local.sh writes this computer's). Change it on the Pi with
# timedatectl set-timezone.
tz=$(tr -d '[:space:]' < "$LOCAL/timezone" 2>/dev/null || true)
if [ -n "$tz" ] && [ -f "$TARGET_DIR/usr/share/zoneinfo/$tz" ]; then
	ln -sfn "../usr/share/zoneinfo/$tz" "$TARGET_DIR/etc/localtime"
	echo "$tz" > "$TARGET_DIR/etc/timezone"
elif [ -n "$tz" ]; then
	echo "post-build: WARNING: unknown time zone '$tz' in $LOCAL/timezone; the Pi stays on UTC" >&2
fi

"${SYSTEMCTL[@]}" enable \
	raphael-grow-root.service raphael-boot-report.service iwd.service sshd.service \
	systemd-networkd.service systemd-resolved.service systemd-timesyncd.service

ln -sf ../run/systemd/resolve/stub-resolv.conf "$TARGET_DIR/etc/resolv.conf"

# The Pi has no RTC and starts at 1970. PID 1 advances the clock to this file's mtime (the build date,
# via SOURCE_DATE_EPOCH), then timesyncd restores its last saved time and NTP corrects it.
touch "$TARGET_DIR/usr/lib/clock-epoch"

cat > "$TARGET_DIR/etc/raphael-release" <<REL
RAPHAEL_GIT=$(git -c safe.directory='*' -C "$BR2_EXTERNAL_RPI3_PATH" describe --always --dirty 2>/dev/null || echo uncommitted)
RAPHAEL_KERNEL=$(cd "$TARGET_DIR/lib/modules" && ls -d *-v8+ 2>/dev/null) (Raspberry Pi's build)
REL
