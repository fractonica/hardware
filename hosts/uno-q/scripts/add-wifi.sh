#!/bin/bash
# Adds a Wi-Fi network to local/wifi/ in iwd's format. It is baked into every
# image built afterwards, and pushed straight to the board if it is reachable
# over USB. Run it yourself; it prompts for the passphrase without echoing it.
set -euo pipefail
cd "$(dirname "$0")/.."
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

# Push to a running board: iwd watches /var/lib/iwd and connects on its own.
SSH=(ssh -F local/ssh_config -o BatchMode=yes -o ConnectTimeout=3 uriel-usb)
if ! "${SSH[@]}" true 2>/dev/null; then
	echo "Board not reachable over USB; flash a new image, or connect on the board with: iwctl station wlan0 connect \"$ssid\""
	exit 0
fi
base=$(basename "$file")
"${SSH[@]}" "umask 077; cat > '/var/lib/iwd/$base' && iwctl station wlan0 scan" < "$file"
echo "Pushed to the board; waiting for it to join \"$ssid\"..."
for _ in $(seq 30); do
	ip=$("${SSH[@]}" "ip -4 -o addr show wlan0 2>/dev/null" | awk '{print $4}' | head -n1)
	if [ -n "$ip" ]; then
		echo "Joined: wlan0 $ip. Try: make ssh  (uriel.local)"
		exit 0
	fi
	sleep 1
done
echo "Not connected after 30 s. Check on the board: iwctl station wlan0 show; journalctl -u iwd" >&2
exit 1
