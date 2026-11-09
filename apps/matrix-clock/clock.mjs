// matrix-clock: a Fractonica worker (fr app deploy apps/matrix-clock). It shows the time on a 13x8 LED matrix through
// the hub, like any app driving any device: the device's `matrix` instance (fr.display) gets clear and text commands.
// The matrix fits two digits, so it shows the hours, then the minutes with a dot in the corner.
// Settings (fr app env matrix-clock --set NAME=value): DEVICE (default uriel), TZ (e.g. Europe/Istanbul; default: the
// board's time zone, timedatectl set-timezone).
import { connect } from '@fractonica/sdk';

const hub = await connect({ url: process.env.FR_HUB_URL, token: process.env.FR_APP_TOKEN });
hub.on('error', (e) => console.error('hub:', e.message ?? e));
const device = hub.devices.byAlias(process.env.DEVICE ?? 'uriel');
console.log(`matrix-clock: showing the time on ${device.alias} (TZ ${process.env.TZ ?? 'UTC'})`);

let showMinutes = false;
let last = '';
setInterval(async () => {
  if (!device.online) {
    return;
  }
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const text = showMinutes ? two(now.getMinutes()) : two(now.getHours());
  const frame = `${text}${showMinutes ? '.' : ''}`;
  showMinutes = !showMinutes;
  if (frame === last) {
    return;
  }
  last = frame;
  try {
    await device.raw.call('matrix', 'clear', { color: 0 });
    await device.raw.call('matrix', 'text', { x: 1, y: 0, text });
    if (frame.endsWith('.')) {
      await device.raw.call('matrix', 'fill_rect', { x: 12, y: 7, w: 1, h: 1, color: 0xffffff });
    }
  } catch (e) {
    console.error('matrix:', e.message ?? e);
  }
}, 2000);
