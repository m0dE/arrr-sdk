/**
 * Time and scheduling, injected.
 *
 * Nothing in the lockstep layer reads a clock or sets a timer directly: it
 * asks the runtime. That is what lets every clock in here run under a fake
 * clock in a test, where jitter, bursts and stalls are scripted rather than
 * hoped for.
 */
export interface Runtime {
  /** Milliseconds, monotonic. */
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function browserRuntime(): Runtime {
  const perf = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
  return {
    now: perf,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/**
 * A runtime whose clock only moves when told. Timers fire in order as time is
 * advanced, so a test can say "80 ms pass" and see exactly which beats ran.
 */
export class FakeRuntime implements Runtime {
  private t = 0;
  private timers: { at: number; every: number; fn: () => void; id: number; dead: boolean }[] = [];
  private nextId = 1;

  now(): number { return this.t; }

  setInterval(fn: () => void, ms: number): unknown {
    const timer = { at: this.t + ms, every: ms, fn, id: this.nextId++, dead: false };
    this.timers.push(timer);
    return timer.id;
  }
  clearInterval(handle: unknown): void { this.cancel(handle); }
  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { at: this.t + ms, every: 0, fn, id: this.nextId++, dead: false };
    this.timers.push(timer);
    return timer.id;
  }
  clearTimeout(handle: unknown): void { this.cancel(handle); }
  private cancel(handle: unknown) {
    for (const t of this.timers) if (t.id === handle) t.dead = true;
  }

  /** Advance the clock, firing timers in time order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: typeof this.timers[number] | null = null;
      for (const t of this.timers) if (!t.dead && t.at <= end && (!next || t.at < next.at)) next = t;
      if (!next) break;
      this.t = next.at;
      if (next.every > 0) next.at += next.every; else next.dead = true;
      next.fn();
    }
    this.t = end;
    this.timers = this.timers.filter((t) => !t.dead);
  }
}
