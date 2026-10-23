# M1 demo from a fresh hub (2026-10-23)

**Covers:** the [11 §11.5](../spec/11-roadmap.md) M1 demo script (the definition of done), run end to end from a fresh hub and blank boards. It closes the one item left open by step 7 ([spike note](2026-10-23-m1-step7.md)).

**Setup:**
- **The lab hub was stopped,** and its `~/.fractonica` left untouched.
- **The demo hub** was `FR_HOME=~/fr-demo-home`: an empty registry, no network record, no artifacts and no secrets. Only the installed Python toolchain (`pytools`) and the ESP-IDF environment cache were linked in from the lab home; neither is hub state.
- **The boards** were the C3 OLED board `1cdbd4175cc4` (C3 #2) and the C6 Super Mini `58e6c5d55e64`, each on one of the Mac's two USB data ports. Both were erased with esptool before the hub started (2.5 s and 2.8 s).
- **The other boards** (pad-c3b, pad-s3) were unplugged.
- **Hub:** REGISTRY_HASH `8805351bae42` (commit `3fbb4c2`); Local Network access allowed; the advert registered.

| Step | What happened | Result |
|---|---|---|
| 1. Fresh hub, Wi-Fi once, builds | `fr hub start` (0 devices, no network, no artifacts). The user set the network on the dashboard's Network page (TENRETNI; the password went to the fresh `secrets.json`, mode 0600; net id 31734). `fr build` took 16.2 s for c3o-pad and 13.8 s for c6-pad, with 0 diagnostics | ✅ |
| 2. Provision from the dashboard | Ports → Provision on each blank board. The wizard said "Provision a new board — the registry has not seen it". The network step was skipped (set), the profile was auto, aliases pad-c3 and pad-c6. All 9 stages passed (lease … join) for both; Wi-Fi joined; online | ✅ |
| 3. Press BOOT on pad-c6 | The dashboard tile flashed (`data-flash` on pad-c6). The demo page showed `boot.down`, `boot.up`, `boot.click` in order, none late | ✅ |
| 4. App-level relay | `padC6.on('boot.down') → padC3.status.blink`: the C3 LED blinked (seen by the user). Press → RESULT 33.0 ms | ✅ |
| 5. Broadcast "ping" | After `fr bind pad-c3.msg:ping …` and the same for pad-c6, the demo page's Broadcast "ping" produced `status.effect_done {blink}` on both boards. Then `fr send pad-c3 diag.exec '{"line":"net drop_hub_link 60"}'` and a second broadcast: pad-c3's `msgs.ping` went 1 → 2 and its binding fired 1 → 2, through the ESP-NOW flood | ✅ |
| 6. Hub stopped | `fr bind pad-c6.boot.down pad-c3.status.blink '{"count":1}'`, then `fr hub stop`, then 3 real presses: 3 blinks (seen). After the restart, pad-c6 `stats bindings` fired 2 → 5 and `stats nodes` via_espnow +3, via_hub 0, failed 0 | ✅ |
| 7. Deploy and rollback | A log line changed (`m1-demo` in the alive line), then `fr deploy all --via wifi --expect-log m1-demo`: both updated, 17.5 s and 17.4 s, matched. Then `--fault health`: both `ROLLED_BACK (health_timeout)` in 73.5 s and 79.6 s. The edit was reverted | ✅ |
| 8. Agent | A fresh Claude Code session with only the plugin (Haiku 5.5). [Transcript](2026-10-23-m1-demo-step8-transcript.txt); `tests/e2e/t-agent.ts --since c:2.6169 --devices pad-c3,pad-c6`: pass | ✅ |

**Step 8 in detail, from the T-AGENT check:**
- **(a)** `binding_set` into pad-c6 slot 1 (the step-6 binding had been removed first). 10 simulated presses, each proven with `wait_for_event status.effect_done --since`. All 10 fired over ESP-NOW with 0 failed. binding rtt p50 4.82 ms, p99 9.64 ms.
- **(b)** The `identify` log line was changed, then `deploy` over Wi-Fi (job `j_f7f897079ac3`): 2 updated in 29.5 s. Expect was `node.boot`, because the new line only prints on identify; the agent then proved the text with `node.identify` and the USB logs.
- **(c)** `build_start c6-pad-mono` (14.8 s, 0 diagnostics), then `flash_start --plan full` over USB (6.6 s). Identity kept (addr 2, net 31734). The blink and the selftest passed.

## Findings

1. **Stale properties after a profile change** (spotted by the step-8 agent). After pad-c6 moved from `c6-pad` (WS2812) to `c6-pad-mono`, `device_get` still listed `status.brightness` and `status.color`. The hub keeps the property mirror across a change of the device's instances. It should drop the members the new firmware does not have (open after M1).
2. **The dashboard's Ports page** showed no table on its first visit after a hash navigation from the Network page, until a reload. The ports were there (`fr ports ls`). It is probably the first `port_list`'s lsof probe arriving after the render. Watch it.

## Restore

- The demo hub was stopped and the lab hub restarted (REGISTRY_HASH `8805351bae42`, Local Network access allowed).
- `fr devices provision` put pad-c3 (c3o-pad, addr 1, net 53445) and pad-c6 (c6-pad, addr 2) back on the lab hub in 10.9 s and 11.8 s, with their lab bindings re-pushed.
- The agent's `identify` edit was reverted, so the tree is clean.
- pad-c3b and pad-s3 kept their lab identities; plug them in to bring them back online.
- `~/fr-demo-home` is kept. Its `secrets.json` holds a copy of the Wi-Fi password; delete the folder when it is no longer needed.
