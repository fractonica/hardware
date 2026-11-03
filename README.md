# Fractonica

Fractonica is an agent-first framework for prototyping networks of ESP32 devices. It has four parts:

- **Node firmware.** Reusable capability modules (button, LED, display, analog in, …) backed by swappable drivers from a hardware library.
- **Networking.** ESP-NOW between nodes and Wi-Fi to a hub.
- **The hub.** It runs on a Mac (later a Raspberry Pi) and has a realtime dashboard for flashing, monitoring and OTA.
- **Agent and app access.** One API that any agent can drive (CLI `fr --json`, REST, MCP), plus a generated JS/TS library with your device ids built in, for apps such as games.

## Status

The spec is at v0.3. The toolchain is installed (ESP-IDF v6.1). M0 spikes are in progress.

- **User manual: [`docs/user-manual.md`](docs/user-manual.md).** Step-by-step guides for every feature on the bench (camera, audio, CSI, pads, displays, updates, tests, apps, agents).
- Spec: [`docs/spec/`](docs/spec/README.md). Start with the README there; it has the decisions and the roadmap.
- Research behind the spec, with sources: [`docs/research/`](docs/research/).

## Layout (planned, see [docs/spec/02-architecture.md](docs/spec/02-architecture.md))

```
docs/        spec + research
schema/      protocol + capability catalog (single source of truth)
hardware/    board manifests + driver components
firmware/    ESP-IDF components, apps, profiles, partitions
packages/    TypeScript: protocol, codegen, hub, dashboard, sdk, cli
tools/       pytools (esptool sidecar)
plugin/      Claude Code plugin
tests/       e2e and HIL scenarios
```
