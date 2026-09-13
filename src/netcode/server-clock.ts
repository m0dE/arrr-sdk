/**
 * Where the node's tick clock is, seen from this machine - from echoes.
 *
 * One mechanism. Zachary Booth Simpson's NetStorm method (as TrinityCore's
 * ComputeNewClockDelta and netlib's time-sync.ts): per echo of a message
 * the node handled at server tick `s`, sent at local `a` and confirmed at
 * local `b`, latency = (b - a) / 2 and delta = s - b + latency, in ticks.
 * A bounded window; samples whose latency exceeds the median plus one
 * standard deviation are transport spikes and discarded; the survivors are
 * averaged. The clock then FOLLOWS that average with a slew rather than
 * re-adopting it in steps: a renderer reads this clock every frame, and a
 * step of half a tick is drawn as a lurch. It snaps only when far off.
 *
 * Plus the one thing that method assumes and this node does not give: a
 * fixed rate. Nodes tick at 19.95 Hz idle and 15 Hz saturated, so a fixed
 * delta drifts and re-snaps, which a renderer would draw as a lurch. The
 * delta's drift over a longer window is fitted as a slope, and the clock
 * runs at that rate between echoes.
 *
 * Two offsets come out of it, because they are two physical quantities: the
 * node's own boundary for tick k (from echoes - what a sender needs to hit a
 * tick) and the earliest a tick k reaches this machine (from arrivals - what
 * a renderer needs). The second cannot be derived from the first: an echo
 * measures a round trip and cannot say how much of it was the way down. So
 * the arrival offset is the floor of (arrival - k * period) over a window,
 * on the same rate. One clock, one rate, two references.
 *
 * Not synced until the first echo. That is the truth, not a fault: a client
 * that has sent nothing has learned nothing about the node's clock, and a
 * game that idles sends its idle input.
 */
import type { Runtime } from './runtime.js';

export interface ServerClockOptions {
  /** Nominal ms per tick, from central's fps. */
  periodMs: number;
  /** Echoes in the offset window. */
  window?: number;
  /** Echoes in the rate window (must be larger than `window`). */
  rateWindow?: number;
  /** Largest correction per echo, in ticks. */
  slewTicks?: number;
  /** Snap instead of slew beyond this many ticks of error. */
  snapTicks?: number;
}

interface Echo { sentAt: number; serverTick: number; receivedAt: number; latency: number; delta: number }

export class ServerClock {
  readonly nominal: number;
  private readonly window: number;
  private readonly rateWindow: number;
  private readonly slew: number;
  private readonly snapAt: number;
  private echoes: Echo[] = [];
  private delta = NaN;          // server ticks - local ticks, at `deltaAt`
  private deltaAt = NaN;        // local ms the delta was adopted at
  private slope = 0;            // ticks of delta drift per local ms (negative = node slow)
  private latencyTicks = 0;
  echoCount = 0;
  rejected = 0;
  snaps = 0;
  newestTick = -1;
  newestAt = NaN;

  constructor(private readonly rt: Runtime, opts: ServerClockOptions) {
    this.nominal = opts.periodMs;
    this.window = opts.window ?? 8;
    this.rateWindow = opts.rateWindow ?? 200;
    this.slew = opts.slewTicks ?? 0.02;
    this.snapAt = opts.snapTicks ?? 2;
  }

  get ready(): boolean { return Number.isFinite(this.delta); }
  /** Ms per tick as the node is actually delivering them. */
  get period(): number { return this.nominal / (1 + this.slope * this.nominal); }
  /** One-way latency to the node, in ms. */
  get oneWayMs(): number { return this.latencyTicks * this.nominal; }
  get oneWayTicks(): number { return this.latencyTicks; }

  /** Recent tick arrivals, for the arrival reference. */
  private arrivals: { tick: number; at: number }[] = [];
  /** The arrival origin as followed: the floor is a target, this is what is read. */
  private origin = NaN;

  /**
   * A tick arrived. The rate comes from echoes; this learns the earliest a
   * tick reaches us at that rate - the floor over a window of arrivals - which
   * is the reference a renderer measures lateness against. A mean would drift
   * late under jitter, which only ever makes ticks later; a floor cannot.
   */
  observe(tick: number, at: number = this.rt.now()): void {
    if (tick > this.newestTick) { this.newestTick = tick; this.newestAt = at; }
    this.arrivals.push({ tick, at });
    if (this.arrivals.length > 40) this.arrivals.shift();
    // Follow the floor: forward at once (an earlier arrival is a fact), back
    // only slowly when the fastest sample ages out of the window - a step
    // back is drawn as a reversal by anyone reading this clock.
    let floor = Infinity;
    const p = this.period;
    for (const a of this.arrivals) floor = Math.min(floor, a.at - a.tick * p);
    if (!Number.isFinite(this.origin) || floor < this.origin - 2 * p || floor > this.origin + 2 * p) this.origin = floor;
    else if (floor < this.origin) this.origin = floor;
    else this.origin += Math.min(0.5, floor - this.origin);
  }

  /** Earliest-arrival offset: local ms at which tick 0 would arrive, at the current rate. */
  private arrivalOrigin(): number { return this.origin; }

  /**
   * An echo: a message sent at local `sentAt` that the node handled at
   * server time `serverTick` (fractional ticks), confirmed at `receivedAt`.
   */
  echo(sentAt: number, serverTick: number, receivedAt: number): void {
    const latency = (receivedAt - sentAt) / 2 / this.nominal;
    const delta = serverTick - receivedAt / this.nominal + latency;
    this.echoes.push({ sentAt, serverTick, receivedAt, latency, delta });
    if (this.echoes.length > this.rateWindow) this.echoes.shift();
    this.echoCount++;
    if (!this.ready) { this.delta = delta; this.deltaAt = receivedAt; this.latencyTicks = latency; return; }

    // Offset and latency: the short window, spikes out.
    const recent = this.echoes.slice(-this.window);
    const lat = recent.map((e) => e.latency).sort((a, b) => a - b);
    const median = lat[lat.length >> 1];
    const mean = lat.reduce((a, b) => a + b, 0) / lat.length;
    const sd = Math.sqrt(lat.reduce((a, l) => a + (l - mean) ** 2, 0) / lat.length);
    const kept = recent.filter((e) => e.latency <= median + sd);   // `<=`: a steady link has sd 0
    this.rejected += recent.length - kept.length;
    if (kept.length) {
      const d = kept.reduce((a, e) => a + e.delta, 0) / kept.length;
      const t = kept.reduce((a, e) => a + e.receivedAt, 0) / kept.length;
      this.latencyTicks = kept.reduce((a, e) => a + e.latency, 0) / kept.length;
      // Follow the filtered delta from where our running clock says it is now.
      const running = this.delta + this.slope * (t - this.deltaAt);
      const err = d - running;
      if (Math.abs(err) > this.snapAt) { this.delta = d; this.deltaAt = t; this.snaps++; }
      else { this.delta = running + Math.max(-this.slew, Math.min(this.slew, err)); this.deltaAt = t; }
    }

    // Rate: a least-squares slope of delta over local time across the long
    // window, with the same spike filter. Needs a baseline to mean anything.
    if (this.echoes.length >= 40) {
      const all = this.echoes;
      const latAll = all.map((e) => e.latency).sort((a, b) => a - b);
      const med = latAll[latAll.length >> 1];
      const mn = latAll.reduce((a, b) => a + b, 0) / latAll.length;
      const s2 = Math.sqrt(latAll.reduce((a, l) => a + (l - mn) ** 2, 0) / latAll.length);
      const pts = all.filter((e) => e.latency <= med + s2);
      if (pts.length >= 20) {
        const tm = pts.reduce((a, e) => a + e.receivedAt, 0) / pts.length;
        const dm = pts.reduce((a, e) => a + e.delta, 0) / pts.length;
        let num = 0, den = 0;
        for (const e of pts) { num += (e.receivedAt - tm) * (e.delta - dm); den += (e.receivedAt - tm) ** 2; }
        if (den > 0) {
          // Re-anchor at the fit's centre so changing the slope moves nothing now.
          const now = this.rt.now();
          const current = this.delta + this.slope * (now - this.deltaAt);
          this.slope = Math.max(-0.5 / this.nominal, Math.min(0.1 / this.nominal, num / den));
          this.delta = current; this.deltaAt = now;
        }
      }
    }
  }

  /** The node's own tick counter at local ms `at`, fractional. NaN until synced. */
  serverTickAt(at: number = this.rt.now()): number {
    if (!this.ready) return NaN;
    return at / this.nominal + this.delta + this.slope * (at - this.deltaAt);
  }

  /** Local ms at which the node begins tick `k`. */
  serverBoundaryAt(k: number): number {
    // Invert serverTickAt: k = t/nominal + delta + slope*(t - deltaAt)
    const a = 1 / this.nominal + this.slope;
    return (k - this.delta + this.slope * this.deltaAt) / a;
  }

  /** The tick clock as it arrives here at the fastest: tick k lands when this passes k. What a renderer follows. */
  tickAt(at: number = this.rt.now()): number { return this.ready ? (at - this.arrivalOrigin()) / this.period : NaN; }

  /** Local ms at which tick `k` arrives here at the fastest. */
  dueAt(k: number): number { return this.arrivalOrigin() + k * this.period; }

  /** How late an arrival was against expectation, ms. */
  latenessOf(tick: number, at: number): number { return this.ready ? at - this.dueAt(tick) : 0; }
}
