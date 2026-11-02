# A1: audio in and out (`fr.audio_in`, `fr.audio_out`), streaming to the hub

> **As built (2026-11-02): implemented, reviewed, fixed, and T-AUDIO's automatic phases passed on `mic-s3`.** Bench round and figures: [spike note](../spikes/2026-11-02-a1-audio.md). Not an M2 checkpoint: the first framework work driven by a project built on Fractonica (your pivot of 2026-11-02; M2-C6 is paused). Run "lighter": this note, streams C, then F and H, then K; one review pass by two reviewers; fix agents. Your decisions are in §9. Numbers marked **proposed** wait for your approval. Anything marked *inferred* was not read in code, a datasheet or on the bench.
>
> **What the bench and the review changed against the plan:**
> - **The mic's start-up** (D5): a 100 ms warm-up discarded after every start, the DC blocker primed, then a 200 Hz settling corner gliding to `hpf_hz` over 500 ms; `level_get` measures after it (about 800 ms) and answers at once with the previous reading.
> - **`stream_start` and `play` answer at once** (§11): the framework has no deferred command results; a failed connection ends the stream with `stream_ended`/`play_done` `net_lost`.
> - **`stats audio`** in diag: `rx_overflows`, `dropped_samples`, `clipping`, `underruns`, `ring_dry`.
> - **The INMP441 picks up the board's own Wi-Fi transmissions** through its wires (spike note, finding 2): short wires cut it by about 19 dB; TX power stays at the default for now.
> - **The hub** reads `POST /v1/audio/in/` on a raw socket (node:http hides chunk boundaries), identifies a play GET by the TCP session's address, and survives disk errors and stalled downloads.
> - **The amp moved to GPIO14/13/12:** the board's underside micro-SD slot shares GPIO38-40 (its lines corrupted the I2S data on many-bit flips); the manifest now reserves them as `sd_card`.
> - **IDF v6.1** dropped `i2s_port_t`; the host shim now matches it.

**The hardware** (your photo, 2026-11-02):
- **Microphone:** a round INMP441-style I2S MEMS board (pads L/R, WS, SCK, SD, VDD, GND). 24-bit samples in a 32-bit I2S slot, left or right by L/R (L/R to GND = left), 3.3 V. *Inferred* from the silkscreen; the part is not marked on the photo.
- **Amplifier:** a MAX98357A I2S class-D board (pads LRC, BCLK, DIN, GAIN, SD, GND, Vin) with a speaker on + and −. GAIN floating = 9 dB; SD floating = on, playing (L+R)/2 *(inferred from the common breakout's 1 MΩ pull-up)*. Vin 2.5–5.5 V; 5 V is louder.
- **The board:** a spare ESP32-S3 (your choice): two I2S controllers, PSRAM for buffers. It joins as a new device; the bench DUTs and the fixture do not change.

**What exists:** `fr.audio_out` has id `0x0004` reserved (07 §7.1; planned for M3); `0x0007` is free; nothing else of audio exists. The node already has a socket HTTP client for OTA (`fr_ota/http_get.hpp`) and the hub an HTTP listener on 7422 (`hub/src/ota/http.ts`).

## 1. Scope

In:
1. **`fr.audio_in` 1.0** (`0x0007`) and **`fr.audio_out` 1.0** (`0x0004`): reusable capabilities, any board, any I2S part through drivers.
2. **Drivers** `i2s_mic` (I2S standard-mode MEMS microphones: INMP441, ICS-43434, SPH0645 with a flag) and `i2s_amp` (I2S DAC/amplifiers: MAX98357A, with an optional shutdown pin).
3. **A stream transport** that never blocks the hub link: node → hub audio over its own HTTP connection.
4. **The first use:** record from the board to a WAV file on the Mac (`fr audio record`, op `audio_record`); play a tone or a WAV on the board (`fr audio tone`, `fr audio play`).
5. **A host source**, so agents test the whole path on the Mac with no board (as `display_render` does for screens).
6. **T-AUDIO**, including a mic ↔ speaker loopback on the board that needs no person.

Out (later, each its own step): live listening in the dashboard, PCM to apps through the SDK (both reuse §3's stream), compression (Opus), stereo, audio over a gateway or ESP-NOW (too big for the air: 32 KB/s against T-FLOOD's frames), node → node audio.

## 2. Capabilities (D1–D2)

**D1. `fr.audio_in` 1.0** (`0x0007`):
- **config:** `sample_hz` (enum 8000, 16000, 22050, 32000, 44100, 48000; default 16000), `gain_db` (0–36, default 12: the INMP441 is quiet at 16 bits, *inferred*), `hpf_hz` (DC blocker, default 20; 0 = off), `level_hz` (0–20, default 5).
- **properties:** `level` (LATEST, i16 dBFS × 10, RMS over the last 1/`level_hz` s while the mic runs), `streaming` (bool).
- **events:** `stream_ended` (reliable) `{stream_id, reason (stopped, done, net_lost, overflow, error), samples u32, dropped_samples u32}`.
- **commands:**
  - `stream_start {stream_id u32, seconds u16 (0 = until stop), sample_hz?}`, reliable: the node opens §3's connection and answers once its first chunk is sent (or `FAILED`/`BUSY`, one stream at a time).
  - `stream_stop {stream_id}`, reliable.
  - `level_get` → `{dbfs_x10, peak_dbfs_x10, clipping u32}`; it starts the mic for 200 ms if idle.
- **traits** (driver): `max_sample_hz`, `bits` (24 for the INMP441).

**D2. `fr.audio_out` 1.0** (`0x0004`):
- **config:** `volume` (0–100, default 60), `sample_hz` (as D1, default 16000).
- **properties:** `playing` (bool).
- **events:** `play_done` (reliable) `{play_id, reason (done, stopped, net_lost, underrun, error), underruns u32}`.
- **commands:** `tone {freq_hz u16, ms u16, volume?}` (the board makes it, no network), `play {play_id u32, sample_hz}` (the node pulls PCM from the hub, §3), `stop`, `set_volume {volume}`.

The hub turns any WAV it is given into the board's format (mono, 16-bit, `sample_hz`, linear resampling in TS); the board only ever sees raw PCM at its own rate.

## 3. The stream transport (D3–D5)

**D3. Audio goes over its own HTTP connection, never the hub link.** 32 KB/s on the hub's TCP session (BULK frames) would queue every command and STATE behind audio. The node opens a second TCP connection to the hub's HTTP listener (7422), as OTA does: node-initiated, so macOS's Local Network rules are met ([05 §5.2](../spec/05-network.md)).
- **Up (record):** `POST /v1/audio/in/<stream_id>` with `Transfer-Encoding: chunked`, `X-Fr-Device`, `X-Fr-Format: s16le;rate=16000;ch=1`. Each chunk is one block: an 8-byte head (`seq` u32, `first_sample` u32) and 100 ms of PCM (3,200 B at 16 kHz). The hub answers 200 at the end.
- **Down (play):** `GET /v1/audio/out/<play_id>` through the existing `HttpGet` (Content-Length, raw PCM at the board's rate).
- **Only streams the hub opened:** an id is accepted once, from the device it was issued to, within 10 s of the command; anything else gets 404 (as OTA serves only an offered `fw_id`, 08 §8.10).

**D4. Losses keep time.** A 2 s ring in PSRAM sits between the I2S reader and the socket. If Wi-Fi stalls past it, the oldest blocks are dropped and counted; `first_sample` jumps, and the hub writes silence for the gap, so a 10 s recording is always 10 s long and `dropped_samples` says how much is silence. A send stalled for 3 s (or the connection lost) ends the stream with `net_lost`.

**D5. Tasks:** `fr_audio` (priority 5, core 0 with Wi-Fi on the S3, 4 KB) reads I2S DMA (6 × 240 frames), converts 32 → 16 bits with gain, DC blocker and clipping count, feeds the level meter and the ring; `fr_stream` (priority 3, 4 KB) runs the socket with blocking sends. Neither touches the core task, which keeps owning dispatch (03 §3.4). Playback: `fr_stream` fills a 1 s ring from the GET; `fr_audio` writes it to the I2S TX DMA and plays silence on an underrun (counted).

## 4. Drivers and the board (D6–D7)

**D6. Drivers** (`hardware/drivers/`, `fr::drv`, over IDF `esp_driver_i2s` standard mode):
- **`i2s_mic`:** binds `audio.<name>` from the board or bare pins `{bclk, ws, din}`; config `slot: left|right`, `format: philips|msb` (SPH0645 = msb, *inferred*), `port` (auto: the first free I2S controller). Implements `hal::AudioSource` (`start(rate)`, `read(span<int32_t>)`, `stop()`).
- **`i2s_amp`:** pins `{bclk, ws, dout}` plus optional `sd` (shutdown: low between plays saves about 2–3 mA and stops hiss, *inferred*); implements `hal::AudioSink`.
- **Separate controllers** when the target has two (S3): mic on I2S0, amp on I2S1, so their rates are independent. **A shared-clock duplex mode** (one controller, BCLK/WS shared, mic and amp at one rate) for the C3/C6, which have one: a driver option `share_with: <instance>`, built now but only host-tested until a C3/C6 audio board exists.

**D7. The board and profile** (your photo, 2026-11-02): an ESP32-S3-WROOM-1-N16R8 on a DevKitC-1-style clone with a camera FPC connector, two USB-C ports (native USB and a COM bridge), the RGB LED on **GPIO48** (silkscreen "48"), headers as DevKitC-1's J1/J3. A new manifest **`esp32s3-wroom1-cam-n16r8`** (copied from `esp32s3-devkitc1-n16r8`; GPIO38 free, since the LED is on 48 here; the camera FPC's pins are left free, *inferred*: no camera fitted). Your display is already wired to GPIO45, 48, 47, 21 and the upper J1 pins; none of the audio pins touch it.
- Profile **`s3a-audio`**: app `node`, PSRAM on, caps `boot` (`buttons.boot`), `status` (`led_ws2812` on `leds.rgb`, max brightness 32), `mic` (`fr.audio_in` on `i2s_mic`), `spk` (`fr.audio_out` on `i2s_amp`). The pins are bound in the profile (`bind: { bclk: gpio.41, ws: gpio.42, din: gpio.2 }`), since the modules are wired to the board, not part of it; codegen checks each against the board's `free` pins.

| Module pin | Board pin |
|---|---|
| Mic SCK / WS / SD | GPIO41 / GPIO42 / GPIO2 |
| Mic L/R | GND (left slot) |
| Mic VDD / GND | 3V3 / GND |
| Amp BCLK / LRC / DIN | GPIO14 / GPIO13 / GPIO12 (first 39/40/38: the micro-SD slot's pins, which made playback crackle; spike note finding 4) |
| Amp Vin / GND | 5V / GND |
| Amp GAIN, SD | not connected |

- Device alias **`mic-s3`**, provisioned once over USB (`--profile s3a-audio`, as the fixture and pad-s3 share its USB and esptool identity).

## 5. The hub, CLI and host source (D8–D10)

**D8. Ops** (one REGISTRY_HASH bump):
- `audio_record {device, instance?, seconds (1–600), out, sample_hz?}` (tier write; job): sends `stream_start`, receives the POST, writes a WAV (`out` under FR_HOME, as the display ops), returns `{path, seconds, samples, dropped_samples, peak_dbfs, rms_dbfs, clipping}`.
- `audio_play {device, instance?, file | tone {freq_hz, ms}, volume?}` (tier write; job): resamples the file, issues `play`, serves the GET, waits for `play_done`.
- `audio_level {device, instance?}` (tier read).
- Hub events `audio.stream_started`, `audio.stream_ended` with the figures.

**D9. CLI:** `fr audio record <dev> [--seconds 10] <out.wav>`, `fr audio play <dev> <file.wav>`, `fr audio tone <dev> <hz> [--ms 500]`, `fr audio level <dev>`. MCP gets the ops as every op does.

**D10. A host source:** `fr_net_node` (the host node) gains `--audio-in sine:<hz>` / `wav:<file>` and `--audio-out <file>` (an `AudioSource`/`AudioSink` on the host), so `audio_record` and `audio_play` run end to end on the Mac in the interop suite and for agents, the stream code being the board's (as `HttpGet` already is).

## 6. Gates (D11; numbers proposed)

**T-AUDIO** (`tests/e2e/t-audio.ts`):
1. **Host** (`pnpm test`): a 1 kHz sine from the host node, 10 s at 16 kHz: the WAV's length within 1 sample of 160,000, its peak frequency 1,000 ± 5 Hz, 0 dropped; a forced 1 s socket stall: the length unchanged, `dropped_samples` = the stall's samples, silence where they were; a stream id not issued → 404.
2. **Board, loopback, no person:** speaker and mic about 5–10 cm apart. The board plays `tone 1000 --ms 3000` while recording 5 s: the recording's 1 kHz band ≥ 20 dB above the same band in a quiet 5 s recording; the quiet recording's RMS published (the noise floor).
3. **Board, quiet stream:** 60 s recording: 0 dropped samples, length exact, `level` STATEs at 5 Hz ± 10 %.
4. **Board, under load:** a 60 s recording while T-FLOOD runs on the network: dropped ≤ 0.5 % (proposed); the hub loop p99 published.
5. **Your ears, once:** `fr audio record` 10 s of you speaking, then `fr audio play` it back on the speaker: intelligible, no clicks (yes/no).
- **Regressions:** T-HIL, T-INPUT sim on the DUTs (they do not get the new image, but share the hub), T-CODEC with the new capabilities.

## 7. Bench steps for you

1. **Tell me the spare S3's model** (a photo of it is enough), so I can pick its six pins.
2. **Wire** (with the board unplugged), after I send the table: mic VDD → 3V3, GND → GND, L/R → GND, SCK/WS/SD → three GPIOs; amp Vin → 5V, GND → GND, BCLK/LRC/DIN → three other GPIOs; GAIN and SD left unconnected.
3. **Provision it once over USB:** it needs a Mac data port, and both are taken (the fixture and gw-c6). gw-c6 is idle while M2-C6 is paused, so it gives up its port for this.
4. **Place** the speaker 5–10 cm from the mic for the loopback; one spoken recording for step 5 of the gate.

## 8. Risks

- **Microphone level and noise:** the INMP441's −26 dBFS sensitivity makes speech quiet at 16 bits without gain; `gain_db` defaults to 12 and is tuned from the bench's noise floor.
- **Wi-Fi stalls** on the board: the 2 s ring and D4's silence keep timing honest; T-AUDIO 4 measures it.
- **I2S pin choice on the S3:** the strapping pins (0, 3, 45, 46), USB (19/20), and the octal PSRAM's pins (33–37 on R8 parts) are avoided.

## 9. Decisions taken with you (2026-11-02)

1. **The board:** a spare S3 (not pad-s3 or a C6).
2. **The first destination:** WAV files on the Mac (live listening and the SDK come later on the same stream).
3. **Quality:** 16 kHz, 16-bit mono by default, configurable up to 48 kHz.

**Proposed by the lead, taken as defaults on 2026-11-02** (you said to go ahead; any of them can still change):
4. **Audio over its own HTTP connection** to the hub (D3), never the hub link or ESP-NOW.
5. **Separate I2S controllers** on the S3, and a shared-clock mode for one-I2S chips (D6).
6. **The loopback test** (speaker → mic) as the automatic board gate, and T-AUDIO's numbers.

## 10. Streams

- **C — contract:** the two capability YAMLs, the `hal::AudioSource`/`AudioSink` interfaces, driver manifests, the board's `audio:` section in the board schema and codegen, op schemas, regenerated outputs.
- **F — firmware:** the two services, `fr_audio`/`fr_stream`, the chunked POST (beside `HttpGet`, host-built), the drivers, the profile; host tests.
- **H — hub:** the HTTP routes, WAV writing and reading, the resampler, the ops, the CLI, events; unit and interop tests with the host source (D10).
- **K — gate:** `t-audio.ts`, the plugin skill `audio` (how to record, play and check a level from an agent).

## 11. Contract as built (stream C, 2026-11-02)

What streams F and H build on. Names here are final; a change goes through the lead.

**Capabilities** (`schema/capabilities/audio_in.cap.yaml`, `audio_out.cap.yaml`; generated `fr::cap::AudioIn`, `fr::cap::AudioOut` in `fr_caps/gen/audio_{in,out}.hpp`, TS in `packages/protocol/src/gen/caps/`):
- `fr.audio_in` 1.0 (`0x0007`): config `sample_hz` u32 16000, `gain_db` u8 12, `hpf_hz` u16 20, `level_hz` u8 5; traits `max_sample_hz` u32, `bits` u8; properties `level` i16 (dBFS × 10), `streaming` bool; event `stream_ended {stream_id, reason: AudioInStreamEndReason (stopped, done, net_lost, overflow, error), samples, dropped_samples}`; commands `stream_start=1 {stream_id u32, seconds u16, sample_hz? u32}` → `{sample_hz}`, `stream_stop=2 {stream_id}`, `level_get=3` → `{dbfs_x10 i16, peak_dbfs_x10 i16, clipping u32}`.
- `fr.audio_out` 1.0 (`0x0004`): config `volume` u8 60, `sample_hz` u32 16000; traits `max_sample_hz`, `bits`; properties `playing` bool, `volume` u8 (added, as fr.display's brightness reflects set_brightness); event `play_done {play_id (0 for a tone), reason: AudioOutPlayEndReason (done, stopped, net_lost, underrun, error), underruns, samples}`; commands `tone=1 {freq_hz u16 20..20000, ms u16 default 500, volume? u8}`, `play=2 {play_id u32, sample_hz u32}`, `stop=3`, `set_volume=4 {volume}`.
- **Deviation from D1:** the framework has no deferred RESULT (a command answers inside dispatch), so `stream_start` and `play` answer as soon as the `fr_stream` task has the job (BUSY: another stream runs; INVALID_ARGS: a rate not in `kAudioRates` or above `max_sample_hz`). A connection that cannot be opened ends it with `stream_ended` / `play_done` reason `net_lost`, samples 0.

**HAL** (`fr_core/include/fr/hal/audio.hpp`): `fr::hal::kAudioRates`, `is_audio_rate()`; `class AudioSource { init(Core&); start(uint32_t sample_hz); std::expected<size_t, Err> read(std::span<int32_t> frames, uint32_t timeout_ms); stop(); sample_hz(); max_sample_hz(); bits(); overruns(); selftest(); }` (32-bit slots, left-justified); `class AudioSink { init(Core&); start(uint32_t); std::expected<size_t, Err> write(std::span<const int16_t>, uint32_t timeout_ms); stop(uint32_t timeout_ms); sample_hz(); max_sample_hz(); bits(); underruns(); selftest(); }`. init at board init; everything else from `fr_audio` only.

**Drivers** (stubs answering `Err::unsupported`; F fills `src/*.cpp`): `fr::drv::I2sMic` (`hardware/drivers/i2s_mic/include/fr/drv/i2s_mic.hpp`; Config `int8_t bclk, ws; uint8_t din; Slot slot {left, right}; Format format {philips, msb}; uint8_t port; uint8_t share_with`) and `fr::drv::I2sAmp` (`.../i2s_amp.hpp`; Config `int8_t bclk, ws; uint8_t dout; int8_t sd (-1: not wired); uint8_t port; uint8_t share_with`). Both: targets C3, C6, S3; `resources: { gpio, i2s: 1 }`; traits max_sample_hz 48000, bits 24 (mic) / 16 (amp).

**Codegen** (`packages/codegen/src/board.ts`):
- **Multi-pin bare bind:** `bind: { bclk: gpio.41, ws: gpio.42, din: gpio.2 }`; each key is a driver field `from: bind.<key>` (type gpio, binds gpio; `optional: true` may be left out: -1). Every pin follows the bare-pin rules (pins.free, never strapping, never claimed twice).
- **Driver field types:** `i2s_port` (`auto` or a number in the profile; resolved to the lowest free controller in port order, so the Config holds a concrete uint8_t; checked against the board's `resources.i2s`, now 2 on every S3 board and 1 on the C3/C6 ones) and `instance` (another instance by name; the Config holds its capability port, 0 for none).
- **share_with:** set on one instance of the pair (the follower). Both get the same controller and each other's port in `share_with`; the follower binds no bclk/ws and gets its partner's (unclaimed); both need one `sample_hz`; the pair counts one controller. How the two drivers hand over the duplex channel pair is F's (host-tested only).
- `SERVICES`: `fr.audio_in` → `fr::AudioInService` (`fr/services/audio_in_service.hpp`, implements `hal.AudioSource`, 1 timer), `fr.audio_out` → `fr::AudioOutService` (`fr/services/audio_out_service.hpp`, `hal.AudioSink`, 1 timer). A profile's `sample_hz` must be one of `AUDIO_RATES`.
- Board `esp32s3-wroom1-cam-n16r8`; profile `s3a-audio` (ports boot 1, status 2, mic 3, spk 4; mic I2S0, spk I2S1).

**Services F writes** (in fr_core, host-buildable like AnalogInService; the generated fr_board constructs `service{driver, kConfig}`, calls `init(core)` and `selftest()`):
```cpp
class AudioInService final : public cap::AudioIn {
public:
    AudioInService(hal::AudioSource &src, const cap::AudioInConfig &cfg);
    Status init(Core &core);
    hal::Selftest selftest();
    std::expected<cap::AudioInStreamStartResult, Err> stream_start(const cap::AudioInStreamStartArgs &args) override;
    Status stream_stop(const cap::AudioInStreamStopArgs &args) override;
    std::expected<cap::AudioInLevelGetResult, Err> level_get() override;
    int16_t level() const override;
    bool streaming() const override;
    cap::AudioInTraits traits() const override;
};
class AudioOutService final : public cap::AudioOut {
public:
    AudioOutService(hal::AudioSink &sink, const cap::AudioOutConfig &cfg);
    Status init(Core &core);
    hal::Selftest selftest();
    Status tone(const cap::AudioOutToneArgs &args) override;
    Status play(const cap::AudioOutPlayArgs &args) override;
    Status stop() override;
    Status set_volume(const cap::AudioOutSetVolumeArgs &args) override;
    bool playing() const override;
    uint8_t volume() const override;
    cap::AudioOutTraits traits() const override;
};
```

**Diag** (stream F, fix round 2026-11-02): `stats audio` per instance, since boot: an input's `rx_overflows` (I2S RX DMA buffers lost, put back as zeros), `dropped_samples` (record ring drops), `clipping` (after the warm-up); an output's `underruns` (the amplifier's starved DMA buffers while a sound ran) and `ring_dry` (play ring dry spells). In a full `stats` only when the node has audio instances ([09 §9.7](../spec/09-agent-api.md)). The microphone's start-up: after every start the first 100 ms are dropped (`kWarmupMs`), the DC blocker is primed from the first kept sample and glides from 200 Hz (`kSettleHz`) to `hpf_hz` over 500 ms (`kSettleMs`); the stream's sample 0 is the first kept one; the meter starts after the glide, so an idle `level_get` measures about 800 ms after it starts the microphone.

**Hub ops** (`packages/protocol/src/ops/audio.ts`, exported from `@fractonica/protocol`): `audio_record {device, instance?, seconds 1..600, out, sample_hz?, wait_s?}` (job, mutate) → `AudioRecordSchema {device, alias, instance, path, stream_id, sample_hz, seconds, samples, dropped_samples, peak_dbfs, rms_dbfs, clipping, reason}`; `audio_play {device, instance?, file? | tone? {freq_hz, ms=500}, volume?, wait_s?}` (job, mutate; the schema refuses both or neither) → `AudioPlaySchema {device, alias, instance, source, path?, play_id, sample_hz, seconds, samples, underruns, reason}`; `audio_level {device, instance?, timeout_s=5}` (query, read) → `AudioLevelSchema {device, alias, instance, dbfs, peak_dbfs, clipping}`. CLI paths `audio record <device> <out>`, `audio play <device> <file>`, `audio level <device>`; `fr audio tone <dev> <hz> [--ms]` (D9) is a hand-written CLI wrapper onto audio_play's `tone` (H). Job kind `audio` (JOB_KINDS). REGISTRY_HASH `afc13588b596` → `445e6697686c`. The hub answers all three CAPABILITY_UNSUPPORTED (`packages/hub/src/audio/ops.ts`, `AUDIO_HANDLERS`) until H replaces it.

**Hub events** (`packages/protocol/src/events.ts`): `audio.stream_started` (`AudioStreamStartedFields {instance, direction in|out, stream_id, sample_hz, seconds, path?, job_id?}`) and `audio.stream_ended` (`AudioStreamEndedFields {instance, direction, stream_id, reason, sample_hz, samples, dropped_samples?, underruns?, peak_dbfs?, rms_dbfs?, path?, job_id?}`); a tone publishes neither.

**Open:** an instance named `audio` with fr.audio_in would publish `audio.stream_ended` as a capability event, the same type as the hub's; `audio` is not a reserved instance name (that would be a spec 03 §3.6 change), so profiles should not use it.
