#!/bin/bash
# Adds a Wi-Fi network to local/wifi/ in iwd's format. It is baked into every image built afterwards, and
# pushed straight to the Pi if it is reachable. Run it yourself; it prompts for the passphrase without echoing it.
# The Pi 3's radio is 2.4 GHz only.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${RPI3_HOSTNAME:-raphael}
mkdir -p local/wifi
read -r -p "SSID: " ssid
[ -n "$ssid" ] || { echo "empty SSID" >&2; exit 1; }
read -r -s -p "Passphrase (empty for an open network): " pass; echo

# iwd file names: plain if the SSID is only [A-Za-z0-9 _-], otherwise "=" + hex
if [[ "$ssid" =~ ^[A-Za-z0-9\ _-]+$ ]]; then name=$ssid
else name="=$(printf '%s' "$ssid" | xxd -p | tr -d '\n')"; fi

umask 077
if [ -z "$pass" ]; then
	file="local/wifi/$name.open"
	: > "$file"
else
	[ ${#pass} -ge 8 ] && [ ${#pass} -le 63 ] || { echo "WPA passphrases are 8-63 characters" >&2; exit 1; }
	file="local/wifi/$name.psk"
	# iwd's settings syntax: a backslash and spaces are escaped.
	esc=${pass//\\/\\\\}
	esc=${esc// /\\s}
	printf '[Security]\nPassphrase=%s\n' "$esc" > "$file"
	unset esc
fi
unset pass
echo "saved $file (included in the next make build)"

# Push to a running Pi: iwd watches /var/lib/iwd and connects on its own.
SSH=(ssh -F local/ssh_config -o BatchMode=yes -o ConnectTimeout=3 "$HOST")
if ! "${SSH[@]}" true 2>/dev/null; then
	echo "The Pi is not reachable; flash a new image, or join on its console with: iwctl station wlan0 connect \"$ssid\""
	exit 0
fi
"${SSH[@]}" "umask 077; cat > '/var/lib/iwd/$(basename "$file")' && iwctl station wlan0 scan" < "$file"
echo "Pushed to $HOST; iwd joins on its own."
