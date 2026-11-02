# A2: the electrosmog listener (an RF detector as an audio input, and on-board monitoring)

> **As built (2026-11-02): implemented and run on `mic-s3`; not yet reviewed; T-RF's script not written.** The second project step on Fractonica, after [A1](audio-a1.md). Run "lighter": this note, streams C, then F and H. Your decisions are in §8; the contract and firmware as built in §10; the bench round in §11.
>
> **What the bench showed** (§11): the software works end to end (`adc_audio` on ADC1 DMA, the on-board monitor `rf` → `spk` with 0 underruns and 0 overflows over 20 s and 45 s, `fr audio monitor`, `fr audio record --instance rf`). The germanium point-contact detector is too weak at 2.4 GHz: the board's own blast 5 cm away gave about 0.2 mV, a third of the ADC's noise (visible only by folding 250 bursts). A floating ADC pin hears the house's 50 Hz mains hum loudly instead. Next, with parts on order: a 1N5711 or HSMS-2850 Schottky and an MCP6002 gain stage.

**The idea.** A short wire antenna and a diode turn 2.4 GHz radio bursts into a voltage that follows each burst's strength (its envelope): exactly what the INMP441 did by accident in A1 (spike note finding 2), now on purpose. The S3's ADC samples that voltage at audio rate as a new **audio source driver** for `fr.audio_in`, so recording, levels and streaming come from A1 unchanged. A new **on-board monitor** routes an audio input straight to the board's speaker, so you hear the radio landscape live without the board streaming (its own streaming would be the loudest thing it hears).

## 1. Scope

In:
1. **The detector circuit** (§2), on `mic-s3`'s GPIO1, with your germanium point-contact diodes (a Schottky later, to compare).
2. **Driver `adc_audio`**: `hal::AudioSource` over IDF `adc_continuous` (ADC1, DMA), oversampled and averaged down to `sample_hz`.
3. **`fr.audio_in` 1.1: on-board monitor** (`monitor_start`, `monitor_stop`): any audio input to any audio output on the same board, inside the `fr_audio` task, no network.
4. **Hub and CLI:** op `audio_monitor`; `fr audio monitor <dev> [--from rf] [--to spk] [--seconds 30] [--volume 60]`.
5. **A self-test** that needs no person: the detector must hear the board's own Wi-Fi.

Out (the robot's later steps): Wi-Fi sensing in software (promiscuous mode, CSI) as a capability; movement; mapping sound to motion; blanking the board's own transmissions out of the monitor; an amplifier stage (an op-amp) if the plain detector is too quiet.

## 2. The detector circuit (D1)

```
  antenna 31 mm ──►|── DET ──┬──────────────► GPIO1 (ADC1 ch0)
                 diode       │        │
             (band = cathode)═╪═ 1 nF  ▯ 10 kΩ
                             │        │
  ground arm 31 mm ──────────┴────────┴───── GND
```

- **The antenna:** a straight wire 31 mm long on the diode's anode: a quarter of the 2.4 GHz wavelength (12.3 cm), so it resonates on the Wi-Fi band. A second 31 mm wire from GND, pointing the other way, makes it a dipole and roughly doubles what it picks up (*inferred*).
- **The diode** (anode to the antenna, cathode to DET) lets through only the positive half of each RF swing; the capacitor holds that peak, and the resistor lets it decay. Together they follow the burst's envelope: the voltage rises while a burst is on the air and falls back in about 10 µs after (1 nF × 10 kΩ), fast enough for audio.
- **Parts:** your germanium diode; a 1 nF ceramic (marked `102`); a 10 kΩ resistor (two in series, 20 kΩ, makes it a little more sensitive). Keep every lead short: at 2.4 GHz a centimetre of extra wire is a different antenna.
- **First, check the diode** with a multimeter's diode mode: germanium reads about 0.2–0.35 V one way and nothing the other way; the way that reads is anode on red. That also confirms which end the band marks.
- **Signal size** (*inferred*): from a few millivolts (the router across the room) to hundreds (the board's own antenna next to it). The ADC runs at 0 dB attenuation (about 0–950 mV full scale, about 0.25 mV per step), so strong nearby sources come through; weak far ones may need the op-amp later.
- **Pin:** GPIO1 is ADC1 channel 0, free on this board, and sits on the right header next to GND (J3: GND, 43, 44, **1**, 2, …). ADC1 does not conflict with Wi-Fi (ADC2 does, on the S3).

## 3. Firmware (D2–D4)

**D2. Driver `adc_audio`** (`hardware/drivers/adc_audio/`, `fr::drv::AdcAudio`): `hal::AudioSource` over `adc_continuous` on ADC1, one channel, bind `gpio.<n>` (an ADC1 pin of the board).
- Config: `atten` (`0`, `2.5`, `6`, `12` dB; default `0`), `oversample` (1–8, default 4: it converts at `sample_hz` × 4 and averages each group, a simple anti-alias filter for the fast bursts).
- It hands the existing converter 32-bit left-justified samples (12-bit reading << 20), so A1's gain, DC blocker, warm-up and meter apply unchanged; `gain_db` defaults to 24 (the detector is quieter than the mic, *inferred*, tuned on the bench).
- `max_sample_hz` 48000 (the S3's ADC DMA goes to about 83 kSps, *inferred*; 48 kHz × 4 is over it, so `oversample` is capped by rate).
- One `adc_continuous` per ADC1 unit; a board that also reads its battery with `adc_oneshot` on ADC1 cannot have both (codegen refuses; this board has no battery reader).

**D3. The on-board monitor** (`fr.audio_in` 1.1, additive):
- `monitor_start {to_port u8, seconds u16 (0 = until stop), volume u8 (0 = the output's own)}`, reliable; `monitor_stop`. Event `monitor_ended {reason: stopped | done | busy | error}`.
- Inside `fr_audio`: the input's converted samples go straight into the output's play ring (no network, no hub), at the input's rate; the output must run the same `sample_hz` (both default 16000), or the command answers `INVALID_ARGS`.
- The output is busy while monitoring: a `play` or `tone` ends the monitor (`busy`), and a monitor refuses to start while one plays.
- While monitoring, the input's `level` reports pause, so the board's own traffic stays at its heartbeat (1 Hz) and the TCP keepalive: that tick is still audible, the board's own voice in the landscape. Muting it is out of scope (§1).
- The mic → speaker monitor works too, but howls when the speaker is near the mic (feedback); the CLI warns.

**D4. Profile:** `s3a-audio` gains `rf` (`fr.audio_in` on `adc_audio`, bind `gpio.1`, `gain_db` 24). Its slots.lock gains port 5.

## 4. The hub and CLI (D5)

- Op `audio_monitor {device, from?, to?, seconds (1–3600, default 30), volume?}` (tier write, job): `from` defaults to the first `fr.audio_in`, `to` to the first `fr.audio_out`; it sends `monitor_start`, waits for `monitor_ended` (or the deadline + 5 s, then `monitor_stop`), cancels with `monitor_stop`.
- CLI `fr audio monitor <dev> [--from <inst>] [--to <inst>] [--seconds 30] [--volume <0-100>]`.
- `fr audio record mic-s3 --instance rf` records the detector (the op already takes `instance`), so the Mac can analyse it, at the cost of the board's own streaming bursts in the recording.

## 5. Gates (proposed)

**T-RF** (`tests/e2e/t-rf.ts`, tier target, `{}`):
1. **Self-hearing:** two 5 s recordings of `rf`, one while the board's radio is busy (diag `air bench` at 100 frames/s, the A1 S2 hook) and one while it is idle apart from the recording itself; busy RMS ≥ 10 dB above idle (proposed). This proves the antenna, diode and ADC path end to end.
2. **Monitor:** `audio_monitor` for 10 s from `rf` to `spk`: `monitor_ended done`, 0 speaker underruns, 0 input overflows (`stats audio`).
3. **Host:** the monitor path in the host suite (a sine source into a host sink: the same samples, in order, within 50 ms).
4. **Your ears, once:** the router's beacon tick (about 10 per second, every 102.4 ms), a phone or laptop busy nearby, and moving the antenna.

## 6. Bench steps for you

1. Check one diode with the multimeter (§2), and tell me the readings.
2. Build the detector on a breadboard or by soldering, short leads, with the board unplugged: diode, 1 nF, 10 kΩ, the 31 mm antenna (and the 31 mm ground arm), to GPIO1 and GND.
3. Listen with `fr audio monitor`; move it around; try a phone call or a large download nearby.

## 7. Risks

- **Too quiet:** a passive germanium detector at 2.4 GHz may only hear strong nearby sources. Then: a Schottky detector diode (HSMS-2850 is made for this, BAT54 or 1N5711 work), or an op-amp stage (MCP6002 at a gain of 20–50).
- **The board's own Wi-Fi dominates:** expected; the monitor keeps it to the heartbeat. Later: blank the input during the board's own transmissions, or lower its TX power while listening.
- **ADC noise from the S3 itself** (switching, Wi-Fi): the A1 bench saw the C3's ADC at 25–60 mV p-p under Wi-Fi (M2-C3); the S3's is *inferred* better. The DC blocker and oversampling help; the self-test measures it.

## 8. Decisions taken with you (2026-11-02)

1. **Listening:** live on the board's speaker (the on-board monitor), not streamed.
2. **Board:** `mic-s3`, the detector beside the mic as a second audio input.
3. **Parts:** your germanium diodes, ceramic capacitors (100 pF–10 nF and up), 1 kΩ/10 kΩ resistors; buying parts is fine if the bench shows a need.

**Proposed by the lead:** the detector on GPIO1 (D1), `adc_audio` as a general driver (any analog signal at audio rate, not only RF), the monitor in `fr.audio_in` 1.1 (D3), T-RF's numbers (§5).

## 9. Streams

- **C — contract:** `audio_in.cap.yaml` 1.1 (monitor commands and event), driver manifest `adc_audio` (codegen: the bind as an ADC1 pin, the ADC1-unit conflict check, `oversample` capped by rate), profile `rf`, op schema `audio_monitor`, regenerated outputs, tests.
- **F — firmware:** `AdcAudio` over `adc_continuous` (and a host shim), the monitor routing in `AudioInService`/`AudioOutService`/the engine, host tests (the monitor path, oversampling).
- **H — hub:** `audio_monitor` op and job, CLI, tests.
- **K — gate:** `t-rf.ts`, the plugin skill `audio` updated (the detector, the monitor).

## 10. Contract as built (stream C, 2026-11-02)

What streams F and H build on. Names here are final; a change goes through the lead.

**Capability** `fr.audio_in` **1.1** (`0x0007`, additive; generated `fr::cap::AudioIn` in `fr_caps/gen/audio_in.hpp`, TS `AUDIO_IN_CAP` in `packages/protocol/src/gen/caps/audio_in.ts`; spec 07 §7.1 table says 1.1):
- type `MonitorEndReason {stopped 0, done 1, busy 2, error 3}` (`cap::AudioInMonitorEndReason`); property `monitoring` (id 3, bool; `report_monitoring`); event `monitor_ended` (id 2, normal; `cap::AudioInMonitorEnded {reason, to_port u8, samples u32}`, `emit_monitor_ended`): samples is what was routed to the output.
- commands `monitor_start=4 {to_port u8, seconds u16 (0: until stop), volume u8 0..100 (0: the output's own)}` → no result (`Status monitor_start(const cap::AudioInMonitorStartArgs &)`), `monitor_stop=5` (idempotent, OK when none runs; `Status monitor_stop()`), both reliable. Answers: INVALID_ARGS when to_port is not an fr.audio_out port of the node or its config sample_hz differs from the input's; BUSY when this input already monitors, or streams at another rate, or the output plays, or another input monitors to it.
- Rules (doc in the YAML): the monitor runs at the input's config `sample_hz`; a `play` or `tone` on the output ends it `busy`; `level` STATEs pause while monitoring (level_get still answers from the meter); a stream and a monitor at one rate may run together (the same converted samples feed both); stream_start at another rate while monitoring answers BUSY.
- `AudioInService` had placeholder overrides (monitor_start → `Err::unsupported`, monitor_stop OK, `monitoring()` false) so the host suite built; F replaced them (below).

**Service hooks F adds** (proposed shape, IDF-free, in `fr/audio/engine.hpp`): `class audio::MonitorSink { Status monitor_claim(uint32_t sample_hz, uint8_t volume); size_t monitor_write(std::span<const int16_t> pcm); void monitor_release(); bool monitor_preempted() const; }`, implemented by `AudioOutService` (claim: invalid_args on another rate, busy while a tone or play runs or another claim holds it; write: fr_audio, into the play ring, the rest dropped; a tone or play while claimed sets preempted and takes the output; the output's `playing` reads true while claimed, and no play_done is sent for a monitor). `audio::Worker` gains `virtual uint8_t worker_port() const` (the service's `port()`) and `virtual MonitorSink *monitor_sink() { return nullptr; }`; `Engine::monitor_sink(uint8_t port)` (core task) finds the fr.audio_out worker on that capability port, so `AudioInService::monitor_start` resolves `to_port` without knowing the board. s3a-audio now has three workers (`Engine::kWorkersMax` 4).

**Driver** `adc_audio` (`hardware/drivers/adc_audio/`, a stub answering `Err::unsupported`; F fills `src/adc_audio.cpp` and a host shim `firmware/test/host/shim/idf/esp_adc/adc_continuous.h`): `fr::drv::AdcAudio` (`include/fr/drv/adc_audio.hpp`), `hal::AudioSource`; Config `uint8_t gpio; Atten atten {db0, db2_5, db6, db12} = db0; uint8_t oversample = 4` (1..8); `kMaxConversionsHz` 83,333 and `oversample_at(sample_hz)` (cfg.oversample lowered to fit, at least 1: a 48 kHz stream runs 1); a sample is the 12-bit mean centred and left-justified, `(mean - 2048) << 20`; `overruns()` from `on_pool_ovf`. Targets C3, C6, S3 (all have the ADC DMA at 83,333/s in IDF v6.1; benched on the S3 only); CMake `PRIV_REQUIRES esp_adc`; traits `max_sample_hz` 48000, `bits` 12; `cap_config: { gain_db: 24 }`; `resources: { gpio: 1, adc1_channel: 1, adc_continuous: 1 }`.

**Codegen** (`packages/codegen/src/board.ts`): a driver field may declare `range: [lo, hi]` (integers; checked for its default and a profile's value). `adc_continuous` (`ADC_CONTINUOUS_RESOURCE`) is not budgeted but checked by `checkAdcContinuous`: one instance per firmware, no other instance drawing `adc1_channel` (adc_oneshot), no board `battery`. Config `sample_hz × oversample` must fit `ADC_CONVERSIONS_HZ[target]` (83,333 on C3, C6, S3); a faster stream rate at runtime lowers oversample instead (no refusal). The bind follows the adc1_channel pin rules (pins.adc1, never ADC2 or the battery pin).

**Profile** `s3a-audio`: `rf: { cap: fr.audio_in, driver: adc_audio, bind: gpio.1, config: { gain_db: 24 } }`, port 5 (boot 1, status 2, mic 3, spk 4 unchanged).

**Hub op** (`packages/protocol/src/ops/audio.ts`): `audio_monitor {device, from?, to?, seconds 1..3600 = 30 (AUDIO_MONITOR_MAX_S, AUDIO_MONITOR_DEFAULT_S), volume? 1..100, wait_s?}` (job, mutate; CLI `audio monitor <device>`, flags `--from --to --seconds --volume` from the schema) → `AudioMonitorSchema {device, alias, from, to, seconds, reason (AUDIO_MONITOR_END_REASONS: stopped, done, busy, error, timeout), underruns?, rx_overflows?}`. H: `to_port` is the `to` instance's port; volume absent sends 0; wait for monitor_ended (or seconds + 5 s, then monitor_stop, reason `timeout`); cancel sends monitor_stop; `seconds` = samples / the input's config sample_hz; underruns and rx_overflows are the `stats audio` deltas of the two instances when they could be read; the CLI warns for a microphone monitored on a speaker (feedback). The hub answers CAPABILITY_UNSUPPORTED (`AUDIO_HANDLERS.audio_monitor`) until H. Job kind `audio`. REGISTRY_HASH `445e6697686c` → `ee5dc36bb005`; catalog_hash `0xd75bdaa2` → `0x0fcffa34`.

**Firmware as built (stream F, 2026-11-02).** The placeholders above are replaced; host-tested only (no IDF build yet).
- **Hooks** (`fr/audio/engine.hpp`), refined from the proposal: a claim has an id, so a stale input cannot touch a newer claim. `enum class audio::MonitorEnd {none, stopped, busy, error}`; `class audio::MonitorSink { std::expected<uint32_t, Err> monitor_claim(uint32_t sample_hz, uint8_t volume) /* core: the claim id */; size_t monitor_write(uint32_t claim, std::span<const int16_t>) /* fr_audio */; void monitor_finish(uint32_t claim) /* fr_audio: no more samples */; void monitor_release(uint32_t claim) /* core */; MonitorEnd monitor_preempted(uint32_t claim) const /* any */; }`. `audio::Worker` gains `virtual uint8_t worker_port() const` (default 0xFF) and `virtual MonitorSink *monitor_sink()` (default nullptr); `Engine::monitor_sink(uint8_t port)` (core task) returns the output worker's on that port.
- **AudioOutService** implements MonitorSink: claim = INVALID_ARGS unless its config `sample_hz`, BUSY while `playing` (a tone, a play or another claim); a monitor job empties the play ring as a play does, waits `kMonitorPrebufferMs` = **30 ms**, starts the sink and writes the ring out; the ring is capped at 30 ms + 2 × 240 samples (60 ms at 16 kHz), `monitor_write` drops above it (`monitor_dropped()`), so a source a little faster than the sink never builds latency up (adc_audio's divider runs at or above the rate: 16 kHz × 4 converts at 64,103/s, +0.16%). A dry pass counts an underrun as for a play but writes no silence. `playing` reads true while claimed, no `play_done` for a monitor. `tone`/`play` take the output (`busy`), `stop` ends it (`stopped`), a sink failure (`error`). After the input's last samples (`monitor_finish`) the DMA plays out uncounted until the release (the input's core timer, ≤ 50 ms).
- **AudioInService**: `monitor_start` order of answers: no fr.audio_out on `to_port` (or the input's own config rate unusable) INVALID_ARGS; already monitoring, or streaming at another rate, BUSY; then the claim's answer. `stream_start` at a rate other than config `sample_hz` while monitoring: BUSY. fr_audio runs the source at config `sample_hz` (warm-up dropped, the glide routed), hands each converted buffer to the output (no zeros for DMA loss), ends at `seconds` × rate samples (`done`), `monitor_stop` (`stopped`), the output taken (`busy`/`stopped`/`error`) or a source failure (`error`); the core timer releases the claim, reports `monitoring` false and emits `monitor_ended {reason, to_port, samples}` (samples handed to the output). `level` STATEs pause while monitoring.
- **Driver** `adc_audio`: `adc_continuous_io_to_channel` (ADC1 only, else `Err::unsupported`), `adc_continuous_new_handle` (`conv_frame_size` 256 conversions = 1 KB, `max_store_buf_size` 16 KB ≈ 60 ms at 64 kconv/s, `flush_pool` 0: about 21 KB internal RAM with IDF's five DMA buffers), `adc_continuous_register_event_callbacks` (`on_pool_ovf`, IRAM_ATTR), per start `adc_continuous_config` (one pattern: ADC1, the channel, `atten`, `SOC_ADC_DIGI_MAX_BITWIDTH`; `ADC_CONV_SINGLE_UNIT_1`; `sample_freq_hz` = rate × `oversample_at(rate)`), `adc_continuous_flush_pool`, `adc_continuous_start`; `read` = `adc_continuous_read` in 128-conversion chunks + `adc_continuous_parse_data`, groups averaged (carried across reads), `(sum << 20) / n − (2048 << 20)`; `adc_continuous_stop`. `overruns()` counts lost conversions in 240-sample buffers (lost / (240 × oversample)), which AudioInService puts back as zeros and counts in `stats audio` rx_overflows, as the mic's. Host shim: `firmware/test/host/shim/idf/esp_adc/adc_continuous.h` and `hal/adc_types.h` (v6.1's declarations verbatim, the S3's TYPE2 result), `shim/adc_sim.{hpp,cpp}`.
- **Bench notes:** the I2S amplifier's TX DMA is a ring of 6 × 240 frames, so a written buffer plays after the other five (about 75 ms at 16 kHz) whatever the monitor's prebuffer; with the ADC frame and the ring, expect about 120–135 ms mouth-to-ear on the board (the host path measures ≤ 50 ms). If that is too slow, i2s_amp with 3 descriptors (or `i2s_channel_preload_data`) is the lever. With the mic and rf running at once, the faster ADC (+0.16%) gains on the mic-paced loop and its pool overflows about every 2–3 s after the first 40 s (counted); a monitor alone is unaffected.

**Open:** the op takes volume 1..100 because 0 on the wire means "the output's own"; whether an output's `playing` should read true while monitored is the lead's call (as built in the hook above: true).


## 11. Bench round (2026-11-02)

- **Build:** the S3 image built for the target on the first try (`adc_audio` written against the real IDF v6.1 headers); every selftest passed, `rf` included ("the source starts and its DMA delivers").
- **The circuit, first version:** a 1 kΩ resistor (marked `102`) sat where the 1 nF capacitor (also marked `102`: 1000 pF) belonged, so GPIO1 read 913 Ω to GND (1 kΩ ∥ 10 kΩ) and the detector gave nothing a meter could see during a 60 s blast. Fixed by the capacitor; 10 kΩ to GND after.
- **Self-hearing, with the fixed circuit:** 5 s of `rf` idle vs during a 100 frames/s broadcast blast (`air bench tx bcast 6000 200 10`): RMS −36.0 vs −35.4 dBFS (gain 24 dB), but the blast's 10 ms rhythm shows (envelope autocorrelation 0.38 against 0.05 idle; the idle one carries the recording's own 100 ms streaming rhythm, 0.12). Folded at 10.00 ms the pulses swing 181 LSB against 555 LSB of per-sample noise: about 0.2 mV at the ADC (*inferred* from the gains), 5 cm from the board's antenna at 20 dBm. T-RF's proposed ≥ 10 dB rule would fail.
- **The monitor by ear** (20 s, then 45 s with blasts at 10, 4 and 2 ms): no audible change at the blasts; touching the detector changes the sound (the body couples mains hum and noise onto the 10 kΩ node). At 2 ms the radio saturated (1,731 sent, 1,269 refused: a 200 B frame takes about 1.9 ms at 1 Mbps) and `rf` clipped 13 samples.
- **A floating ADC pin** (a temporary profile with `rf` on GPIO10, a camera-connector line with nothing fitted): RMS −11.7 dBFS, 1,136 clipped samples in 4 s, the 50 Hz band 73 dB with harmonics at 100/150/250 Hz about 20 dB below: the house's wiring. The profile is back on GPIO1 (the detector).
- **Not done:** the review pass; `tests/e2e/t-rf.ts`; the `audio` plugin skill's detector and monitor sections; the Schottky and op-amp versions.
