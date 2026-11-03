// The round display's update pace (design scale-round-c1 D12: ui_set at up to 5 Hz while the page is open), DOM-free:
// the newest reading wins (latest, never queued), an update goes out at most once per 1/maxHz and only after the
// previous one finished (its ui_set RESULTs came back), and a reading equal to what the screen shows sends nothing.
// reset() starts a new generation (a new layout): an update taken before it that finishes after it is not what the
// new layout shows, so its done() is ignored (pass the generation read when it was taken).

export class LatestThrottle<T> {
  readonly periodMs: number;
  #pending: T | undefined;
  #has = false;
  #lastAt = -Infinity;
  #busy = false;
  readonly #same: (a: T, b: T) => boolean;
  #shown: T | undefined;
  #hasShown = false;
  #gen = 0;

  constructor(maxHz: number, same: (a: T, b: T) => boolean = Object.is) {
    if (!(maxHz > 0)) {
      throw new RangeError('maxHz must be > 0');
    }
    this.periodMs = 1000 / maxHz;
    this.#same = same;
  }

  /** The newest value to show (replaces one not sent yet). */
  offer(v: T): void {
    this.#pending = v;
    this.#has = true;
  }

  /**
   * The value to send now, or undefined: nothing new, the same as shown, the period not over, or an update in flight.
   * A value taken marks the throttle busy until done().
   */
  take(now: number): T | undefined {
    if (!this.#has || this.#busy || now - this.#lastAt < this.periodMs) {
      return undefined;
    }
    const v = this.#pending as T;
    this.#has = false;
    this.#pending = undefined;
    if (this.#hasShown && this.#same(this.#shown as T, v)) {
      return undefined;
    }
    this.#busy = true;
    this.#lastAt = now;
    return v;
  }

  /**
   * The update taken last finished: `shown` (when it reached the screen) is what the screen now shows. `generation`:
   * the one current when it was taken; an older one (a reset came meanwhile) changes nothing, since neither its value
   * nor the busy flag belongs to the new layout.
   */
  done(shown?: T, generation = this.#gen): void {
    if (generation !== this.#gen) {
      return;
    }
    this.#busy = false;
    if (shown !== undefined) {
      this.#shown = shown;
      this.#hasShown = true;
    }
  }

  /** Forget what the screen shows (a new layout was loaded): the next value goes out whatever it is. */
  reset(): void {
    this.#gen++;
    this.#hasShown = false;
    this.#shown = undefined;
    this.#busy = false;
    this.#lastAt = -Infinity;
  }

  /** Bumped by reset(): read it when taking an update, give it back to done(). */
  get generation(): number {
    return this.#gen;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** What the screen shows as far as the throttle knows. */
  get shown(): T | undefined {
    return this.#shown;
  }
}
