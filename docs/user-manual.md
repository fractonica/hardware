# Fractonica user manual

Fractonica runs a network of ESP32 boards from your Mac. A **hub** on the Mac owns every board: it builds and flashes firmware, updates boards over Wi-Fi, collects their logs and events, and lets you, your apps and AI agents drive them. Each board runs the same **node firmware**, assembled from a **profile** that lists its **capabilities** (a button, an LED, a display, a microphone, a camera, …).

This manual is task-first: every section is a set of steps you can follow at the bench, with what you should see. The design notes in [`design/`](design/) and the spec in [`spec/`](spec/README.md) have the full detail.

Contents:

1. [First-time setup](#1-first-time-setup)
2. [Everyday basics](#2-everyday-basics)
3. [Camera (ESP32-CAM)](#3-camera-esp32-cam)
4. [Weighing scale and round display](#4-weighing-scale-and-round-display)
5. [Audio: microphone and speaker](#5-audio-microphone-and-speaker)
6. [Electrosmog listener](#6-electrosmog-listener)
7. [Wi-Fi sensing (CSI) and its sound modes](#7-wi-fi-sensing-csi-and-its-sound-modes)
8. [Buttons, LEDs, bindings and messages](#8-buttons-leds-bindings-and-messages)
9. [Displays and touch](#9-displays-and-touch)
10. [Analog input](#10-analog-input)
11. [The gateway](#11-the-gateway)
12. [Adding a new board](#12-adding-a-new-board)
13. [Firmware updates](#13-firmware-updates)
14. [Testing](#14-testing)
15. [Apps and the SDK](#15-apps-and-the-sdk)
16. [AI agents](#16-ai-agents)
17. [Troubleshooting](#17-troubleshooting)
18. [The bench](#18-the-bench)

Every `fr` command below runs from the checkout (`~/projects/fractonica-hardware`). Add `--json` to any of them for machine-readable output, and `--help` to see all options.

---

## 1. First-time setup

You do this once per Mac.

1. **Check the toolchain.** It checks Node, ESP-IDF 6.1, the esptool sidecar and the `fr` shim, and fixes what it safely can:

   ```bash
   fr doctor --fix
   ```

2. **Start the hub from Terminal**, not from an editor or an agent, so macOS grants Local Network access to Terminal:

   ```bash
   fr hub start
   ```

3. **Check it is healthy.** You should see the version, the IDF pin `ok`, the USB ports and how many devices are online:

   ```bash
   fr hub status
   ```

4. **Store your Wi-Fi network.** Boards join it to reach the hub. Type the password when asked; it is kept only in `~/.fractonica/secrets.json` and never printed:

   ```bash
   fr net set --ssid "<your network>" --password-stdin
   ```

   A second network, for example a 5 GHz one, gets its own name: `fr net set --name 5ghz --ssid "<network>" --band 5g --password-stdin`.

5. **Open the dashboard** at <http://127.0.0.1:7420/>. Its pages are Devices, Live, Ports, Network, Builds and OTA, and Agents.

---

## 2. Everyday basics

| What | Command |
|---|---|
| Which boards exist and which are online | `fr devices ls` |
| One board in detail (links, firmware, properties) | `fr devices get cam-esp32` |
| USB ports the hub sees | `fr ports ls` |
| A board's recent log lines | `fr logs cam-esp32` |
| Follow the log live | `fr logs cam-esp32 --follow` |
| Only warnings and errors | `fr logs cam-esp32 --level W` |
| Events (button presses, state changes, boots) | `fr events cam-esp32` |
| Run a capability command | `fr send pad-c3 status.blink '{"count":3}'` |
| Board health over USB (heap, firmware, reset reason) | `fr diag cam-esp32 info` |
| Reset a USB-attached board | `fr devices reset cam-esp32` |
| Rename a board | `fr devices set pad-c3 --alias kitchen-pad` |
| Running and recent jobs (builds, OTA, streams) | `fr jobs ls` |
| Restart the hub after pulling new code | `fr hub restart` |

A **selector** names one or more boards: an alias (`cam-esp32`), `id:<12 hex>`, `tag:<tag>`, `chip:esp32c3`, `online`, or `all`, comma-separated, with `!` to negate.

Files the hub writes (photos, recordings, WAVs) always go under `~/.fractonica/` (FR_HOME). A path you give must be inside it.

---

## 3. Camera (ESP32-CAM)

**The board:** cam-esp32, an AI-Thinker ESP32-CAM with an OV2640 sensor and a micro-SD card, on its CAM-MB programmer base. The base's micro-USB carries power and a USB-to-serial bridge (CH340). The red LED on the back lights while it boots; the white LED on the front is the flash.

**What it does:** photos to the Mac, a live view in the browser, short streams and timelapses to the Mac, recordings on the card without the hub (list, fetch, delete), sensor settings, the flash LED.

### 3.1 Test the camera, step by step

1. **Connect the board.** Plug the CAM-MB base into the Mac with a micro-USB **data** cable (many micro-USB cables carry power only: if nothing shows up in step 2, try another cable). Leave the SD card in.

2. **Check the hub sees the port.** You should see a row with `ch340` and the device id `80f3da6144d4`:

   ```bash
   fr ports ls
   ```

3. **Check the board is online.** Within about 10 s of power-up:

   ```bash
   fr camera status cam-esp32
   ```

   You should see something like:

   ```text
   cam-esp32 cam: 0 frames, 0.0 fps, last 0 B, idle, sd mounted (2963 MB free), sensor ov2640, max uxga
   no stream
   ```

   `sd mounted` means the card was found at boot. `sd none` means no card at boot (see 3.4).

4. **Take a photo.** It prints the path of the JPEG on the Mac, its size and how long it took (about 150 to 200 ms):

   ```bash
   fr camera snap cam-esp32
   ```

   Open it:

   ```bash
   open ~/.fractonica/captures/cam-esp32/
   ```

   With the flash LED lit for the shot:

   ```bash
   fr camera snap cam-esp32 --flash
   ```

5. **Watch it live in the browser.** Open <http://127.0.0.1:7420/apps/cam/>, pick **cam-esp32**, press **Start**. You should see the picture at about 9 to 12 frames per second, with "board drops 0" and "hub gaps 0". From the same page:
   - **Snapshot** saves one frame on the Mac; **Download frame** saves the frame shown.
   - **Flash on** lights the white LED.
   - **Settings** change frame size, quality, brightness, contrast, saturation, flip and mirror. A size or quality change restarts the live view on its own.
   - Press **Start** again (now **Stop**) when done.

6. **Stream a short clip to the Mac.** 15 s of frames, one JPEG each, into a new folder under `~/.fractonica/captures/cam-esp32/`:

   ```bash
   fr camera stream cam-esp32 --seconds 15
   ```

   The result shows frames, dropped, bytes and fps.

7. **Make a timelapse.** One frame a second for a minute:

   ```bash
   fr camera stream cam-esp32 --seconds 60 --interval-ms 1000
   ```

8. **Record on the card**, with no hub involved in the frames. Ten frames, one a second:

   ```bash
   fr camera stream cam-esp32 --seconds 20 --interval-ms 1000 --max-frames 10 --to sd
   ```

   The result names the recording id. List what is on the card:

   ```bash
   fr camera sd ls cam-esp32
   ```

   Copy a recording to the Mac (into `~/.fractonica/captures/cam-esp32/sd-<id>/`):

   ```bash
   fr camera sd fetch cam-esp32 <recording id>
   ```

   Delete it from the card (the Mac copy stays):

   ```bash
   fr camera sd rm cam-esp32 <recording id>
   ```

   `--to both` sends frames to the Mac and writes the card at the same time.

9. **Change settings** until the next reboot:

   ```bash
   fr camera set cam-esp32 --frame-size xga --quality 10
   fr camera set cam-esp32 --vflip --hmirror
   ```

   Sizes: `qvga` 320×240, `vga` 640×480, `svga` 800×600 (the default), `xga` 1024×768, `sxga` 1280×1024, `uxga` 1600×1200. Quality runs 4 (best, biggest) to 63. A reboot (`fr devices reset cam-esp32`) restores the profile's defaults.

10. **Run the automated test.** No person needed; about two minutes. It takes ten photos, streams 20 s, records, fetches and deletes on the card, checks a setting, and resets the board through its USB bridge:

    ```bash
    fr test run t-camera --tier target --args=--device --args=cam-esp32
    ```

    You should see `T-CAMERA PASS`. For one part only, add `--args=--phase --args=snap` (or `live`, `card`, `set`, `bridge`).

### 3.2 What to expect

| Measure | Typical on cam-esp32 |
|---|---|
| Photo, end to end | 150–200 ms |
| Live view at svga | 9–12 fps, about 300–350 KB/s |
| Frame size at svga | 27–42 KB (bigger in low light or with the flash) |
| Card fetch | about 6 frames/s |

The Wi-Fi link sets the frame rate: bigger frames mean fewer per second.

### 3.3 Update its firmware

Always update this board over Wi-Fi:

```bash
fr deploy cam-esp32 --via wifi
```

Without `--via wifi` the hub picks the USB route for a board on a USB bridge, and that fails while the SD card is in (see 3.4).

### 3.4 Camera troubleshooting

| You see | Do this |
|---|---|
| No `ch340` port in `fr ports ls` | Try another micro-USB cable: many carry power only. |
| `sd none` in the status | The card is checked at boot only. Insert it, then `fr devices reset cam-esp32`. |
| "Wrong boot mode detected (0xb)" when flashing over USB | The SD card holds a boot pin high once used. Unplug the board, take the card out, plug it back in, flash, then put the card back. Over Wi-Fi this never happens. |
| Low frame rate | Use a smaller frame size or more light; check the board's Wi-Fi signal in `fr devices get cam-esp32` (`rssi_ap`). |
| "BUSY" | One stream at a time: stop the live view in the app, or `fr jobs cancel <job id>`. |
| The free space looks too small | The figure is the card's own (FAT) count; check the card on the Mac. |

---

## 4. Weighing scale and round display

**The board:** scale-c6, an ESP32-C6 board (an ESP32-C6-WROOM-1-N8 module, 8 MB flash, no PSRAM) with two parts wired to it: an **HX711** load-cell amplifier with its load cell (DT on GPIO18, SCK on GPIO23) and a **1.28" round GC9A01 display**, 240×240 (CS 10, DC 2, SDA 7, SCL 6; RST not wired). The scale is the `scale` instance (`fr.scale`), the display the `round` instance (`fr.display`).

**On this bench the load cell is a tension sensor for sound, not a kitchen scale.** The board streams every change at 80 a second; read the values as relative force (raw counts scaled by a default factor). Calibrating in grams (step 4) is optional.

**What it does:** weight (or force) live in the browser and on the round display, tare and calibration that survive a reboot, a "settled" event when something is put on or taken off, recordings of every reading at up to 80 a second, and drawing or LVGL layouts on the round display.

### 4.1 Test the scale, step by step

1. **Connect the board** to the Mac with USB. Within about 10 s it joins Wi-Fi.

2. **Check the scale answers:**

   ```bash
   fr scale status scale-c6
   ```

   You should see something like `scale-c6 scale: 0.10 g, stable, calibrated, 95 Hz`. The rate is the HX711's own: about 80–100 when its RATE pin is set to "80 Hz", 10–12 when set to "10 Hz", **0 when the chip does not answer** (check its VCC, GND, DT and SCK wires).

3. **Zero it** with nothing on the scale:

   ```bash
   fr scale tare scale-c6
   ```

   The reading goes to about 0 g. The zero is kept across reboots.

4. **Calibrate it once (optional)** with something whose weight you know (at least 100 g; a sealed food package is good). Put it on, wait a second, then give its weight in grams:

   ```bash
   fr scale calibrate scale-c6 500
   ```

   The scale factor is kept across reboots. `fr scale reset scale-c6` forgets the zero and the calibration. "BUSY" means the reading was not stable yet: wait a moment and repeat.

5. **Watch it in the browser:** open <http://127.0.0.1:7420/apps/scale/>. You see the weight in grams with a stability dot, a 30 s plot, the HX711's rate and noise, and the Tare and Calibrate buttons. **Live at 80 Hz** shows every reading.

6. **Show the weight on the round display:** on the same page, tick **Show on the round display**. The display shows the weight as a large number with a gauge arc, updated up to 5 times a second while the page is open. **Gauge full scale** sets the weight at which the arc is full.

7. **Record every reading** for 10 s at 80 a second to a CSV file (`t_ms,weight_mg,stable`):

   ```bash
   fr scale watch scale-c6 --seconds 10
   ```

   The result gives the number of samples, the rate, and the mean, standard deviation, minimum and maximum.

8. **Run the automated test** (about 20 s, no person needed). It checks the rate, the noise on the empty scale, that a tare survives a reboot, and the round display's layout:

   ```bash
   fr test run t-scale --tier target --args=--device --args=scale-c6
   ```

   You should see `T-SCALE PASS`. With a known weight at hand, add `--args=--known-g --args=500` (you are asked to put it on and take it off).

### 4.2 The round display

Drawing works as on the other panels (section 9), with the instance `round`:

```bash
fr send scale-c6 round.clear
fr send scale-c6 round.text '{"x":60,"y":105,"text":"hello","size":3}'
```

Keep content inside the circle: the corners of the 240×240 frame are not on the glass. The display reports the trait `round: true`, so apps and agents know. Preview it on the Mac, corners greyed: `fr display render c6w-scale --commands '[{"cmd":"text","args":{"x":60,"y":105,"text":"123.4 g","size":3}}]'`. This board has no PSRAM, so `fr display snapshot` (reading the screen back) is not available on it.

### 4.3 What to expect

| Measure | Typical on scale-c6 |
|---|---|
| HX711 conversions | 95–96 a second (its "80 Hz" setting runs fast) |
| Readings delivered in a watch | about 79 a second |
| Noise on the empty scale | about 140–180 mg standard deviation |
| Reports | every change, 80 a second (this profile; the capability's default is 10 a second with a 100 mg deadband) |
| Free memory with Wi-Fi up | about 60 KB |

### 4.4 Scale troubleshooting

| You see | Do this |
|---|---|
| Rate 0 Hz | The HX711 does not answer: check its VCC and GND first (a broken VCC wire was the cause on the bench), then DT and SCK. |
| Rate about 10 Hz | The module's RATE pin is set to 10 Hz; for 80 Hz it must be tied to VCC (a solder change on most modules). |
| The weight drifts slowly | Load cells creep a little after a change and with temperature: tare again before an exact weighing. |
| Calibrate says nothing is on the scale | Put the known weight on first; after a wrong calibration, `fr scale reset scale-c6`, tare, and calibrate again. |
| The round display shows `--` | The page lost the board for a moment; it reloads the layout by itself. |

---

## 5. Audio: microphone and speaker

**The board:** mic-s3, an ESP32-S3 with an INMP441 microphone (`mic`) and a MAX98357A amplifier with a small speaker (`spk`).

1. **Check the microphone hears something.** A quiet room reads about −37 to −39 dBFS; −90 means no signal at all:

   ```bash
   fr audio level mic-s3
   ```

2. **Record 10 s to a WAV on the Mac:**

   ```bash
   fr audio record mic-s3 ~/.fractonica/audio/take.wav --seconds 10
   open ~/.fractonica/audio/take.wav
   ```

   The result shows peak and RMS level, clipping and dropped samples (samples lost to Wi-Fi are written as silence, so the length is always exact).

3. **Play it back on the board's speaker,** or any WAV:

   ```bash
   fr audio play mic-s3 ~/.fractonica/audio/take.wav
   ```

4. **Play a tone:**

   ```bash
   fr audio tone mic-s3 1000 --ms 500
   ```

5. **Listen live** through the board's own speaker (the microphone to the speaker on the board):

   ```bash
   fr audio monitor mic-s3 --from mic --to spk --seconds 30 --volume 40
   ```

6. **Automated test** (loopback tone, a minute of quiet, the level):

   ```bash
   fr test run t-audio --tier target --args=--device --args=mic-s3
   ```

Note: the INMP441 picks up the board's own Wi-Fi transmissions as soft thumps. Keep the microphone's wires short and away from the antenna.

---

## 6. Electrosmog listener

**The board:** mic-s3 again, with a radio detector on GPIO1 (`rf`: a diode, a capacitor, a resistor and a short wire antenna) read by the ADC as an audio source.

1. **Hear it live on the speaker:**

   ```bash
   fr audio monitor mic-s3 --from rf --to spk --seconds 60
   ```

2. **Record it:**

   ```bash
   fr audio record mic-s3 ~/.fractonica/audio/rf.wav --instance rf --seconds 30
   ```

A floating input hears 50 Hz mains loudly; the germanium diode is weak at 2.4 GHz (a Schottky diode such as 1N5711 or HSMS-2850 is the planned upgrade).

---

## 7. Wi-Fi sensing (CSI) and its sound modes

**The board:** csi-c5, an ESP32-C5 dev board that reads the Wi-Fi channel state information (CSI) of the router's traffic on 5 GHz. Movement in the room changes the signal.

1. **Check it:** motion, signal strength and the source it listens to:

   ```bash
   fr csi status csi-c5
   ```

2. **Watch it live** at <http://127.0.0.1:7420/apps/csi/>: pick **csi-c5**, press **Start**. The plots show the subcarriers and a **Motion** trace; walk around and it should rise clearly. **Reset baseline** makes "now" the still reference.

3. **Turn it into sound** on the same page, in the **Sound** card (start at a low volume):
   - **Drone:** one voice per band of subcarriers; movement brightens the chord. **Raw pitch** lets each voice bend with its band.
   - **Parrot:** listens for a while, then speaks what it heard as one compressed word; a still room stays silent.
   - **Laughter:** waits for movement, records it, then laughs at it; rate, pitch and vowel follow how you moved.
   - **Babble:** the same, in an invented robot language of syllables and pauses.

4. **Save records to a file** for later analysis:

   ```bash
   fr csi stream csi-c5 --seconds 30 --out ~/.fractonica/csi/walk.csi
   ```

csi-c5 joins the hub's `5ghz` network. Its source can also be a second board transmitting (`--source peer --peer <device>`).

---

## 8. Buttons, LEDs, bindings and messages

**The boards:** the pads (pad-c3, pad-c3b, pad-c6, pad-s3, pad-s3t): each has a BOOT button (`boot`) and a status LED (`status`), most have a display.

1. **Blink an LED:**

   ```bash
   fr send pad-c3 status.blink '{"count":3}'
   ```

   Other LED commands: `status.set`, `status.toggle`, `status.stop`.

2. **Press a button without touching it** (debug builds):

   ```bash
   fr input pad-c6 boot click
   ```

   Gestures: `press`, `release`, `click`, `double_click`, `long_press`. Then see the events:

   ```bash
   fr events pad-c6 --types 'boot.*'
   ```

3. **Bind one board's button to another board's LED.** The binding lives on the boards and works over ESP-NOW even without the hub:

   ```bash
   fr bind pad-c6.boot.down pad-c3.status.blink '{"count":1}'
   ```

   Press BOOT on pad-c6 and pad-c3 blinks. List and remove bindings:

   ```bash
   fr bind ls
   fr bind rm pad-c6 all
   ```

4. **Broadcast a message** to every node:

   ```bash
   fr msg broadcast ping
   ```

5. **See latency** per board and link (PING round trip, input to hub):

   ```bash
   fr latency
   ```

6. **Make a board identify itself** (its first LED blinks so you can find it): `fr send pad-c3 node.identify '{"ms":3000}'`.

---

## 9. Displays and touch

**The boards:** pad-c3 and pad-c3b (a 0.42" OLED, `oled`), pad-s3 (a 1.9" LCD, `lcd`), pad-s3t (a 2" touch LCD, `lcd` and `touch`), scale-c6 (a 1.28" round LCD, `round`: see [4.2](#42-the-round-display)).

1. **Write on a display:**

   ```bash
   fr send pad-s3 lcd.clear
   fr send pad-s3 lcd.text '{"x":10,"y":20,"text":"hello","size":2}'
   ```

   Other commands: `fill_rect`, `set_brightness`, and `ui_load` / `ui_set` for LVGL layouts.

2. **See what a panel shows**, as a PNG on the Mac:

   ```bash
   fr display snapshot pad-s3 lcd --out ~/.fractonica/display/
   ```

3. **Preview a profile's panel on the Mac with no board:** a window that behaves like the device (the mouse is the finger on touch panels):

   ```bash
   fr display window --profile s3t-pad
   ```

   Or render it once to a PNG: `fr display render s3t-pad`.

4. **Touch:** a tap on pad-s3t arrives as `touch.*` events (`fr events pad-s3t --types 'touch.*'`); simulate a tap with `fr input pad-s3t touch --x 100 --y 80` (or the gesture `long_press`, `swipe_up`, … before the flags).

---

## 10. Analog input

**The profile:** c3o-analog (a pad-c3 board with `analog` on an ADC pin). It streams the value at 20 Hz by default.

1. Put the profile on a C3 pad over USB: `fr build --profile c3o-analog`, then `fr flash pad-c3b --profile c3o-analog --plan full` (see [13](#13-firmware-updates)).
2. Read it: `fr send pad-c3b analog.read`.
3. Watch it stream: `fr events pad-c3b --types 'analog.*'`.
4. On a debug build, fake a value: `fr input pad-c3b analog --mv 1650`.

---

## 11. The gateway

**The board:** gw-c6, a nanoESP32-C6 on the Mac's USB. It bridges ESP-NOW nodes that have no Wi-Fi link to the hub over USB. It needs no setup: plug it in and the hub uses it for nodes it cannot reach over Wi-Fi. `fr devices get <node>` shows `gw` among its links when traffic goes through it.

---

## 12. Adding a new board

1. **Plug it in** and find its port:

   ```bash
   fr ports ls
   ```

2. **Pick or write a profile.** `fr profiles ls` lists them with their board and capabilities; `fr boards ls` lists the board descriptions. A new board needs a board file in `hardware/boards/` and a profile in `firmware/profiles/`.

3. **Build it** (about a minute the first time):

   ```bash
   fr build --profile e32a-cam
   ```

4. **Provision it:** first flash, identity, Wi-Fi and registration in one step (about 1 to 2 minutes):

   ```bash
   fr devices provision --port /dev/cu.usbserial-110 --profile e32a-cam --alias cam-esp32
   ```

5. **Check it came online:** `fr devices get cam-esp32`.

For an ESP32-CAM, take the SD card out before provisioning (see 3.4).

---

## 13. Firmware updates

| What | Command |
|---|---|
| Build, update over the best link, wait for it to come back | `fr deploy cam-esp32` |
| The same over Wi-Fi only | `fr deploy cam-esp32 --via wifi` |
| Several boards at once | `fr deploy pad-c3,pad-c6` |
| Update to a specific build | `fr ota cam-esp32 --build <build id>` |
| Switch a board to another profile (over USB) | `fr build --profile c3o-analog`, then `fr flash pad-c3b --profile c3o-analog --plan full` |
| Flash over USB (a board that lost its firmware) | `fr flash cam-esp32 --plan full` |
| List built firmware | `fr artifacts ls` |

An update that fails its health check after reboot rolls back to the previous firmware on its own.

---

## 14. Testing

| Tier | What it covers | Command |
|---|---|---|
| host | TypeScript unit tests (vitest) and the firmware's C++ host tests | `fr test run --tier host` |
| target | Gates on real boards | `fr test run <gate> --tier target` |
| hil | Gates that use the HIL fixture's wired lines | `fr test run --tier hil` |
| sim | The virtual fleet | `fr test run --tier sim` |

The target gates, with whether they need a person or USB:

| Gate | Checks | Needs |
|---|---|---|
| t-camera | Photos, live stream, card, settings, USB bridge | nothing |
| t-scale | Scale rate, noise, tare across a reboot, the round display's layout | nothing (a person with `--known-g`) |
| t-audio | Speaker-to-microphone loopback, quiet, level | nothing (a person with `--voice`) |
| t-led | LED commands | nothing |
| t-codec | The wire codec against golden vectors | nothing |
| t-flood | Broadcast delivery across the network | nothing |
| t-display | What panels draw | a person |
| t-input | Button gestures | a person, USB |
| t-lat | Button-to-hub latency | wiring, USB |
| t-ota, t-prov, t-ports, t-pres | Updates, provisioning, ports, presence | a person, USB |
| t-nn, t-gw-link, t-vbat, t-agent | Node-to-node, gateway, battery, the agent flow | a person |

Pass extra flags to a gate with `--args=<flag>` once per word; add `--allow-human` when you are at the bench. `fr test report <job id>` shows a finished run's figures.

---

## 15. Apps and the SDK

Web apps live in `web/<name>/` and the hub serves each at `http://127.0.0.1:7420/apps/<name>/`, with an access token injected:

| App | What it does |
|---|---|
| [/apps/cam/](http://127.0.0.1:7420/apps/cam/) | The camera: live view, snapshots, flash, settings, card recordings |
| [/apps/csi/](http://127.0.0.1:7420/apps/csi/) | Wi-Fi sensing: subcarriers, motion, the four sound modes |
| [/apps/scale/](http://127.0.0.1:7420/apps/scale/) | The scale: live weight, plot, tare, calibration, the weight on the round display |
| [/apps/demo/](http://127.0.0.1:7420/apps/demo/) | The M1 demo: two pads' button events, an app-level relay with its latency, a broadcast ping |

To write your own, generate a typed device registry for `@fractonica/sdk` into your app:

```bash
fr codegen client --out web/myapp/src/fractonica
```

The SDK gives you the devices by alias, their commands and events, and live streams (camera frames, CSI blocks, audio).

---

## 16. AI agents

Every `fr` command is also an MCP tool, served by `fr mcp`.

- **Claude Code:** run `claude --plugin-dir ~/projects/fractonica-hardware/plugin`, or install it once with `/plugin marketplace add ~/projects/fractonica-hardware` then `/plugin install fractonica@fractonica`. Its skills teach the agent each area: fleet-ops, build-deploy, e2e-verify, hil-rig, audio, camera and scale.
- **Other agents:** [`plugin/AGENTS.md`](../plugin/AGENTS.md) has the same guidance with CLI equivalents.
- Ask in plain words, for example "take a photo with cam-esp32 and show it to me" or "record ten seconds from mic-s3".

---

## 17. Troubleshooting

| You see | Do this |
|---|---|
| `fr` says no hub is running | `fr hub start` from Terminal. |
| A board is `offline` | Check its power and `fr logs <board>`; reset it with `fr devices reset <board>` if it is on USB. |
| `HUB_VERSION_MISMATCH` after pulling code | `fr hub restart --force` (the CLI and the running hub disagree, so a plain restart is refused). |
| `fr hub restart` refuses: a job is working | Wait, or cancel it (`fr jobs ls`, `fr jobs cancel <id>`). An open CSI or camera app page keeps its stream job alive: close the page, or use `fr hub restart --force`. |
| A flash fails to connect | Reset into download mode: `fr devices reset <port> --mode bootloader`, or hold BOOT and tap RST, then flash again. |
| A board joined the wrong Wi-Fi | `fr net ls`, then `fr flash <board> --plan identity --network <name>`. |
| The dashboard looks out of date | `fr doctor --fix` rebuilds it. |

---

## 18. The bench

| Alias | Board | Profile | What it is for |
|---|---|---|---|
| cam-esp32 | AI-Thinker ESP32-CAM (ESP32, OV2640, micro-SD) | e32a-cam | Camera |
| scale-c6 | ESP32-C6-WROOM-1-N8 board with an HX711 and a round GC9A01 | c6w-scale | Weighing scale, round display |
| mic-s3 | ESP32-S3 WROOM-1 N16R8 | s3a-audio | Microphone, speaker, electrosmog detector |
| csi-c5 | DOIT ESPC5-32 (ESP32-C5) | c5d-csi | Wi-Fi sensing on 5 GHz |
| pad-c3, pad-c3b | ESP32-C3 with a 0.42" OLED | c3o-pad | Button, LED, display |
| pad-c6 | ESP32-C6 SuperMini | c6-pad | Button, LED |
| pad-s3 | Waveshare ESP32-S3 1.9" LCD | s3l-pad | Button, LED, display |
| pad-s3t | Waveshare ESP32-S3 2" touch LCD | s3t-pad | Button, display, touch |
| gw-c6 | nanoESP32-C6 | c6g-gateway | ESP-NOW gateway on USB |
| (fixture) | ESP32-S3 DevKitC-1 | s3k-fixture | HIL fixture: presses buttons and sets voltages on wired lines |

Boards that are not plugged in show as `unknown` or `offline` in `fr devices ls`; that is normal.
