# Apps

Background services and websites in Node.js that a Fractonica hub on Linux runs next to itself: the UNO Q's hub, `hosts/uno-q`. An app reaches the hub's devices through `@fractonica/sdk`. Design: [docs/design/uno-q-services.md](../docs/design/uno-q-services.md).

## An app

A folder with a manifest, `fractonica.app.json`:

```json
{
  "name": "my-bot",
  "kind": "worker",
  "start": "node bot.mjs",
  "description": "what it does",
  "version": "0.1.0",
  "env": ["BOT_TOKEN"]
}
```

| Field | Meaning |
|---|---|
| `name` | 2–32 characters: lowercase letters, digits and `-`, starting with a letter. The unit is `fr-app-<name>.service` |
| `kind` | `worker` (a background service) or `web` (it also serves HTTP on `PORT`) |
| `start` | The command that runs it, in its folder |
| `port` | `web` only, optional: the port to serve on. The default is the lowest free one from 8100 up |
| `env` | The names of the settings it needs. `fr app ls` lists the ones still missing |

**What it gets:**
- A `package.json` brings dependencies: the hub runs `npm ci --omit=dev`, or `npm install` without a lockfile.
- `@fractonica/sdk` is provided by the hub: import it without listing it.
- The hub sets these variables:

| Variable | Value |
|---|---|
| `PORT` | `web` apps only: the port to serve on |
| `DATA_DIR` | Its own folder, kept across deploys; the only place it may write |
| `FR_HUB_URL`, `FR_APP_TOKEN` | For `connect()` |
| `FR_APP` | Its name |
| `NODE_ENV` | `production` |

```js
import { connect } from '@fractonica/sdk';
const hub = await connect({ url: process.env.FR_HUB_URL, token: process.env.FR_APP_TOKEN });
const board = hub.devices.byAlias('uriel');
await board.raw.call('matrix', 'text', { x: 1, y: 0, text: 'Hi' });
```

## Commands

From the Mac, through `make hub-tunnel` (in `hosts/uno-q`) and `FR_HUB=http://127.0.0.1:7520`; on the board, plain `fr`:

```bash
fr app deploy apps/hello-web                   # pack, upload, npm install, unit, start, check
fr app ls                                      # state, memory, restarts, port and URL, settings by name
fr app logs hello-web --lines 200
fr app env my-bot --set BOT_TOKEN=… --unset OLD
fr app restart|stop|start my-bot
fr app rm my-bot [--purge]                     # --purge also deletes DATA_DIR and the settings
```

**Deploys:**
- A deploy keeps the previous release.
- If the new one does not stay running for 4 s, the deploy rolls back to the previous release and fails with its last log lines.

**Settings:**
- They live in a root-only file on the board, never in the hub's database.
- No answer ever returns their values.
- An app restarts when its settings change.

**Where apps show up:**
- The display's SERVICES page, where a button press opens Logs, Restart, Stop, Start and Remove (`fr app rm`, keeping the data).
- `http://<board>/`, which links each website.

**MCP:** the same operations are tools for agents (`app_list`, `app_logs`, `app_env`, …).

## Examples

| App | What it shows |
|---|---|
| [hello-web](hello-web) | A page and a JSON API listing the hub's devices, live |
| [matrix-clock](matrix-clock) | A worker driving a device: the time on the UNO Q's LED matrix. `TZ` sets the time zone |
