# WIRING-1: wiring guides and a parts catalogue in the hub

> **As built (2026-11-05): implemented with the tests of §7, not reviewed, the hub not restarted.**
> - **Code:**
>   - protocol `ops/wiring.ts`;
>   - hub `wiring/catalog.ts` (the loader, validation, cross-check and SVG check) and `wiring/ops.ts`;
>   - static routes in `web/static.ts`;
>   - CLI `render-wiring.ts`;
>   - the `web/bench` app.
> - **Choices the draft left open:**
>   - **Strict files.** Both file kinds are strict: an unknown field refuses the file, so a typo cannot hide.
>     - Beyond the draft's fields, a section may have `intro`, and a step `note` and its own `diagram`.
>     - A connection's `instance` without `bind` is right only for an instance bound to one bare pin (`bind: gpio.N`).
>     - A connection to an instance bound to a board entry (`leds.rgb`) is `unchecked`.
>   - **A pin table row's check** is `ok`, `warning`, `failed` or `unchecked`.
>     - A row without an instance on a GPIO the profile binds is a warning ("name it") unless another row names it.
>     - Two instances on one GPIO fail.
>     - A guide with a `board` and no `profile` still has its GPIOs checked against the board's free pins.
>   - **Undoing steps:** a separate op, **`wiring_undo`** (`fr wiring undo <guide> <steps…>`), beside `wiring_step` (`fr wiring done`). Both take steps as a list or the CLI's words. Eleven ops in all.
>   - **CI exit status:** `fr wiring check` exits 1 when a guide was refused or failed. `wiring_check` reads the files again.
>   - **No codegen at startup:** the hub imports `@fractonica/codegen` (its profile and board loaders) on the first wiring op, never at startup, keeping hub-c2-build's rule. The catalogue is cached per hub until `wiring_reload` or `wiring_check`.
>   - **Event handlers in diagrams:** event-handler attributes (a chat diagram's `onclick`) are allowed in a diagram file, which is served with `script-src 'none'`. `web/bench` strips them, scripts, foreignObject and `javascript:` before inlining.
>   - **Reserved name:** `wiring` joins the reserved instance names (hub and codegen lists), as `power` and `cell` did, for the `wiring.step` event.
>   - **Live state on a guide page:** it comes from `device_get` every 5 s (presence and the mirror's `<instance>.*` values on the pins' chips), not from the `/app` socket.
>   - **Stock order:** stock rows list in the part's `values` order.

> **Draft, 2026-11-05.** Asked for: "the hub should contain entries with wiring instructions, and a component catalogue, so I can come back to it in the hub and wire everything instead of looking for it in the chat." It is also a **workflow**: every project that asks the user to solder something ships a wiring guide in the repo, the hub serves it, and the user ticks the steps off at the bench. Decisions here are proposals the user can overturn.

## 1. Scope

**In:**
- two kinds of source file in the repo:
  - **parts** (`hardware/parts/*.part.yaml`): what a component is, its pins, specs and quirks;
  - **wiring guides** (`hardware/wiring/<id>/guide.yaml` plus SVG diagrams): the bill of materials, sections of steps, diagrams, safety notes and a pin table;
- the hub loads, validates and serves both, and **cross-checks each guide's pin table against its device profile**, so a guide and the firmware cannot silently disagree;
- per-user state in the hub's database:
  - which steps are done;
  - what parts are on hand and where;
- ops, CLI, a `web/bench` app at `/apps/bench/`, and a `wiring` plugin skill that makes writing a guide part of every hardware change;
- the first content: the POWER-1 bench on scale-c6 (design power-p1 §2) and the parts it uses.

**Out:**
- **diagrams generated from the net list:** diagrams are authored SVG for now; the pin table is the machine-readable part;
- **live electrical verification of a step:** reading the ADC or selftests after flashing is a follow-up. Each step can carry a `check` text: what to measure and what to expect.

## 2. Parts (D1)

`hardware/parts/<id>.part.yaml`, `schema: fractonica/part@1`:

```yaml
schema: fractonica/part@1
id: tp4056-protected
name: TP4056 charger module with protection
category: power            # power | passive | semiconductor | actuator | sensor | display | board | module | cell | misc
summary: 1 A linear Li-ion charger (4.2 V CV) with DW01 + 8205A cell protection, USB-C input.
values: []                 # for generic parts (resistor, capacitor, diode): the values in use, e.g. ["10 kΩ", "1 MΩ"]
specs:                     # free key → text; `inferred` lists the keys not read in a datasheet or on the bench
  charge_voltage: 4.2 V
  charge_current: 1 A (R_PROG 1.2 kΩ)
inferred: [charge_current]
pins:                      # pads/legs in physical order where it matters
  - { name: IN+, desc: 5 V input (or the USB-C) }
  - { name: OUT+, desc: protected cell + (same as B+ on this board) }
pinout: "TO-92 flat face toward you: E B C"   # optional one-line orientation hint
notes: ["CHRG and STDBY drive the LEDs from IN+; tap them through 10 kΩ."]
datasheets: [https://…]
image: tp4056-protected.jpg  # optional, next to the yaml
```

Rules:
- `id` is kebab-case and unique.
- `category` is from the enum above.
- `values` is non-empty only for generic parts. A guide's BOM line for such a part must name one of them.

## 3. Wiring guides (D2)

`hardware/wiring/<id>/guide.yaml`, `schema: fractonica/wiring@1`, with its diagrams beside it:

```yaml
schema: fractonica/wiring@1
id: power-bench-c6
title: Power bench on scale-c6
summary: Two TP4056 chargers, a LiPo, the 90 F capacitor, a coin motor and the solenoid on scale-c6.
board: esp32c6-wroom1-n8
profile: c6w-scale          # optional: the pin table is checked against it
device: scale-c6            # optional alias, for the app's live links
design: docs/design/power-p1.md
covers: [battery, cap, buzz, kick]   # profile instances whose binds the pin table must list in full
safety:
  - "Unplug the USB charger and the C6 before soldering."
bom:
  - { part: tp4056-protected, qty: 2, note: "#1 LiPo, #2 capacitor" }
  - { part: resistor, value: 1 MΩ, qty: 4 }
diagrams:
  - { id: divider, title: Sense divider (GPIO0, GPIO1), file: divider.svg }
connections:                # the pin table; machine-checked
  - { pin: gpio.0, instance: battery, bind: sense, to: "TP4056 #1 OUT+ through the divider", via: "1 MΩ / 1 MΩ, 100 nF" }
  - { pin: 5v, to: "Q1/Q2 pull-ups (solenoid driver)" }        # no instance: a power pin
sections:
  - id: sense
    title: Voltage sense
    diagram: divider
    steps:
      - id: sense-battery
        text: "Solder R1 (1 MΩ) from TP4056 #1 OUT+ to a free row; …"
        pins: [gpio.0]
        check: "With the LiPo in: GPIO0 reads half the cell voltage on a multimeter (≈ 1.85–2.1 V)."
```

**Validation** (on load; refused guides are listed with their errors, never served half-valid):
- `id` matches its directory, and step ids are unique across the guide.
- Every `bom.part` exists, and a generic part's `value` is one of the part's `values`.
- Every `diagram` file exists and is an SVG holding no `<script>` and no external references.
- Every step's `pins` and section's `diagram` refer to declared ones.

**The cross-check against the profile** (when `profile` is set):
- every connection with `instance` + `bind` must equal the profile's `caps.<instance>.bind.<bind>` (`gpio.N`);
- every bind of every `covers` instance must appear in the pin table;
- a pin may not be listed twice for different instances;
- every pin must be in the board's `pins.free`, or be a power pin (`3v3`, `5v`, `gnd`), or be a strapping pin whose `strapping_levels` entry is `none`. That last case is a **warning** on the connection, not a failure (codegen allows it too, with a warning, as for POWER-1's GPIO5).

A mismatch is reported as a **check failure** on the guide. The guide is still served, with the failure shown at the top: an outdated guide is useful, but must say it is outdated. `pnpm test` runs the same checks on every guide in the repo, so a profile change that breaks a guide fails CI.

**Diagrams** are SVG using the drawing vocabulary of the chat's diagrams:
- text classes `t`, `ts`, `th`;
- colour classes `c-gray`, `c-teal`, `c-amber`, `c-coral`, `c-purple`, `c-blue`;
- the variables `--p` (primary stroke), `--s` (secondary), `--t` (tertiary);
- the `arrow` marker.

`web/bench` provides that CSS in light and dark and inlines the SVG, so a diagram drawn for the chat drops into a guide unchanged.

## 4. The hub (D3)

**Loading:** at start and on `wiring_reload`, from the repo the hub serves (`hardware/parts`, `hardware/wiring`). Parse errors never stop the hub.

**State tables** (migrations as `power`'s, `CREATE … IF NOT EXISTS`):
- `wiring_progress (guide, step, done_at)`: a row per done step;
- `parts_stock (part, value, qty, location, note, updated_at)`: primary key `(part, value)`, with `value` `''` for non-generic parts.

**Ops:**
- `wiring_list` → `[{id, title, summary, profile, device, steps, done, check: ok|failed|none, errors}]`.
- `wiring_show {guide}` → the guide resolved:
  - BOM lines with each part's name, stock and **missing** quantity;
  - sections with done flags;
  - diagram URLs;
  - the connections with each one's check status;
  - the check result.
- `wiring_step {guide, step, done}`; `wiring_reset {guide}`.
- `wiring_check {guide?}`: the cross-check alone, for CI and agents.
- `wiring_reload`.
- `wiring_shopping {guide?}`: what to buy. Summed over the guides given, or all unfinished ones, minus stock: `[{part, value, need, have, missing}]`.
- `part_list {category?, query?}`.
- `part_show {part}`: the part, its stock rows and the guides that use it.
- `part_stock {part, value?, qty, location?, note?}`.

**Static files:**
- each guide's diagrams at `/wiring/<guide>/<file>`;
- part images at `/parts/<file>`;
- served read-only, path-checked, SVG with `Content-Security-Policy: script-src 'none'`.

**Events:** `wiring.step {guide, step, done}` on the bus, so an agent watching the bench knows when the user finished a section.

## 5. CLI and app (D4)

**CLI:**
- `fr wiring list`
- `fr wiring show <guide>`: sections and steps with ✓, the pin table and the check result
- `fr wiring done <guide> <step…>`, `fr wiring undo <guide> <step…>`
- `fr wiring check [guide]`
- `fr wiring shopping [guide]`
- `fr parts list [--category c] [query]`
- `fr parts show <part>`
- `fr parts stock <part> [--value v] <qty> [--location l]`

**`web/bench`** at `/apps/bench/`, with two views.
- **Guides:**
  - a list with progress bars;
  - each guide's page shows:
    - the safety box first;
    - the check banner when it failed;
    - the BOM with have/missing;
    - each section with its diagram (inline SVG, click to enlarge) beside its steps (checkboxes, the `check` text under each step, the pins as chips);
    - the full pin table with ✓/✗ per row;
    - a link to the design note;
    - when `device` is online, the device's live state beside the pins it uses (a chip per instance: online, its latest value).
  - Ticks save at once and are shared with the CLI.
- **Parts:**
  - a searchable catalogue grouped by category;
  - a part card with summary, specs (inferred ones marked), pins and pinout hint, notes, datasheet links, stock (editable inline) and "used by" guides;
  - a shopping list across unfinished guides.

The app follows `web/power`'s structure (vite, tests, root typecheck entry, hub app list).

## 6. The workflow (D5)

The `wiring` plugin skill (`plugin/skills/wiring/SKILL.md`) makes this the default for every hardware change:
1. Whenever a design asks the user to connect anything, the agent writes or updates the guide **in the same change** as the profile. That means the parts it needs, a pin table matching the profile, steps a person can follow one at a time, a `check` per step where a multimeter can confirm it, and the diagrams.
2. `fr wiring check` passes before the change is committed.
3. The agent points the user at `/apps/bench/` (the guide's page) instead of pasting tables into the chat, and alerts them for the physical step as before.
4. When the user reports a part they have, or a quirk found at the bench (a pinout, a value), the agent records it in the part file (or `part_stock`), so the next guide knows.

## 7. Gate

Vitest, no hardware:
- every guide in the repo loads and passes its cross-check;
- a guide edited to disagree with its profile fails with the right message;
- the ops against a temp database: progress, stock, shopping arithmetic;
- the SVG sanitiser refuses a `<script>`.
