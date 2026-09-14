/**
 * When to draw other people.
 *
 * The confirmed world for remote players only moves when a tick arrives, and
 * ticks arrive late by a jittering amount. Drawing at the edge of what has
 * arrived freezes on every late tick; drawing a learned delay behind the
 * node's clock never does, because the segment being drawn has already
 * arrived. The player pays the delay as remote latency - a hundred
 * milliseconds on a good link, a quarter second on satellite - and gets
 * motion that never stalls, jumps or reverses.
 *
 * The delay is learned the way an adaptive input buffer learns its depth
 * (after librsc's AdaptiveInputBuffer): lateness relative to the clock's
 * lower envelope goes into a histogram with exponential forgetting, so the
 * link's recent shape is always what is being read and nothing has to be
 * sorted; the target is a quantile of it - the 98th while the link is
 * stable, the 99.5th while starvations have been happening - plus one tick to
 * bracket the segment. Higher than an input buffer would cover, because an
 * input underrun repeats the last input and nobody sees it, while every
 * uncovered tick here is a frame the player watches stand still. The target is smoothed, and a starvation - the one
 * visible failure - boosts it at once so it does not repeat. Bounded at both
 * ends.
 */
import type { Runtime } from './runtime.js';
import type { ServerClock } from './server-clock.js';

export interface PlayoutOptions {
  /** Delay floor in ticks. One tick is the least that can bracket a segment. */
  minTicks?: number;
  /** Delay ceiling in ticks. */
  maxTicks?: number;
  /** Histogram resolution, ticks per bucket. */
  bucketTicks?: number;
  /** Exponential forgetting per sample; 0.95 keeps roughly the last ~20 samples' weight, 0.99 ~100. */
  forget?: number;
  /** Lateness quantile covered when the link is stable / unstable. */
  quantileStable?: number;
  quantileUnstable?: number;
  /** Starvation rate over the recent window above which the link counts as unstable. */
  unstableRate?: number;
  /** Render samples in the stability window. */
  windowSamples?: number;
  /** EMA weight kept by the current target per update (0.85 = slow, 0.5 = fast). */
  smoothing?: number;
  /** Ticks added to the target at once on a starvation. */
  starveBoost?: number;
  /** Largest delay change per `now()` call, in ticks - the slew on the drawn delay. */
  slewTicks?: number;
}

export interface PlayoutTime {
  /** Whole tick of the segment start being drawn. */
  tick: number;
  /** Fraction between `tick` and `tick + 1`. */
  frac: number;
  /** True if the request had to be clamped to the newest confirmed tick. */
  starved: boolean;
}

export class Playout {
  private readonly minTicks: number;
  private readonly maxTicks: number;
  private readonly bucketTicks: number;
  private readonly forget: number;
  private readonly qStable: number;
  private readonly qUnstable: number;
  private readonly unstableRate: number;
  private readonly windowSamples: number;
  private readonly smoothing: number;
  private readonly starveBoost: number;
  private readonly slew: number;
  private readonly hist: Float64Array;
  private histMass = 0;
  private target: number;
  private delayTicks: number;
  private recentStarved: number[] = [];
  private renders = 0;
  /** Newest confirmed tick the renderer may draw up to. */
  private newest = -1;
  starvations = 0;
  stable = true;

  constructor(private readonly rt: Runtime, private readonly clock: ServerClock, opts: PlayoutOptions = {}) {
    this.minTicks = opts.minTicks ?? 1;
    this.maxTicks = opts.maxTicks ?? 12;
    this.bucketTicks = opts.bucketTicks ?? 0.25;
    this.forget = opts.forget ?? 0.98;
    this.qStable = opts.quantileStable ?? 0.98;
    this.qUnstable = opts.quantileUnstable ?? 0.995;
    this.unstableRate = opts.unstableRate ?? 0.02;
    this.windowSamples = opts.windowSamples ?? 120;
    this.smoothing = opts.smoothing ?? 0.85;
    this.starveBoost = opts.starveBoost ?? 0.5;
    this.slew = opts.slewTicks ?? 0.02;
    this.hist = new Float64Array(Math.ceil(this.maxTicks / this.bucketTicks) + 1);
    this.target = Math.max(this.minTicks, 2);
    this.delayTicks = this.target;
  }

  get delay(): number { return this.delayTicks; }
  get delayMs(): number { return this.delayTicks * this.clock.period; }
  get targetTicks(): number { return this.target; }

  /** A confirmed tick is now available to draw. */
  observe(tick: number, at: number = this.rt.now()): void {
    if (tick > this.newest) this.newest = tick;
    if (!this.clock.ready) return;
    const lateTicks = Math.max(0, this.clock.latenessOf(tick, at)) / this.clock.period;
    // Forget, then add: the histogram always sums to (nearly) one.
    for (let i = 0; i < this.hist.length; i++) this.hist[i] *= this.forget;
    this.histMass = this.histMass * this.forget + (1 - this.forget);
    const b = Math.min(this.hist.length - 1, Math.floor(lateTicks / this.bucketTicks));
    this.hist[b] += 1 - this.forget;
    this.updateTarget();
  }

  private quantile(q: number): number {
    let sum = 0;
    const want = q * this.histMass;
    for (let i = 0; i < this.hist.length; i++) {
      sum += this.hist[i];
      if (sum >= want) return (i + 1) * this.bucketTicks;
    }
    return this.maxTicks;
  }

  private updateTarget(): void {
    if (this.histMass < 0.3) return; // not enough seen yet
    const q = this.stable ? this.qStable : this.qUnstable;
    const want = Math.min(this.maxTicks, Math.max(this.minTicks, this.quantile(q) + 1));
    this.target = this.smoothing * this.target + (1 - this.smoothing) * want;
  }

  private lastAt = NaN;
  private lastTime: PlayoutTime = { tick: -1, frac: 0, starved: false };

  /**
   * The time to draw other players at, right now. One answer per instant:
   * every caller in a frame gets the same time, and the slew and the
   * stability window advance once per frame, not once per caller.
   */
  now(at: number = this.rt.now()): PlayoutTime {
    if (at === this.lastAt) return this.lastTime;
    this.lastAt = at;
    return (this.lastTime = this.advance(at));
  }

  private advance(at: number): PlayoutTime {
    if (!this.clock.ready || this.newest < 0) return { tick: this.newest, frac: 0, starved: false };
    // The drawn delay follows the target with a slew, so the picture never jumps.
    const d = this.target - this.delayTicks;
    this.delayTicks += Math.max(-this.slew, Math.min(this.slew, d));

    let t = this.clock.tickAt(at) - this.delayTicks;
    let starved = false;
    if (t > this.newest) {
      // We ran out of world: the one visible failure. Draw the newest and
      // push the target up at once so it does not happen again.
      t = this.newest; starved = true; this.starvations++;
      this.target = Math.min(this.maxTicks, this.target + this.starveBoost);
    }
    this.renders++;
    this.recentStarved.push(starved ? 1 : 0);
    if (this.recentStarved.length > this.windowSamples) this.recentStarved.shift();
    const rate = this.recentStarved.reduce((a, b) => a + b, 0) / this.recentStarved.length;
    this.stable = rate < this.unstableRate;
    const tick = Math.floor(t);
    return { tick, frac: t - tick, starved };
  }
}
