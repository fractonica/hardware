// The hub's one cursor space (spec 08 §8.7, design c3 §4): log lines and events take their seq from the
// same counter, so a cursor `c:<run>.<seq>` orders both and a wait since a cursor sees either kind.
// seq is monotonic across runs: it starts after the largest seq either table holds.

import type { Seq } from './context.ts';
import type { Db } from './db.ts';

export class CursorSeq implements Seq {
  #last: number;

  constructor(db: Db) {
    const row = db.prepare('SELECT MAX(m) AS m FROM (SELECT MAX(seq) AS m FROM logs UNION ALL SELECT MAX(seq) AS m FROM events)').get() as {
      m: number | null;
    };
    this.#last = row.m ?? 0;
  }

  next(): number {
    return ++this.#last;
  }

  head(): number {
    return this.#last;
  }
}
