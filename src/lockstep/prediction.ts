/**
 * The local player, ahead of the room.
 *
 * Two things a player must never wait for: their own input showing up, and
 * their own avatar moving at a steady rate. Lockstep gives neither by
 * itself - an input is confirmed a round trip later, and the confirmed world
 * only moves when a tick arrives. So the local player lives in a predicted
 * copy of the world that is stepped by a local clock: one tick per period of
 * wall time, with whatever input is held, sent on the same beat. Confirmed
 * ticks never pace it; they only check it. When the confirmed world says the
 * local player is somewhere other than predicted, the copy is rebuilt from
 * the confirmed world and the unconfirmed inputs are replayed on top.
 *
 * Where an input lands: today's node sequences an input into the next tick
 * after it arrives, and node timers only ever fire late, so an input that
 * reaches the node near a tick boundary lands on one side or the other by a
 * few milliseconds of timer noise nobody can predict. A beat on a free-
 * running wall clock drifts through that band and dwells in it for seconds.
 * So the beat is phase-locked to the server clock instead: it fires when an
 * input sent now will reach the node in the middle of a tick - half a period
 * of margin on both sides - and that tick is the input's target frame, exact
 * by construction. The lock follows the clock's smoothed due times, not the
 * arrivals, so tick jitter never enters the local cadence. Inputs carry the
 * target frame on the wire, for a node that honours it.
 */
import type { Runtime } from '../netcode/runtime.js';
import type { Sim, SimContext } from './sim.js';
import type { World } from './world.js';

export interface PredictionOptions<I> {
  /** The input to send and apply on this beat, or null for none this tick. */
  inputSource: () => I | null;
  /** Put an input on the wire. */
  send: (data: I, targetFrame: number) => void;
  /** Most inputs kept unconfirmed before the oldest is dropped. */
  maxPending?: number;
  /** Called after every predicted step - where a renderer records the local player. */
  onStep?: (state: unknown, frame: number) => void;
  /** The server clock: when the node begins frame `k`, the one-way trip, and the period. */
  clock?: { serverBoundaryAt: (frame: number) => number; oneWayMs: number; period: number; ready: boolean };
  /**
   * Rate dilation for the beat, as a multiplier on the period (1 = the node's
   * rate). For a node that buffers inputs per target frame and reports its
   * buffer depth, this is where "tick a little faster / slower" plugs in;
   * with today's node the phase lock places inputs and this stays 1.
   */
  dilation?: () => number;
}

interface Pending<I> { frame: number; data: I; sentAt: number; phi?: number; base?: number }

export class Prediction<S = unknown, I = unknown> {
  state: S | null = null;
  /** The frame the predicted world stands at. */
  frame = -1;
  private pending: Pending<I>[] = [];
  private fingerprints = new Map<number, string>();
  private timer: unknown = null;
  private beatPeriod: number;
  private lastBeatAt = NaN;
  /** When the newest confirmed tick arrived, and its frame. */
  private lastTickAt = NaN;
  private rttMs = 0;
  private lastPhi = 0;
  /** Diagnostics: the first inputs' (phi, rtt estimate, base frame, predicted offset, actual offset). */
  readonly landingSamples: number[][] = [];
  leadTarget = 1;
  rollbacks = 0;
  mispredictions = 0;
  replayed = 0;
  beats = 0;
  roundTrips: number[] = [];
  /** landed frame - predicted frame, per confirmed own input: 0 is a perfect lead. Keyed by error, counts. */
  readonly landing = new Map<number, number>();
  private readonly maxPending: number;

  constructor(
    private readonly rt: Runtime,
    private readonly sim: Sim<S, I>,
    private readonly world: World<S, I>,
    private readonly opts: PredictionOptions<I>,
    initialPeriodMs: number,
  ) {
    this.beatPeriod = initialPeriodMs;
    this.maxPending = opts.maxPending ?? 20;
  }

  get running(): boolean { return this.timer !== null; }

  /** Where a renderer records the local player, once per predicted tick. */
  setOnStep(fn: ((state: unknown, frame: number) => void) | null): void { this.opts.onStep = fn ?? undefined; }
  get pendingCount(): number { return this.pending.length; }
  get period(): number { return this.beatPeriod; }

  /** How far through the current beat we are, for drawing the local player. */
  frac(at: number = this.rt.now()): number {
    if (!Number.isFinite(this.lastBeatAt)) return 0;
    return Math.max(0, Math.min(1, (at - this.lastBeatAt) / this.beatPeriod));
  }

  start(): void {
    if (this.timer !== null) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) { this.rt.clearTimeout(this.timer); this.timer = null; }
  }

  /**
   * Beat frame k fires so that its input, one trip later, reaches the node
   * halfway through tick k-1 - and is therefore sequenced into k with half a
   * period of margin on either side.
   */
  private beatAt(k: number): number {
    const c = this.opts.clock!;
    return c.serverBoundaryAt(k - 1) + c.period / 2 - c.oneWayMs;
  }

  /** The frame whose beat is next due under the lock: the first k with beatAt(k) > now. */
  private lockedNext(now: number): number {
    const c = this.opts.clock!;
    let k = Math.max(this.frame + 1, this.world.frame + 1);
    for (let i = 0; i < 64 && this.beatAt(k) <= now - c.period / 2; i++) k++;
    return k;
  }

  private schedule(): void {
    const now = this.rt.now();
    const dil = Math.max(0.9, Math.min(1.1, this.opts.dilation?.() ?? 1));
    let wait = this.beatPeriod * dil;
    const c = this.opts.clock;
    if (c && c.ready && this.state !== null) {
      // Lock to the clock: the next beat is the first anchor after now.
      const k = this.lockedNext(now);
      this.nextBeatFrame = k;
      wait = Math.max(0, this.beatAt(k) - now);
    } else {
      this.nextBeatFrame = -1;
    }
    this.timer = this.rt.setTimeout(() => { this.timer = null; this.beat(); this.schedule(); }, wait);
  }
  private nextBeatFrame = -1;

  /** One local tick: send this beat's input, apply it, step. */
  beat(at: number = this.rt.now()): void {
    this.lastBeatAt = at;
    if (this.world.state === null) return;
    if (this.state === null) this.rebuild();
    if (this.state === null) return;
    this.beats++;
    // The beat for frame k applies this beat's input at k. Locked to the
    // clock, k is the frame the input will land in; unlocked (no clock yet),
    // it is simply the next predicted frame.
    const target = this.nextBeatFrame > this.frame ? this.nextBeatFrame : this.frame + 1;
    const data = this.opts.inputSource();
    while (this.frame + 1 < target) this.advance(this.frame + 1);
    if (data !== null && data !== undefined) {
      this.pending.push({ frame: target, data, sentAt: at, phi: this.lastPhi, base: this.world.frame });
      while (this.pending.length > this.maxPending) this.pending.shift();
      this.opts.send(data, target);
      this.applyOnly(data);
    }
    this.advance(target);
  }

  /** The frame an input sent on the next beat lands in. */
  targetFrame(): number { return this.nextBeatFrame > this.frame ? this.nextBeatFrame : this.frame + 1; }

  /**
   * Timers stop when a tab is hidden, but ticks keep arriving. A beat that is
   * more than a couple of periods overdue is taken now, from the tick, so
   * the player keeps sending and the node keeps hearing from them.
   */
  beatIfStalled(at: number = this.rt.now()): void {
    if (this.timer === null || !Number.isFinite(this.lastBeatAt)) return;
    if (at - this.lastBeatAt > 3 * this.beatPeriod) { this.nextBeatFrame = -1; this.beat(at); }
  }

  private ctx(frame: number): SimContext { return this.world.ctx(frame); }

  private applyOnly(data: I): void {
    try { this.sim.applyInput(this.state!, data, this.ctx(this.frame + 1), this.world.opts.player); } catch { /* best effort */ }
  }

  private advance(frame: number): void {
    const c = this.ctx(frame);
    try {
      this.sim.step(this.state!, c);
      if (this.sim.substep) for (let i = 0; i < (this.sim.substeps || 1); i++) this.sim.substep(this.state!, c);
    } catch { /* prediction is best effort */ }
    this.frame = frame;
    const fp = this.fingerprint(this.state!);
    if (fp !== null) { this.fingerprints.set(frame, fp); for (const k of this.fingerprints.keys()) { if (k < frame - 64) this.fingerprints.delete(k); else break; } }
    this.opts.onStep?.(this.state, frame);
  }

  private fingerprint(s: S): string | null {
    if (!this.sim.status) return null;
    let st: ReturnType<NonNullable<Sim<S, I>['status']>>;
    try { st = this.sim.status(s); } catch { return null; }
    const players: any = st?.players;
    if (!players) return null;
    // `players` may be an array of {id,...} or a map keyed by id.
    const p = Array.isArray(players) ? players.find((q) => q.id === this.world.opts.player) : players[this.world.opts.player];
    if (!p) return null;
    return [p.x, p.y, p.z, p.vx, p.vy, p.vz].join(',');
  }

  /** Rebuild the predicted world from the confirmed one and replay what is unconfirmed. */
  rebuild(): void {
    if (this.world.state === null) { this.state = null; return; }
    try { this.state = this.sim.deserialize(this.sim.serialize(this.world.state)); }
    catch { this.state = null; this.frame = -1; return; }
    this.frame = this.world.frame;
    this.rollbacks++;
    this.fingerprints.clear();
    // Replay unconfirmed inputs at the frames they were stamped for. A target
    // the confirmed world has already passed is one the node has too; it will
    // land in the next tick, so it is re-stamped there.
    for (const p of this.pending) {
      if (p.frame <= this.world.frame) p.frame = this.world.frame + 1;
      while (this.frame + 1 < p.frame) this.advance(this.frame + 1);
      this.applyOnly(p.data);
      if (this.frame < p.frame) this.advance(p.frame);
      this.replayed++;
    }
    // And stand where the lock stands, so the next beat is the next frame
    // rather than a burst of catch-up beats the player would see as a lurch.
    const c = this.opts.clock;
    const standAt = c && c.ready ? this.lockedNext(this.rt.now()) - 1 : this.world.frame + this.leadTarget;
    while (this.frame < standAt) this.advance(this.frame + 1);
  }

  /**
   * A confirmed tick landed. Retire the inputs it confirmed, learn the lead,
   * check the local player against what was predicted for that frame, and
   * rebuild if they disagree or if the prediction has fallen behind.
   */
  reconcile(frame: number, ownInputsConfirmed: number, at: number = this.rt.now()): void {
    this.lastTickAt = at;
    for (let i = 0; i < ownInputsConfirmed && this.pending.length; i++) {
      const p = this.pending.shift()!;
      const err = frame - p.frame;
      this.landing.set(err, (this.landing.get(err) || 0) + 1);
      if (this.landingSamples.length < 3000) this.landingSamples.push([Math.round(p.phi ?? -1), Math.round(this.rttMs), p.base ?? -1, p.frame - (p.base ?? 0), frame - (p.base ?? 0)]);
      this.roundTrips.push(at - p.sentAt);
      if (this.roundTrips.length > 100) this.roundTrips.shift();
    }
    // The lead is the round trip in ticks (median), measured - never inferred
    // from how many inputs are in flight, which is a consequence of the lead.
    if (this.roundTrips.length >= 10) {
      // A loop time (sent -> seen in a tick) includes waiting for the tick to
      // fire, up to a whole period; the network's own round trip is the loop's
      // floor - an input that arrived just before a tick went out.
      const s = [...this.roundTrips].sort((a, b) => a - b);
      this.rttMs = s[Math.floor(0.1 * s.length)];
      // With the beat locked mid-tick the landing offset is set by the one-way
      // trip; this is only reported, the lock decides the frame.
      this.leadTarget = Math.max(1, Math.min(this.maxPending, 1 + Math.floor((this.opts.clock?.oneWayMs ?? this.rttMs / 2) / this.world.periodHint)));
    }
    this.beatPeriod = this.world.periodHint;
    if (this.world.state === null) { this.state = null; return; }
    const c = this.opts.clock;
    const standAt = c && c.ready ? this.lockedNext(at) - 1 : frame + this.leadTarget;
    if (this.state === null || this.frame < frame || this.frame > standAt + 8) {
      // Behind the confirmed world, or far ahead of where the lock stands (a
      // stall on either side): rebuild at the confirmed frame and replay what
      // is unconfirmed.
      this.rebuild(); return;
    }
    const expected = this.fingerprints.get(frame);
    if (expected !== undefined) {
      const actual = this.fingerprint(this.world.state);
      if (actual !== null && actual !== expected) { this.mispredictions++; this.rebuild(); }
    }
  }
}
