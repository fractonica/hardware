# qonu-node

The Arduino UNO Q as a Fractonica device: Fractonica's own node runtime on Linux ([`fr_posix`](../../../firmware/components/fr_posix)), with the STM32's outputs as capability instances through `qonu-link`. Design: [docs/design/uno-q-host.md](../../../docs/design/uno-q-host.md).

| Port | Instance | Capability | Hardware |
|---|---|---|---|
| 0 | `node` | `fr.node` | — |
| 1 | `led3` | `fr.led` 1.0: rgb, not dimmable | LED3: a channel lights at 50 % or more |
| 2 | `matrix` | `fr.display` 1.2: mono1, 13×8 | The LED matrix, through `MonoBackend` (5×7 font, primitives) |

Still to come (design §2.5):
- `lcd`: the ST7789 panel through LVGL and a `Blit` op in qonu's link;
- `host`: the Linux vitals as `fr.host`;
- packaging in the image as a service;
- hub support for non-ESP devices.

**Run.** The image runs it as `qonu-node.service`, after `qonu-link`. The hub is configured once, on the board:

```
qonu-node set-hub <hub host>[:7421]    # e.g. the Mac's <LocalHostName>.local; kept in /data/fractonica/node.ident
systemctl restart qonu-node
qonu-node show                         # the identity file: hub, alias, addr, epoch
journalctl -u qonu-node                # connects, closes and why (a repeated failure is logged once)
```

Until a hub is set, the service exits with code 64 and stays stopped instead of restarting. `fr.node.reboot` exits with code 75, and systemd starts it again.

`make node-push` (from `hosts/uno-q`) builds it with Buildroot against the checkout mounted at `/fr`, then installs the binary and the unit on the board and restarts it.

**Options:**
- `--data DIR` sets where identity, epoch, directory and bindings are kept (default `/data/fractonica`, which survives image reflashes).
- `--socket` sets the qonu-link socket.
- `--iface` sets the interface whose MAC is the device id (default `wlan0`).
- `--hb-ms` sets the heartbeat interval.

**Build** (in the qonu builder, with the Fractonica checkout mounted at `/fr`):

```
cmake -S /fr/hosts/uno-q/node -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo \
      "-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc"
make -C build qonu-node
```

**Measured (2026-11-09, against a private hub on the Mac over the USB link):**

| Measure | Result |
|---|---|
| Binary | 1.3 MB stripped, linked to libc and libm only |
| Hub lookup | found by name (`dimas-3.local`) over mDNS |
| `led3.set` | `ok` in 5 ms, then `led3.on` and `led3.color` |
| `led3.blink` | `led3.effect_done` |
| `matrix.text "Hi!"` | `ok` in 3 ms; `display_snapshot` of the 13×8 framebuffer in 8 ms |
| `node.get_state` | every property reported again |
| TCP ping | p50 3.2 ms |

**On the lab hub (2026-11-09), as the image's service:**

| Measure | Result |
|---|---|
| Binary (Buildroot, Release, shared libstdc++) | 367 KB |
| RSS | 5.3 MB |
| `led3.set` | `ok` in 6–7 ms |
| `matrix.text "Fr"` | `ok` in 3 ms; the snapshot matches |
| TCP ping over the USB link | p50 1 ms |
| `node.reboot` | BYE `reboot`, exit 75, systemd restart; back online with the epoch raised (1 → 2) |
