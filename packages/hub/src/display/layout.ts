// The size of a command against the BULK MTU (design m2-c5-display D2, D10): fr.display ui_load's layout is the
// one command whose args can pass what a BULK frame carries (24 widgets at their longest encode to ~2.9 KB), so the
// hub encodes it before sending and refuses an oversize one with the widget count that would fit. Other commands
// are checked the same way; their args are far smaller.

import { FrError } from '@fractonica/protocol';
import { encodeMember, MTU } from '@fractonica/protocol/gen';

/**
 * A CMD's header (18 B) and its EXT block with expire_at (a length byte and one 6-byte TLV): what a BULK frame
 * carries besides the args (05 §5.8; the router's #request counts the same).
 */
export const CMD_OVERHEAD = 18 + 7;
/** The largest args a BULK CMD carries: MTU.BULK less the header and EXT block (1,445 B, as a RESULT's Reply). */
export const BULK_ARGS_MAX = MTU.BULK - CMD_OVERHEAD;

/** How many of a layout's widgets fit one BULK frame, from the first one on, and the args size of those. */
export function layoutFit(layout: Record<string, unknown>): { widgets: number; bytes: number } {
  const widgets = Array.isArray(layout.widgets) ? (layout.widgets as unknown[]) : [];
  const size = (n: number) => {
    const enc = encodeMember('fr.display', 'args', 'ui_load', { layout: { ...layout, widgets: widgets.slice(0, n) } });
    return enc.ok ? enc.value.length : Infinity;
  };
  // Sizes grow with n: the largest n whose prefix fits.
  let lo = 0;
  let hi = widgets.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(mid) <= BULK_ARGS_MAX) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { widgets: lo, bytes: size(lo) };
}

/**
 * Refuses args that no BULK frame carries (INVALID_ARGS naming the size and the limit; for ui_load also the widget
 * count that fits), before anything is sent: the node closes a TCP connection on a frame over its BULK MTU.
 */
export function checkArgsSize(cap: string, command: string, args: Record<string, unknown>, bytes: Uint8Array): void {
  if (bytes.length <= BULK_ARGS_MAX) {
    return;
  }
  const what = `${cap}.${command}`;
  const limit = `${BULK_ARGS_MAX} B a BULK frame carries (MTU ${MTU.BULK} B less the ${CMD_OVERHEAD} B header)`;
  const details: Record<string, unknown> = { bytes: bytes.length, limit: BULK_ARGS_MAX, mtu: MTU.BULK };
  if (cap === 'fr.display' && command === 'ui_load' && typeof args.layout === 'object' && args.layout !== null) {
    const layout = args.layout as Record<string, unknown>;
    const count = Array.isArray(layout.widgets) ? layout.widgets.length : 0;
    const fit = layoutFit(layout);
    throw new FrError('INVALID_ARGS', `${what}: the layout encodes to ${bytes.length} B with ${count} widgets, over the ${limit}; the first ${fit.widgets} widgets fit (${fit.bytes} B)`, {
      hint: `keep at most ${fit.widgets} widgets of this kind, or shorten texts and ids (a widget is ~20 B plus its id and text, 124 B at most); draw static text with text/fill_rect after ui_load`,
      details: { ...details, widgets: count, widgets_fit: fit.widgets },
    });
  }
  throw new FrError('INVALID_ARGS', `${what}: the args encode to ${bytes.length} B, over the ${limit}`, { details });
}
