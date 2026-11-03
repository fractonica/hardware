// web/cam's recordings table model (src/recordings.ts): camera_sd_list's rows newest first, the totals, removal, the
// card's state text.

import { describe, expect, it } from 'vitest';

import { cardText, formatMb, recordingHex, RecordingsModel } from '../src/recordings.ts';

const list = {
  sd: 'mounted' as const,
  sd_free_mb: 29_000,
  recordings: [
    { id: 3, frames: 10, bytes: 400_000 },
    { id: 42, frames: 0, bytes: 0 },
    { id: 17, frames: 120, bytes: 5_000_000 },
  ],
};

describe('RecordingsModel', () => {
  it('holds the list newest first with the per-row figures and the card', () => {
    const m = new RecordingsModel();
    expect(m.count).toBe(0);
    expect(m.listedAt).toBeNull();
    m.set(list, 12.5);
    expect(m.rows.map((r) => r.id)).toEqual([42, 17, 3]);
    expect(m.get(3)).toEqual({ id: 3, frames: 10, bytes: 400_000, hex: '0x00000003', perFrame: 40_000 });
    expect(m.get(42)?.perFrame).toBe(0);
    expect(m.totals).toEqual({ frames: 130, bytes: 5_400_000 });
    expect(m.card).toEqual({ sd: 'mounted', freeMb: 29_000 });
    expect(m.listedAt).toBe(12.5);
  });

  it('removes a recording, drops its busy mark, and clears', () => {
    const m = new RecordingsModel();
    m.set(list, 1);
    m.busy.add(17);
    m.remove(17);
    expect(m.rows.map((r) => r.id)).toEqual([42, 3]);
    expect(m.busy.has(17)).toBe(false);
    m.remove(999); // unknown: nothing happens
    expect(m.count).toBe(2);
    m.setCard('none', 0);
    expect(m.card).toEqual({ sd: 'none', freeMb: 0 });
    m.clear();
    expect(m.count).toBe(0);
    expect(m.card).toEqual({ sd: null, freeMb: null });
    expect(m.listedAt).toBeNull();
  });
});

describe('the card state and when to list', () => {
  it('asks for a list when the card becomes mounted, none while it says none, and drops the rows of a card that went', () => {
    const m = new RecordingsModel();
    expect(m.listable).toBe(true); // unknown yet: a list may be tried (an older board without the property)
    expect(m.setCard('none', 0)).toBe(false);
    expect(m.listable).toBe(false); // no card: camera_sd_list would answer UNSUPPORTED
    expect(m.setCard('none', 0)).toBe(false);
    expect(m.setCard('mounted', 29_000)).toBe(true); // the card came: list now
    expect(m.listable).toBe(true);
    expect(m.setCard('mounted', 28_999)).toBe(true); // still unlisted (the list is in flight or failed): asked again
    m.set(list, 5);
    expect(m.setCard('mounted', 28_000)).toBe(false); // a free-space tick on a listed card: no new list
    expect(m.card).toEqual({ sd: 'mounted', freeMb: 28_000 });
    expect(m.count).toBe(3);
    expect(m.setCard('none', 0)).toBe(false); // the card went: its recordings with it
    expect(m.count).toBe(0);
    expect(m.listedAt).toBeNull();
    expect(m.setCard('mounted', 29_000)).toBe(true); // back in: listed again
    m.set(list, 9);
    expect(m.setCard(null, null)).toBe(false); // unknown keeps the rows (a status that failed to say)
    expect(m.count).toBe(3);
    expect(m.setCard('error', null)).toBe(false);
    expect(m.count).toBe(0);
    expect(m.listable).toBe(true); // an error state is not `none`: a list may still be tried, and its error shown
  });
});

describe('text', () => {
  it('names the card state and formats megabytes', () => {
    expect(cardText({ sd: null, freeMb: null })).toBe('card: unknown');
    expect(cardText({ sd: 'none', freeMb: 0 })).toBe('no card');
    expect(cardText({ sd: 'error', freeMb: 0 })).toBe('card error');
    expect(cardText({ sd: 'mounted', freeMb: null })).toBe('card mounted');
    expect(cardText({ sd: 'mounted', freeMb: 512 })).toBe('card mounted · 512 MB free');
    expect(cardText({ sd: 'mounted', freeMb: 29_900 })).toBe('card mounted · 29.2 GB free');
    expect(formatMb(-1)).toBe('–');
    expect(recordingHex(0x2a)).toBe('0x0000002a');
    expect(recordingHex(0xffffffff)).toBe('0xffffffff');
  });
});
