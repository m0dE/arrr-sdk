/**
 * The confirmed simulation: the world the room agrees on.
 *
 * It starts in one of two ways - seeded from the roster at an agreed frame,
 * or restored from a snapshot - and then advances exactly one tick per tick
 * the node broadcasts, applying that tick's inputs in the node's order. A
 * duplicate or out-of-order tick is refused here, once, rather than by every
 * caller. A gap is refused too: stepping once across several missing ticks
 * would produce a world nobody else has, so the world stops at its last
 * good frame and reports the hole, which only a resync can fill.
 */
import { Roster, lifecycleOf, type StreamInput } from './roster.js';
import { makeRng, hashString, type Sim, type SimContext } from './sim.js';

export interface WorldOptions {
  player: string;
  room: string;
  /** Hashes and statuses kept, in frames. */
  historyFrames?: number;
  /**
   * Hash the world every N ticks, not every tick. Hashing a room of a
   * hundred is a tick's worth of work by itself; a verdict every half second
   * catches a divergence as surely as one every tick, half a second later.
   */
  hashEvery?: number;
}

export class World<S = unknown, I = unknown> {
  state: S | null = null;
  frame = -1;
  readonly roster = new Roster();
  readonly hashes = new Map<number, number>();
  readonly statuses = new Map<number, unknown>();
  private readonly keep: number;
  private readonly seed: number;
  readonly hashEvery: number;
  duplicateTicks = 0;
  gaps: { from: number; to: number }[] = [];
  ticks = 0;
  inputsApplied = 0;
  lastSeq = -1;
  duplicateSeqs = 0;
  backwardSeqs = 0;
  /** Where this world began: the frame and how. */
  origin: { frame: number; via: 'seed' | 'snapshot' } | null = null;
  /** True while a gap stands between this world and the stream: nothing advances until a resync. */
  get holed(): boolean { const g = this.gaps[this.gaps.length - 1]; return !!g && g.from === this.frame; }
  /** Called after every tick with the new state - where a renderer records what it will interpolate. */
  onTick: ((state: S, frame: number) => void) | null = null;
  /** Ms per tick as currently learned from the node; the prediction beat is paced from it. */
  periodHint = 50;

  constructor(readonly sim: Sim<S, I>, readonly opts: WorldOptions) {
    this.keep = opts.historyFrames ?? 600;
    this.hashEvery = Math.max(1, opts.hashEvery ?? 1);
    this.seed = hashString(opts.room);
  }

  ctx(frame = this.frame): SimContext {
    return {
      frame,
      player: this.opts.player,
      roster: this.roster.members,
      rng: makeRng((this.seed + Math.imul(frame, 2654435761)) >>> 0),
    };
  }

  /** Learn ownership from history without applying it: joins at or before `frame`. */
  learnOwners(history: StreamInput[]): void {
    for (const inp of history) {
      const lc = lifecycleOf(inp);
      if (lc && lc.player && (lc.kind === 'join' || lc.kind === 'reconnect')) this.roster.own(inp.clientId, lc.player);
    }
  }

  /**
   * Begin at `startAt` from the roster the history implies there - possibly
   * nobody, when our own join is still in flight and will arrive in the first
   * tick. The history after it is the caller's to replay (see Catchup).
   */
  seedAt(startAt: number, history: StreamInput[]): boolean {
    const members = Roster.membersAt(history, startAt);
    this.learnOwners(history);
    for (const inp of history) if (typeof inp.frame === 'number' && inp.frame <= startAt) this.roster.apply(inp);
    this.state = this.sim.init({ roster: members, frame: startAt, seed: this.seed });
    this.frame = startAt;
    this.origin = { frame: startAt, via: 'seed' };
    return true;
  }

  /** Restore from a snapshot taken at `snapshotFrame`; the history after it is the caller's to replay. */
  restore(snapshot: unknown, snapshotFrame: number, history: StreamInput[]): boolean {
    let s: S;
    try { s = this.sim.deserialize(snapshot); } catch { return false; }
    this.state = s;
    this.frame = snapshotFrame;
    this.origin = { frame: snapshotFrame, via: 'snapshot' };
    this.learnOwners(history);
    // Membership as of the snapshot: joins at or before it are in it.
    for (const inp of history) if (typeof inp.frame === 'number' && inp.frame <= snapshotFrame) this.roster.apply(inp);
    return true;
  }

  /** The hash of the current state, computed now if this frame was not hashed. */
  hashNow(): number {
    if (this.state === null) return 0;
    let h = this.hashes.get(this.frame);
    if (h === undefined) { h = this.sim.hash(this.state) >>> 0; this.hashes.set(this.frame, h); }
    return h;
  }

  /**
   * Advance one tick. Returns the hash, `undefined` for a tick that was not
   * hashed (between hash frames, or a `light` tick deep in a catch-up that
   * nobody will ever ask about), or null if the tick was refused.
   */
  tick(frame: number, inputs: StreamInput[], light = false): number | null | undefined {
    if (this.state === null) return null;
    if (frame <= this.frame) { this.duplicateTicks++; return null; }
    if (frame > this.frame + 1 && this.frame >= 0) {
      const last = this.gaps[this.gaps.length - 1];
      if (!last || last.from !== this.frame) this.gaps.push({ from: this.frame, to: frame });
      else last.to = frame;
      return null;
    }
    const c = this.ctx(frame);
    for (const input of inputs) {
      if (typeof input.seq === 'number') {
        if (input.seq === this.lastSeq) this.duplicateSeqs++;
        else if (input.seq < this.lastSeq) this.backwardSeqs++;
        this.lastSeq = input.seq;
      }
      const lc = this.roster.apply(input);
      if (lc) {
        if ((lc.kind === 'join' || lc.kind === 'reconnect') && this.sim.addPlayer) this.sim.addPlayer(this.state, lc.player, c);
        else if (lc.kind === 'leave' && this.sim.removePlayer) this.sim.removePlayer(this.state, lc.player, c);
        continue;
      }
      if (input.data === undefined || input.data === null) continue;
      if (lifecycleOf(input)) continue;
      const sender = this.roster.senderOf(input);
      this.sim.applyInput(this.state, input.data as I, c, sender);
      this.inputsApplied++;
    }
    this.sim.step(this.state, c);
    if (this.sim.substep) for (let i = 0; i < (this.sim.substeps || 1); i++) this.sim.substep(this.state, c);
    this.frame = frame;
    this.ticks++;
    if (light) return undefined;
    let h: number | undefined;
    if (frame % this.hashEvery === 0) { h = this.sim.hash(this.state) >>> 0; this.hashes.set(frame, h); }
    if (this.sim.status) { try { this.statuses.set(frame, this.sim.status(this.state)); } catch { /* diagnostics only */ } }
    for (const k of this.hashes.keys()) { if (k < frame - this.keep) { this.hashes.delete(k); this.statuses.delete(k); } else break; }
    for (const k of this.statuses.keys()) { if (k < frame - 60) this.statuses.delete(k); else break; }
    this.onTick?.(this.state, frame);
    return h;
  }

  hashAt(frame: number): number | undefined { return this.hashes.get(frame); }
}
