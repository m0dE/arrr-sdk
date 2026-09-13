/**
 * A ring of per-tick states for one drawable thing, and the pair to draw
 * between at a playout time. The game records whatever it wants to
 * interpolate (a snapshot of a player: position, yaw, flags) once per tick;
 * the renderer asks for `(tick, frac)` and gets the two recorded states that
 * bracket it. Requests before the oldest entry get the oldest; requests past
 * the newest get the newest - never extrapolated.
 */
export interface Bracket<T> {
  a: T;
  b: T;
  /** 0 at `a`, 1 at `b`. */
  t: number;
}

export class Interpolation<T> {
  private ticks: number[] = [];
  private states: T[] = [];

  constructor(readonly capacity = 16) {}

  get size(): number { return this.ticks.length; }
  get newestTick(): number { return this.ticks.length ? this.ticks[this.ticks.length - 1] : -1; }

  record(tick: number, state: T): void {
    // Out-of-order or duplicate ticks are ignored; the ring is a timeline.
    if (this.ticks.length && tick <= this.ticks[this.ticks.length - 1]) return;
    this.ticks.push(tick); this.states.push(state);
    while (this.ticks.length > this.capacity) { this.ticks.shift(); this.states.shift(); }
  }

  at(tick: number, frac: number): Bracket<T> | null {
    const n = this.ticks.length;
    if (n === 0) return null;
    if (tick >= this.ticks[n - 1]) return { a: this.states[n - 1], b: this.states[n - 1], t: 0 };
    if (tick < this.ticks[0]) return { a: this.states[0], b: this.states[0], t: 0 };
    // Find the entry at or before `tick` and the next one after it. Ticks
    // may have gaps (a burst can skip recording); interpolate across them.
    let i = n - 1;
    while (i > 0 && this.ticks[i] > tick) i--;
    const j = Math.min(n - 1, i + 1);
    const span = this.ticks[j] - this.ticks[i];
    const t = span > 0 ? Math.max(0, Math.min(1, (tick + frac - this.ticks[i]) / span)) : 0;
    return { a: this.states[i], b: this.states[j], t };
  }

  clear(): void { this.ticks = []; this.states = []; }
}
