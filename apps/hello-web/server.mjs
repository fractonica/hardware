// hello-web: a Fractonica web app (fr app deploy apps/hello-web). It serves on PORT, which the hub gives it, and reads
// the hub's devices through @fractonica/sdk (provided by the hub: no npm install), connected with the hub's URL and
// app token from its environment (FR_HUB_URL, FR_APP_TOKEN).
//   GET /             a page listing the devices, refreshed every few seconds
//   GET /api/devices  the same as JSON
import { createServer } from 'node:http';
import { hostname, uptime } from 'node:os';

import { connect } from '@fractonica/sdk';

const hub = await connect({ url: process.env.FR_HUB_URL, token: process.env.FR_APP_TOKEN });
hub.on('error', (e) => console.error('hub:', e.message ?? e));

const devices = () =>
  hub.devices.all().map((d) => ({
    id: d.id,
    alias: d.alias,
    presence: d.presence,
    profile: d.profile,
    instances: d.instances.map((i) => `${i.name} (${i.cap})`),
  }));

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const page = () => `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1"><meta http-equiv=refresh content=5>
<title>${esc(hostname())}</title>
<style>body{margin:0;padding:24px;background:#0b0f17;color:#e5e7eb;font:15px system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}p{color:#8b95a5;margin:0 0 20px}
.d{background:#151b26;border-radius:10px;padding:12px 14px;margin:0 0 10px}
.on{color:#34d399}.off{color:#f87171}small{color:#8b95a5}</style>
<h1>${esc(hostname())}</h1><p>up ${Math.round(uptime() / 60)} min · ${devices().length} devices on the hub · <a style="color:#60a5fa" href="/api/devices">JSON</a></p>
${devices()
  .map(
    (d) => `<div class=d><b>${esc(d.alias)}</b> <span class=${d.presence === 'online' ? 'on' : 'off'}>${esc(d.presence)}</span>
<br><small>${esc(d.id)} · ${esc(d.profile ?? 'no profile')} · ${esc(d.instances.join(', ') || 'no instances')}</small></div>`,
  )
  .join('')}
</html>`;

createServer((req, res) => {
  if (req.url === '/api/devices') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ devices: devices() }, null, 1));
  } else if (req.url === '/' || req.url?.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page());
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
  }
}).listen(Number(process.env.PORT ?? 8100), () => console.log(`hello-web on port ${process.env.PORT}`));
