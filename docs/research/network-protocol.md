> Research report generated 2026-10-20 by a research agent, followed by an adversarial fact-check (the VERIFY section). Where the two disagree, the fact-check wins, and docs/spec/ has the reconciled decisions. Kept here for traceability and sources.

# network-protocol

## SUMMARY
I recommend a hybrid design. ESP-NOW carries all realtime traffic on one network channel, and the hub reaches the radio through one or more ESP32 gateways plugged into the hub host by USB (an ESP32-S3 is the best fit). Nodes can also join Wi-Fi as a station (a "sidecar") for heavy traffic: OTA downloads over HTTP, log streaming, agent debugging, and a UDP fallback when no gateway is reachable. The channel constraint is the deciding fact. Once a station is connected to a router, ESP-NOW can only use that router's channel, so the gateway owns the channel choice: it uses the router's channel when a router is configured (router-anchored mode) and a fixed channel otherwise (standalone mode). Broadcast ESP-NOW frames cannot be encrypted, and native encryption is capped at 17 peers (7 by default) shared with SoftAP keys. Security therefore lives in the application layer: AES-128-CCM with a network key, plus a per-source window keyed on boot counter and sequence number that handles both duplicate filtering and replay protection. I recommend not building on Espressif's esp-now component. Its duplicate filter uses a 16-bit random id with a 32-entry cache that ignores the sender, so it drops roughly 1 in 2,000 legitimate messages. It also retransmits broadcasts blindly 10 times by default, and its 1470-byte support is merged but unreleased. Its OTA resume and security handshake are worth copying. One 18-byte envelope (26 bytes with the auth tag) is used on every link (ESP-NOW, UDP and USB), so the hub and the generated JS library only ever deal with one format. Hub broadcasts are re-flooded by nodes with a hop limit, random delay and duplicate suppression. Unicast reliability combines the radio's own acknowledgement with end-to-end ACKs, retries and duplicate filtering. My calculated latency for button press to JS callback is about 2-4 ms typical through the gateway, versus about 3-10 ms typical with tails up to about 100 ms through the router. The router path is worse partly because a Mac hub on Wi-Fi suffers AirDrop-related (AWDL) latency spikes of 3-90 ms. All latency numbers must be confirmed by the benchmarks in the acceptance tests on your boards.

## RECOMMENDATION
Primary topology: a gateway-anchored ESP-NOW network with an optional Wi-Fi sidecar on each node.
- Realtime traffic (events, commands, presence, floods, small RPC) runs over ESP-NOW v2 on one network channel. Realtime frames stay at 250 bytes or less; frames up to 1470 bytes are allowed only for bulk traffic.
- The hub is a logical address (0x0000) served by the host daemon. One or more USB-attached gateway ESP32s act as transparent bridges: COBS-framed frames over USB Serial/JTAG, with the gateway sending its own beacons. When there are several gateways, the hub filters duplicates.
- Each node has a Wi-Fi station policy: always, on_demand or off. It is used for OTA by HTTP pull, logs, agent debugging, and the UDP fallback path. The station may associate only if that keeps the radio on the network channel, except during explicit maintenance windows.
- Channel ownership: the gateway decides. In router-anchored mode the network channel is the router's channel, and the gateway also connects to the router so it follows channel changes. In standalone mode a fixed channel is used; default 1 or 11, avoiding 6 near Macs because AirDrop/AWDL favours it.
- Fallback when no gateway is attached ("router mode", topology i): every node joins the router as a station with power saving off. The same envelope goes over UDP to the hub, which is found by mDNS, the gateway beacon or the provisioning record. ESP-NOW node-to-node traffic still works on the router channel.
- Rejected: an ESP32 SoftAP as hub (10-15 station limit, hub host has to join it) and ESP-WIFI-MESH / Mesh-Lite (heavy, slow to heal, tied to the router channel).

Protocol:
- One 18-byte little-endian envelope with optional fragment and extension blocks, an encrypted payload and an 8-byte AES-128-CCM tag.
- 16-bit addresses: 0x0000 hub, 0x0001-0xEFFF nodes, 0xF000-0xFEFF groups, 0xFFFE unassigned, 0xFFFF broadcast.
- Message classes: NET, PRESENCE, ACK, EVENT, CMD, STATE, RPC_REQ, RPC_RES, LOG, OTA, TIME.
- Duplicate filtering and replay protection share one per-source window: boot counter + 32-bit sequence + 64-bit bitmap.
- Flooding: hop limit 3, random delay 0.5-4 ms, suppression after hearing 2 copies.
- Reliable delivery: end-to-end ACK with a timeout of 20 ms + 10 ms per hop and up to 4 attempts. "Latest wins" mode for state streams. Broadcast repair through a heartbeat watermark.

Presence: heartbeat every 1000 ms ±10% (250 ms in the game profile). A node is suspect after 2.5 intervals without traffic, gets a PING, and is offline after 3.5 intervals (at least 750 ms). That is 3.5 s by default and 875 ms in the game profile. A node sends BYE for a graceful exit. The gateway beacons every 1 s; three missed beacons send a node to the UDP fallback or channel discovery. The USB link to the gateway pings every 250 ms and times out after 1 s.

Radio settings: power saving off (WIFI_PS_NONE), peer channel set to 0, per-peer data rate via esp_now_set_peer_rate_config. Use a "robust" 1 Mbps profile for the proof of concept and a "fast" 6 Mbps (OFDM or MCS0) profile for games or more than about 30 active nodes. Keep a peer-table LRU within the 20-peer limit, allow one send in flight, use priority transmit queues, and filter received frames by channel and network id.

Proof-of-concept hardware: ESP32-S3 as gateway on the Mac's USB, ESP32-C6 as the BOOT-button EVENT node, ESP32-C3 as the LED CMD node. Use router-anchored mode with nodes always on Wi-Fi, so HTTP OTA works from day one. Turn security on with a debug switch to turn it off.

## RATIONALE
1) The channel coupling is fixed by the platform. Espressif's FAQ says ESP-NOW must use the connected AP's channel and cannot switch while connected. Peers with a non-zero channel must match the current channel. esp_wifi_set_channel must not be called while the station is scanning or connecting. A design where nodes connect to a router and also use ESP-NOW is therefore always hostage to the router's channel, roaming and reboot behaviour. Making the gateway the channel owner turns that into a managed event: a WIFI_EVENT_HOME_CHANNEL_CHANGE event exists, and IDF 6.x adds esp_now_switch_channel_tx and remain_on_channel.

2) Latency and determinism favour one radio hop to a USB gateway. ESP-NOW is connectionless, with no association, DHCP or AP queueing. By my calculation (not measured), a ~32-byte payload takes about 1.5 ms of airtime at 1 Mbps and about 0.3 ms at 6 Mbps, including ACK and backoff. USB adds roughly 1 ms. A Mac hub on Wi-Fi adds a second wireless hop and AWDL spikes of 3-90 ms (RIPE 91 research). Electric UI measured tuned ESP32 Wi-Fi UDP at a median of ~9 ms, TCP at ~6 ms and untuned sockets at 74-84 ms. They measured single ESP-NOW packets at ~5 ms with their framework; separately, a user in IDF issue 3238 reported round trips under 0.7 ms after raising the data rate.

3) Wi-Fi still earns its place for bulk transfers (HTTP OTA is much faster than 1 Mbps ESP-NOW chunks), for agent and IP reachability, and as a fallback when no gateway is present. That is why it is a sidecar rather than the realtime path.

4) Security has to live in the application layer. ESP-NOW cannot encrypt broadcast frames, and encrypted peers top out at 17 (default 7), sharing keys with SoftAP. A per-source boot-counter-and-sequence window gives exact duplicate filtering, protects against replays and guarantees unique encryption nonces at once.

5) Building our own envelope is cheap and avoids the esp-now component's structural problems. Its duplicate cache matches only message type and a 16-bit random id, not the sender, so it falsely drops about 0.05% of messages; at 100 messages per second that is one drop every ~20 s. It retransmits broadcasts 10 times by default. Its OTA chunks are 230 bytes, and its v2 support is unreleased. It is still actively maintained (commits Sept 2026, Apache-2.0), so its ideas are worth borrowing.

6) Managed flooding with jitter and suppression after k copies follows established practice (RFC 7731 MPL with Trickle, Bluetooth mesh relay with a message cache). It meets the requirement that nodes rebroadcast what others might have missed without causing broadcast storms.

7) Airtime math drives the rate profiles. At 1 Mbps, plan for about 240 frames per second per channel; at 6 Mbps, about 1,200. A 32-node game profile generates about 770 frames per second, so it needs at least 6 Mbps.

## ALTERNATIVES
- **(i) Every node a Wi-Fi station on the router, with ESP-NOW on the router channel and UDP/WS to the hub (the user's original sketch)** — verdict: Supported as the fallback (router mode), used automatically when no gateway is reachable. Not the primary realtime path.
- **(ii) ESP-NOW-only nodes plus a USB-attached gateway ESP32** — verdict: Core of the recommendation, extended with the Wi-Fi sidecar to cover bulk transfers and IP access.
- **Recommended hybrid: (ii) realtime plane + per-node Wi-Fi sidecar (always/on_demand/off) + gateway owns the channel (router-anchored or standalone)** — verdict: RECOMMENDED. For the proof of concept, use router-anchored mode with nodes always on Wi-Fi.
- **(iii) Hub ESP32 runs a SoftAP on a fixed channel; nodes associate to it** — verdict: Rejected as a topology. Possibly a temporary provisioning or OTA helper in standalone mode.
- **(iv) ESP-WIFI-MESH or ESP-Mesh-Lite** — verdict: Rejected: overkill for low-latency input networks and conflicts with the ESP-NOW plane.
- **Adopt espressif/esp-now (espnow_send, forwarding, control, OTA, security) as the transport** — verdict: Do not use as the core transport. Copy the espnow_ota resume-bitmap design and the security handshake pattern. Optionally use its debug console during development.
- **Hub-to-node link over Wi-Fi: UDP datagrams vs WebSocket vs MQTT vs raw TCP** — verdict: Use UDP for the realtime fallback and HTTP for OTA downloads. TCP/WS only for log or console streams. MQTT only as an optional hub-side integration, never on devices.

## RISKS
- Router-anchored mode ties the network channel to the router. Router auto-channel changes, reboots or multi-AP roaming can split or interrupt the ESP-NOW network. → The gateway owns the channel and reacts to WIFI_EVENT_HOME_CHANNEL_CHANGE by sending CHANNEL_SWITCH and beaconing at 4 Hz. Pin all nodes to one AP (BSSID). Reconnect with single-channel scans only, never all-channel scans while the gateway beacon is still heard. Offer standalone mode with a fixed channel. Use IDF 6.x off-channel send once on 6.x.
- Airtime saturates at the default 1 Mbps with many nodes or high event rates (about 240 frames/s usable). → Rate profiles: fast = 6 Mbps or higher, chosen per peer by RSSI. Heartbeat jitter, coalescing, the latest-wins class, flood suppression, and 1470-byte bulk frames only at 6 Mbps or higher and only when no URGENT traffic is queued.
- Gateway is a single point of failure, and only one process can own its serial port (Chrome Web Serial currently holds /dev/cu.usbmodem1101). → The hub daemon owns gateway ports exclusively and the dashboard never opens gateway ports via Web Serial. Support several gateways with duplicate filtering. Sidecar nodes fall back to UDP within about 3 s.
- Encryption nonce reuse if the boot counter is not persisted before the first secure transmit, or if NVS is wiped while the network key stays the same. → Increment and commit the boot counter in NVS before the first secured transmit, and refuse secured transmits if the commit fails. Re-provisioning resets the key. Rotate the key before the 16-bit counter wraps.
- Latency and throughput figures are calculated or come from other hardware and setups; Super Mini RF quality varies. → Make the acceptance-test benchmarks (GPIO loopback round trip, flood coverage, presence timing) a PoC exit gate. Store transmit power per board in the hardware library. Report RSSI and transmit failure counts in heartbeats.
- ESP-IDF API changes between 5.5 and 6.x: rate API removed, send-callback signature changed in 5.5, PSA-only crypto in 6.0, new off-channel APIs. → Pin one IDF version per release train. Wrap ESP-NOW and crypto in a thin portability layer (pp_radio, pp_crypto on the PSA AEAD API). Run CI builds against 5.5.x and 6.1.
- Adjacent-channel reception (HT20 leakage) and foreign ESP-NOW traffic can cause bogus processing or extra relaying. → Drop frames whose rx_ctrl channel differs from the network channel, or whose magic/version or network id do not match. Authenticate before relaying when security is on.
- Broadcast storms or relay loops in dense networks. → TTL of 3 or less by default, suppression after k copies, per-source rate limits, duplicate window before relay, relaying disabled per node where needed.
- The station sidecar's reconnect scans pull the radio off-channel and cause missed realtime frames. → Reconnect policy: single-channel active scan of the network channel every 5-30 s with backoff. All-channel scans only when gateway beacons are also lost, or in a maintenance window.
- Replay of old hub commands after a node reboot, when its in-RAM window is empty. → A node accepts hub frames only after an authenticated BEACON has given it the current hub boot counter, and rejects older ones. Commands can carry an absolute execution time or deadline.

## OPEN QUESTIONS
- Will a USB gateway always sit next to the hub host, or must some deployments reach a remote hub only through the router (gateway uplink over Wi-Fi or UDP)?
- Is the hub Mac on Ethernet or Wi-Fi? (Wi-Fi adds AWDL spikes of 3-90 ms to router mode.)
- Expected scale and spread: how many nodes, single room or whole house? This sets the hop limit and data-rate profile.
- Is your router a single access point or a mesh Wi-Fi system with several APs? Is a 2.4 GHz band available, and do you know its channel and whether auto-channel is on?
- Are battery-powered (sleeping) nodes in scope for v1, or are all nodes USB-powered for now?
- Should security (authenticated encryption) be on by default even in prototypes, with a debug switch to turn it off, or off by default?
- Which ESP32-S3 board exactly (PSRAM? which USB port is wired)? It is the preferred gateway. Which board is currently on /dev/cu.usbmodem1101?
- Expected input rates: buttons only, or analog or IMU streams at 50-200 Hz? This decides whether the STATE/latest-wins class and the fast rate profile are needed in the PoC.

## VERIFY: holds=True
### Challenge
The strongest case against the recommendation:

1. **It changes the user's stated design.** The user specified Wi-Fi for node-to-hub traffic. The report makes ESP-NOW through a USB gateway the primary hub path, which adds required hardware and takes one of the user's three boards (the S3) for the PoC. Fine, but it needs explicit user sign-off.

2. **The headline latency win is calculated, not measured.** The only measured public comparison (Electric UI) puts stock 1 Mbps ESP-NOW at about 5 ms against tuned TCP at about 6 ms, and that TCP result went ESP32 to AP to ESP32 (two radio hops). Node to AP to a wired Mac is one hop, so tuned router-mode medians are plausibly 2-5 ms. What the gateway really buys is:
   - independence from the router and portability (works with no router);
   - determinism: no AP queueing and no Mac Wi-Fi/AWDL in the path;
   - USB is not subject to macOS Local Network privacy;
   - not a lower median.

3. **The PoC picks the most complex configuration.** Router-anchored mode with nodes always on Wi-Fi plus a gateway keeps every router-channel coupling of topology (i). It also adds the gateway, link selection, cross-link dedupe and channel-follow logic, with only two nodes to justify it.

4. **The flood parameters will not suppress relays in a dense room at 1 Mbps.** J_MAX = 4 ms is shorter than airtime plus driver plus RX-task latency, so most nodes commit their relay before hearing 2 copies. That risks the broadcast storm the design aims to avoid. In a single room, relaying adds little anyway.

5. **The '6.x-only' framing is wrong.** The off-channel APIs (esp_now_switch_channel_tx and esp_now_remain_on_channel) are in v5.5.2+, so the 'move to 6.x for off-channel send' plan is unnecessary.

**Is there a materially better alternative?** Not a different architecture. The link-agnostic envelope, app-layer AEAD, rejecting the esp-now component, and a gateway as an option are all sound. A better plan is to re-sequence:
- **M1:** router mode only. UDP envelope to the hub, ESP-NOW node-to-node on the router channel, HTTP OTA, no gateway. This meets the user's stated design with zero extra hardware and tests the protocol core.
- **M2:** add the USB gateway in standalone mode (fixed channel, nodes with Wi-Fi on_demand). This is the configuration where the gateway's advantages are real. Run T2 on both paths and promote the gateway to the default only where the measurements justify it.

Treat router-anchored and always-on mode as a later compromise, not the PoC default. Also pin to IDF v5.5.6, not v5.5.1.
### Refuted/uncertain
- [refuted] Default ESP-NOW rate is 1 Mbps. Per-peer rate is set with esp_now_set_peer_rate_config(). esp_wifi_config_espnow_rate() is deprecated in v5.5.1 and removed in v6.1.
  → esp_wifi_config_espnow_rate() was removed in v6.0, not v6.1: the v6.0 Wi-Fi migration guide lists it as removed, and the v6.0.3 header no longer declares it. Also, the v5.5.1 rst documents esp_now_set_peer_rate_config only for the C6; the C3/S3 doc pages still describe the old API. The header is common to all targets, but no IDF example uses the per-peer API, so verify it on C3/S3. (https://docs.espressif.com/projects/esp-idf/en/latest/esp32c6/migration-guides/release-6.x/6.0/wifi.html ; https://raw.githubusercontent.com/espressif/esp-idf/v6.0.3/components/esp_wifi/include/esp_now.h ; esp_now.rst L120-133)
- [refuted] ESP-IDF v6.x adds esp_now_switch_channel_tx() and esp_now_remain_on_channel(); how they behave while the station is connected is undocumented.
  → Both APIs are already in v5.5.2 and v5.5.6, though not in the local v5.5.1. They do not need 6.x; upgrading 5.5.1 to 5.5.6 provides them. v5.5.1 already has the generic esp_wifi_action_tx_req() and esp_wifi_remain_on_channel(). The 'undocumented while connected' part is correct: the doc comments have no @attention notes. (https://raw.githubusercontent.com/espressif/esp-idf/v5.5.2/components/esp_wifi/include/esp_now.h ; https://raw.githubusercontent.com/espressif/esp-idf/v5.5.6/components/esp_wifi/include/esp_now.h ; local esp_wifi.h L1825-1846)
- [refuted] ESP-NOW frame overhead is 43 B plus payload.
  → 43 B is right only for payloads of 250 B or less (one vendor element). v2 bodies are split into 250-B vendor elements of 7 B each (the doc gives x = 1470 + 6*7). A 1470-B payload therefore carries about 78 B of overhead, so it takes about 12.6 ms at 1 Mbps, not 12.3 ms. Minor. (esp_now.rst Frame Format (v2.0 element layout, 'x = 1512(1470 + 6*7)'))
- [uncertain] The number of hardware MAC retries for ESP-NOW unicast is neither documented nor configurable; broadcast frames are not ACKed.
  → No doc or Kconfig value was found, which is consistent with the claim, but nothing positively confirms a retry count. (https://esp32.com/viewtopic.php?p=122643 ; esp_now.rst)
- [refuted] In espressif/esp-now, all frames are broadcast at the radio level.
  → Broadcast is only the default (ESPNOW_FRAME_CONFIG_DEFAULT sets .broadcast=true). espnow_send uses `(frame_head->broadcast) ? ESPNOW_ADDR_BROADCAST : dest_addr`, so radio-level unicast is supported. Only espnow_set_group always broadcasts. (https://raw.githubusercontent.com/espressif/esp-now/master/src/espnow/src/espnow.c (espnow_send, espnow_send_forward))
- [uncertain] esp-now OTA chunks are 218/230 B.
  → The legacy ESPNOW_PAYLOAD_LEN fallback of 230 is confirmed. The 218-B OTA chunk figure was not verified. (https://raw.githubusercontent.com/espressif/esp-now/master/src/espnow/include/espnow.h)
- [refuted] The Mesh-Lite repo was last pushed 2025-09-30, with no SPDX license detected.
  → pushed_at 2025-09-30 is correct and the GitHub API license is null. But the registry component espressif/mesh_lite (1.0.2, 2025-07-04) is Apache-2.0, so 'no license' is misleading. (https://api.github.com/repos/espressif/esp-mesh-lite ; https://components.espressif.com/api/components/espressif/mesh_lite)
### Missed
- Duplicate/replay window flaw: one 32-bit seq per source is shared by every class and destination, and the window is only 64 bits. A Q1 retry (up to 450 ms later) of a frame whose original was lost lands below the window as OLD once the source has sent 64 or more newer frames (e.g. 200 Hz STATE streams). It is dropped silently with no ACK, so delivery fails falsely. Use a larger window at the hub (256-1024 bits), separate seq spaces per QoS, or a cached-ACK path for OLD Q1 frames.
- Nonce-reuse hazard in LATEST coalescing: if a queued frame's payload is updated but it keeps its seq (coalescing or 'retry keeps original seq'), AES-CCM reuses the CTR keystream with different plaintext. The spec must require a fresh seq whenever ciphertext changes, and should also cover the hub's own epoch persistence (a hub DB reset with the same NetKey reuses nonces).
- A single shared NetKey lets any node, including a compromised one, forge frames from any src including the hub (0x0000): CMD, OTA/OFFER, CHANNEL_SWITCH. Consider per-node hub-to-node keys or hub signatures for control/OTA. Use signed app images (CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT or Secure Boot v2) because OTA runs over plain HTTP.
- esp_now_set_user_oui() exists in v5.5.1. A per-framework OUI would filter foreign ESP-NOW traffic in the driver, before the receive callback and AEAD cost. Not mentioned.
- IDF v5.5.2+ already has esp_now_switch_channel_tx/esp_now_remain_on_channel. Upgrade the local 5.5.1 to 5.5.6 rather than waiting for 6.x. Behaviour while a station is connected must be tested on hardware.
- macOS Local Network privacy (macOS 15+, the user runs macOS 26) can silently block UDP/mDNS from a hub daemon launched by an app (Claude desktop, VS Code terminal) rather than Terminal or a launchd daemon (TN3179 exemptions). This hits router-mode UDP and discovery; it does not affect USB. The daemon should run as a launchd job.
- Native USB-Serial/JTAG reset semantics: some host serial libraries assert DTR/RTS on open, which can reset the gateway or hold it in download mode and stop beacons. The hub daemon must open the port with explicit DTR/RTS control and identify gateways by USB iSerial (chip MAC), not /dev/cu.usbmodemXXXX paths, which change with the port. The unknown S3 board may expose a UART bridge (CH34x/CP210x) instead, with different latency and reset wiring.
- BLE or 802.15.4 coexistence (e.g. BLE provisioning, or Thread on the C6) makes WIFI_PS_NONE ineffective: Wi-Fi sleeps outside its time slice, causing ESP-NOW RX loss. The realtime profile should require the BLE controller to be deinitialised after provisioning.
- Peer-table churn on the gateway beyond 19 nodes: every unicast to a non-resident node needs esp_now_del_peer/add_peer. Its cost and thread-safety from the TX task are unmeasured. Alternatively use broadcast-MAC 'flooded unicast' and accept losing the radio ACK.
- Address 0xFFFE (UNASSIGNED) is shared by all unprovisioned devices, so a per-src window makes concurrent joiners collide (replay/OLD drops). Key the window by MAC for 0xFFFE.
- If apps consume events on another device (e.g. a browser game on a tablet), the hub-to-app leg goes back over Wi-Fi and the gateway's latency advantage disappears. The JS library's deployment location matters for the topology decision.
- Standalone channel selection should use a site survey (the gateway scans and picks the least-busy of 1/6/11 under the configured country), not a fixed default of 1.
- esp_https_ota rejects plain http:// unless CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y (default n, marked testing-only). Rollback needs CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE. Neither is in the spec.
- Dashboard flashing via Chrome Web Serial (esptool-js) conflicts with the daemon's exclusive port ownership. Flashing must also be routed through the daemon, or ownership handed off explicitly. Chrome currently holds /dev/cu.usbmodem1101.
### Spec errors
- 5.3 Data rate row / risks: 'esp_wifi_config_espnow_rate is deprecated in 5.5 and removed in 6.1'. It was removed in v6.0 (6.0 Wi-Fi migration guide; absent from the v6.0.3 header).
- 5.4 Unplanned switch and 5.16 ('On IDF 6.x it also sends CHANNEL_SWITCH ... with esp_now_switch_channel_tx()'): the API is in v5.5.2 through v5.5.6. The gate should be 'IDF >= 5.5.2', and 5.20 should pin v5.5.6, not v5.5.x starting at the local 5.5.1.
- 5.4 Station sidecar rules: 'connects with wifi_sta_config_t.channel = net_channel and the BSSID pinned ... This avoids all-channel scans' is wrong. The channel field only sets scan order (net_channel first, then 1..N), so if the AP is absent on net_channel, connect still sweeps every channel. Only the preceding single-channel esp_wifi_scan_start gate helps, and it is racy.
- 5.9 parameters: J_MAX = 4 ms with K_SUPPRESS = 2 cannot suppress in a dense room at 1 Mbps. A broadcast relay takes ~1.15 ms of airtime plus driver/RX-task latency, and frames handed to esp_now_send cannot be cancelled. Nearly all nodes with timers under ~3 ms relay, so 'Expected cost: 1 + (2 to 4) transmissions' is wrong for N >> 4. It also contradicts the cited MPL guidance (Imin = 10x link latency, i.e. at least 15-20 ms at 1 Mbps). Use a larger J_MAX, probabilistic or RSSI-gated relay, or TTL=1 by default for single-room deployments.
- 5.8 Duplicate window: a 64-bit bitmap over a per-source seq shared by all classes and destinations rejects legitimate Q1 retries as OLD under high-rate STATE traffic. The window size and seq-space design need revision.
- 5.8 E2E reliability: 'Up to 4 attempts ... gives up after about 300 ms' holds only for 0 hops (20+40+80+160). With 1 hop the waits are 30+60+120+240 = 450 ms; for 2 hops, 600 ms.
- 5.13 Replay protection: 'Nodes accept hub-originated frames only after an authenticated BEACON has given them the current hub_epoch'. Beacons are originated by the gateway (its own src and seq), and the BEACON payload has no hub seq floor. After a node reboot, any captured hub frame from the current hub_epoch can be replayed. Add hub_seq_floor (u32) to the BEACON payload.
- 5.7 PRESENCE/HELLO hb_interval_ds is u8 (max 25.5 s), but the battery profile in 5.2 specifies 10-30 s heartbeats. 30 s does not fit. Use u16 or a coarser unit.
- 5.7 HEARTBEAT free_heap_kb is u8 (max 255 KB). It overflows on an S3 with PSRAM, and possibly on S3/C6 internal heap. Use u16 or 4 KB units.
- 5.6 / 5.8 window keyed by src: all unprovisioned devices use src 0xFFFE, so concurrent JOIN_REQs from different devices collide in one window entry. The window must be keyed by MAC for 0xFFFE.
- 5.19 T4: 'Unplug a node: offline in 3.5 s ±0.3' measured from the unplug is wrong. OFFLINE fires 3.5 s after the last received frame, which comes 0-1.1 s before the unplug, so the expected range from unplug is about 2.4-3.5 s. Measure from the last heartbeat, or state the range.
- 5.15 / 5.3 '1470 B ... about 12.3 ms at 1 Mbps' omits the v2 multi-element overhead (6 x 7-B vendor elements per the esp_now.rst frame format). It is about 12.6 ms; the 6 and 24 Mbps figures are about 2.1 and 0.54 ms.
- 5.3 Data rate: 'The broadcast peer also gets a rate config'. Whether esp_now_set_peer_rate_config applies to FF:FF:FF:FF:FF:FF is undocumented, and v5.5.1 documents the per-peer API only for the C6. Mark both as must-verify on C3/S3/C6.
- 5.12.4 OTA: 'GETs http://hub... using esp_https_ota' requires CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y (default n). 'Marks app valid; otherwise rolls back' requires CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE. Both are missing.
- 5.12.4 ESP-NOW OTA fallback: 'Chunks up to 1424 B' is inconsistent with 5.6 (1470 - 18 - 8 - 6 = 1438 B max for CHUNK with SEC). Either explain the reserve or correct the number.
- 5.17: the reason given for not adopting esp-now omits that its default config is broadcast, not that all frames are broadcast (unicast is supported). The 'about 0.05% falsely dropped' figure is an upper bound (32/65536) that applies only when the 32-entry cache is full of the same message type.
- 5.7 EVENT t_us and CMD exec_at_us are u32 µs and wrap every ~71.6 min. Wrap-around comparison semantics (serial-number arithmetic) must be specified, and so must the u32 rx_ctrl.timestamp used in TIME sync.
- 5.12.2: 'The AP buffers group frames until DTIM' applies only when an associated station is in power save. The advice is still right, but the stated cause should be conditional.
- Rationale / key facts: '[Mesh-Lite] no SPDX license detected' is misleading. The registry component espressif/mesh_lite is Apache-2.0 (GitHub API license field is null).
