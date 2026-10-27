// The person bot (design m2-c2 D11): on the fleet nobody is at the bench, so the sim runner hands every line a bench
// module logs to this bot, which answers the `PLEASE:` lines (lib/nn-flood-common.ts ask, lib/prov-ota-bench.ts ask)
// through fr_fleet's control channel, as e2e-gates-c's presser does for a loopback hub: presses (`inject`), power
// off and on, USB detach and attach, the AP off and on. The modules then see what they would on the bench: boot.*
// events, a port detached, a node offline by timeout, TCP sessions ending and coming back.
//
// Each handler names the module and line it answers. A PLEASE line no handler knows is recorded (the run then waits
// as it would for a person who is not there, and its own timeout says so).

import type { FleetControl, FleetState } from './fleet-diag.ts';

/** One thing the bot did, for the evidence. */
export interface PersonAction {
  at: number;
  /** The PLEASE line's text. */
  please: string;
  /** The control lines sent, in order, or why none. */
  did: string[];
}

export interface PersonOptions {
  fleet: FleetControl;
  /** What the bot's actions change for the fleet diag (AP off, powered-off nodes). */
  state: FleetState;
  /** Waits (tests shorten them). */
  sleep?(ms: number): Promise<void>;
  /** Before acting on a line, so a module's wait (taken right after its PLEASE line) is in place first. */
  reactMs?: number;
  /** A press's hold and the gap after it (T-NN's presses about a second apart). */
  pressMs?: number;
  gapMs?: number;
  /** T-OTA's "get ready" press: again after this when no later line named the node (its prompt waits 110 s twice). */
  readyRepeatMs?: number;
  /**
   * The resume offset a fleet node has stored (nvs:fr_ota's `off`, a multiple of 64 KB; 0 for none): T-OTA's unplug
   * waits for its first stride (see the cut handler). Absent, the unplug comes after the reaction delay only.
   */
  otaStored?(alias: string): number;
  log?(line: string): void;
}

/** One 64 KB stride: what the node stores its download offset at (fr_ota), and what T-OTA's resume must start past. */
export const OTA_STRIDE = 65_536;
/** How long the unplug waits at most for the node's first stride before cutting anyway (the verdict then says so). */
export const OTA_STRIDE_WAIT_MS = 10_000;

interface Handler {
  /** The module and line it answers, for a reader. */
  what: string;
  re: RegExp;
  /** Acts at once, without the reaction delay: the module's wait already counts from before its line (a cursor). */
  now?: boolean;
  /** `seq`: this PLEASE line's number (PersonBot.lastLineFor compares with it). */
  act(m: RegExpExecArray, bot: PersonBot, seq: number): Promise<string[]>;
}

const HANDLERS: Handler[] = [
  {
    what: 'T-NN stopped phase: press BOOT on <a> <n> times',
    re: /^press BOOT on (\S+) (\d+) times/,
    async act(m, bot) {
      const did: string[] = [];
      for (let i = 0; i < Number(m[2]); i++) {
        did.push(...(await bot.send(m[1], 'inject press')));
        await bot.wait(bot.pressMs);
        did.push(...(await bot.send(m[1], 'inject release')));
        await bot.wait(bot.gapMs);
      }
      return did;
    },
  },
  {
    what: "T-OTA cut: get ready to unplug <a>'s USB cable ... press its BOOT button once",
    re: /^get ready to unplug (\S+?)'s USB cable/,
    async act(m, bot, seq) {
      const alias = m[1];
      const did = await bot.send(alias, 'inject click');
      // Its prompt asks twice (110 s each), once: a click before its cursor was taken is not seen. Pressed again
      // only while no later PLEASE line named the node (the unplug request means the press was seen).
      await bot.wait(bot.readyRepeatMs);
      if (bot.lastLineFor(alias) === seq && !bot.stopped) {
        did.push(...(await bot.send(alias, 'inject click')));
      }
      return did;
    },
  },
  {
    what: 'T-OTA cut: unplug <a> now (a power cut: no BYE, the port detached)',
    re: /^unplug (\S+) now/,
    // After the reaction delay, as a person pulls a plug, and once the node has a 64 KB stride in flash. On a board
    // the hub's count (the DOWNLOADING event at 256 KB) runs about 100 KB ahead of the node, so a stride is there by
    // then; on loopback the hub has served nearly the whole image while the node holds ~20 KB, and a cut then
    // resumes at 0 (review gap T2-OTA-30). T-OTA waits for the offline from the DOWNLOADING event's cursor, and the
    // download (paced, 6 s for 600 KB at T2-OTA-30's http_kbps) goes on meanwhile.
    async act(m, bot) {
      const alias = m[1];
      const did: string[] = [];
      if (bot.otaStored) {
        const until = Date.now() + OTA_STRIDE_WAIT_MS;
        while (!bot.stopped && bot.otaStored(alias) < OTA_STRIDE && Date.now() < until) {
          await bot.wait(50);
        }
        const off = bot.otaStored(alias);
        did.push(off >= OTA_STRIDE ? `${alias} stored ${off} B` : `${alias} stored ${off} B (no stride in ${OTA_STRIDE_WAIT_MS} ms)`);
      }
      bot.state.off.add(alias);
      did.push(...(await bot.send(alias, 'power off')));
      return did;
    },
  },
  {
    what: 'T-OTA: plug <a> back in / keep <a> plugged in',
    re: /^(?:plug (\S+) back in|keep (\S+) plugged in)/,
    async act(m, bot) {
      const alias = m[1] ?? m[2];
      if (!bot.state.off.has(alias)) {
        return [`${alias} is on: nothing to do`];
      }
      const did = await bot.send(alias, 'power on');
      bot.state.off.delete(alias);
      return did;
    },
  },
  {
    what: 'T-FLOOD-B --router-off: power the home router off now',
    re: /^power the home router off now/i,
    async act(_m, bot) {
      bot.state.apOff = true;
      return bot.send('fleet', 'ap off');
    },
  },
  {
    what: 'T-FLOOD-B --router-off: power the home router back on now',
    re: /^power the home router back on now/i,
    async act(_m, bot) {
      const did = await bot.send('fleet', 'ap on');
      bot.state.apOff = false;
      return did;
    },
  },
  {
    what: 'T-INPUT human phase: Press BOOT on <a> once',
    re: /^Press BOOT on (\S+) once/i,
    async act(m, bot) {
      return bot.send(m[1], 'inject click');
    },
  },
];

/** The PLEASE text of a module's log line (`PLEASE: …`, possibly prefixed with the gate), or null. */
export function pleaseOf(line: string): string | null {
  const at = line.indexOf('PLEASE: ');
  return at < 0 ? null : line.slice(at + 'PLEASE: '.length).trim();
}

export class PersonBot {
  readonly actions: PersonAction[] = [];
  readonly fleet: FleetControl;
  readonly state: FleetState;
  readonly pressMs: number;
  readonly gapMs: number;
  readonly readyRepeatMs: number;
  readonly otaStored: ((alias: string) => number) | undefined;
  stopped = false;
  readonly #reactMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (line: string) => void;
  readonly #inflight = new Set<Promise<void>>();
  /** Aborted by stop(): every wait in flight ends at once (a 30 s "get ready" repeat must not hold up a cancel). */
  readonly #stop = new AbortController();
  /** Per alias, the number of the latest PLEASE line that named it (the ready handler's "no later line"). */
  readonly #named = new Map<string, number>();
  #seq = 0;

  constructor(o: PersonOptions) {
    this.fleet = o.fleet;
    this.state = o.state;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#reactMs = o.reactMs ?? 1500;
    this.pressMs = o.pressMs ?? 100;
    this.gapMs = o.gapMs ?? 900;
    this.readyRepeatMs = o.readyRepeatMs ?? 30_000;
    this.otaStored = o.otaStored;
    this.#log = o.log ?? (() => {});
  }

  /** Every line a module logs (ctx.log): the bot acts on the PLEASE ones, in the background. */
  hear(line: string): void {
    const please = pleaseOf(line);
    if (please === null || this.stopped) {
      return;
    }
    const seq = ++this.#seq;
    for (const word of please.split(/[\s',:]+/)) {
      if (/^sim-\d+$/.test(word)) {
        this.#named.set(word, seq);
      }
    }
    const h = HANDLERS.map((x) => ({ x, m: x.re.exec(please) })).find((y) => y.m);
    const action: PersonAction = { at: Date.now(), please, did: [] };
    this.actions.push(action);
    if (!h) {
      action.did.push('no handler: a person would be needed here');
      this.#log(`person: no handler for "${please}"`);
      return;
    }
    const p = (async () => {
      try {
        if (!h.x.now) {
          await this.wait(this.#reactMs);
        }
        action.did.push(...(await h.x.act(h.m!, this, seq)));
      } catch (e) {
        action.did.push(`failed: ${(e as Error).message}`);
        this.#log(`person: "${please}": ${(e as Error).message}`);
      }
    })();
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p));
  }

  /** One control line, recorded as `<target> <command>` (and its answer's ok). */
  async send(target: string, command: string): Promise<string[]> {
    if (this.stopped) {
      return [`${target} ${command}: not sent (stopped)`];
    }
    const answers = await this.fleet.command(target, command, 15_000);
    const bad = answers.filter((a) => a.ok === false);
    this.#log(`person: ${target} ${command}${bad.length ? ` (not ok: ${JSON.stringify(bad[0])})` : ''}`);
    return [`${target} ${command}${bad.length ? ' (not ok)' : ''}`];
  }

  /** Waits `ms`, or less: a stop ends every wait at once. */
  wait(ms: number): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    const stop = this.#stop.signal;
    return new Promise<void>((resolve) => {
      const done = () => {
        stop.removeEventListener('abort', done);
        resolve();
      };
      stop.addEventListener('abort', done, { once: true });
      this.#sleep(ms).then(done, done);
    });
  }

  /** The number of the latest PLEASE line that named `alias` (0: none). */
  lastLineFor(alias: string): number {
    return this.#named.get(alias) ?? 0;
  }

  /** Waits until nothing is in flight (the actions so far are done). */
  async idle(): Promise<void> {
    while (this.#inflight.size) {
      await Promise.allSettled([...this.#inflight]);
    }
  }

  /**
   * Stops acting (a run's end or cancel): every wait in flight ends now and what is in flight sends nothing more;
   * resolves once it settled (a control line already sent waits for its answer, which a fleet quit ends).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.#stop.abort();
    await Promise.allSettled([...this.#inflight]);
  }
}

/** The handlers, for the report (what the bot can stand in for). */
export const PERSON_HANDLES: readonly string[] = HANDLERS.map((h) => h.what);
