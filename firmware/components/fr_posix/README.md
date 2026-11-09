# fr_posix

Fractonica's node runtime on a POSIX host: a Linux board can join the fleet as a device and run the same code as an ESP32 node. That code is the `fr_net` core, the `fr_core` services and display backends, and the generated capability dispatch. The first user is `qonu-node` on the Arduino UNO Q ([`hosts/uno-q/node`](../../../hosts/uno-q/node), design [uno-q-host](../../../docs/design/uno-q-host.md)).

| Piece | What it is |
|---|---|
| `PosixCore` | `fr::Core` on the steady clock: timers, input slots and a post queue. It is run by one thread, and `post()` may be called from any thread |
| `TcpLink`, `UdpLink` | The hub links of spec 05 §5.12.1–2. The hub's name is resolved at every connect, over mDNS on Linux with systemd-resolved. Connects don't block, with `hub_link.cpp`'s backoff and timeout. Sends go through an 8 KB TX buffer |
| `Device`, `NodeCap` | What `Net` asks of a node (HELLO facts, identity, dispatch) and `fr.node` on port 0. There is no OTA: a Linux node updates with its image. `fr.node.reboot` exits with `kExitRestart` (75) for the service manager to restart the process |
| `IdentityFile` | addr, net, alias, alias_rev, epoch and the hub's `host[:port]` in one text file, replaced atomically. `begin_boot()` raises the epoch and writes it before anything is sent (spec 05 §5.5) |
| `FileBlob`, `InlineWorker` | `Net`'s directory and binding blobs as files, and `fr_worker` on the node's thread |
| `Runner` | The loop: `poll()` on the hub socket and the app's descriptors, then the core, the worker and the app's hook. SIGTERM sends a BYE shutdown before exiting |

**Build.** `fractonica-posix.cmake` builds the IDF-free framework and this component as one static library, `fr_posix`. It is the same source set the host suite builds, plus `fr_ota`'s BSD-socket HTTP client, which the audio and camera services use:

```cmake
include(<checkout>/firmware/components/fr_posix/fractonica-posix.cmake)
target_link_libraries(my-node PRIVATE fr_posix)
```

**Test hooks.** `FR_POSIX_TEST_HOOKS` (on by default) builds with `FR_TEST_HOOKS` like the ESP32 debug builds, so `display_snapshot` and `input_simulate` work.

**Status.** Built with GCC 14 on aarch64 Linux and run on the UNO Q against a hub (2026-11-09). The host suite's `fr_net_node` and the fleet kit still use their own copies in `firmware/test/host`; moving them onto this component is a follow-up.
