/**
 * Ticks worked through between frames, not inside one.
 *
 * Two things hand a client a pile of ticks at once: joining a room whose
 * snapshot is old (the live roof, 7 Sep 2026: 190,000 frames behind - one
 * loop froze the tab for two minutes, and the ticks that queued behind the
 * freeze were applied in piles for minutes more), and a tab that was
 * throttled or a script that blocked, after which every tick that landed
 * meanwhile arrives together. Applied in one go, either is a frozen picture
 * followed by a lurch.
 *
 * So a pile is a backlog: frames keyed by number, worked through a few
 * milliseconds at a time with the frame getting the rest, and ticks that
 * arrive meanwhile appended to it. A short backlog takes small slices so
 * the picture keeps moving at full rate; a long one is worth most of the
 * frame, since nobody can act until it is over; a hidden tab has no frame
 * to share and takes it in long slices, which is what lets a tab left open
 * behind other windows get live - and publish - instead of crawling. Along
 * a long replay the replayed world is published as the room's snapshot every
 * so often, so the next person in restores from where this one got to.
 *
 * Deep in a long replay ticks are `light`: not hashed, no status kept - no
 * verdict will ever name them and no renderer will draw them.
 */
import type { Runtime } from '../netcode/runtime.js';
import type { StreamInput } from './roster.js';
import type { World } from './world.js';

export interface CatchupOptions {
  /** Slice for a short backlog, ms. */
  sliceMs?: number;
  /** The slice grows with the backlog up to this, ms. */
  sliceMaxMs?: number;
  /** Slice in a hidden tab, which has no frame to share. */
  hiddenSliceMs?: number;
  /** Replayed frames between snapshots published along the way; 0 = none. */
  publishEvery?: number;
  /** Frames from the target still hashed and kept; older replayed ticks are light. */
  keepFrames?: number;
}

export interface CatchupHooks {
  /** A stride of the replay passed: publish the world as it stands at `frame`. */
  publish(frame: number): void;
  /** The backlog is worked through, at `frame`. `live` says it was a pile of live ticks, not a join. */
  done(frame: number, live: boolean): void;
}

export class Catchup<S, I> {
  private byFrame = new Map<number, StreamInput[]>();
  private next = 0;
  private target = -1;
  private from = 0;
  private scheduled = false;
  /** True for a pile of live ticks; false for a join's replay. */
  live = false;
  /** Frames replayed for joins, and for piles, over the life of the object. */
  replayed = 0;
  piled = 0;
  piles = 0;
  published = 0;
  private readonly sliceMs: number;
  private readonly sliceMaxMs: number;
  private readonly hiddenSliceMs: number;
  private readonly publishEvery: number;
  private readonly keepFrames: number;

  constructor(private readonly rt: Runtime, private readonly world: World<S, I>, private readonly hooks: CatchupHooks, opts: CatchupOptions = {}) {
    this.sliceMs = opts.sliceMs ?? 10;
    this.sliceMaxMs = opts.sliceMaxMs ?? 60;
    this.hiddenSliceMs = opts.hiddenSliceMs ?? 250;
    this.publishEvery = opts.publishEvery ?? 2000;
    this.keepFrames = opts.keepFrames ?? 600;
  }

  get active(): boolean { return this.target >= this.next; }
  get pending(): number { return this.active ? this.target - this.next + 1 : 0; }

  /** Begin: frames `from`..`to` from `history` (a join), or an empty pile that ticks will fill (live). */
  start(from: number, to: number, history: StreamInput[], live: boolean): void {
    this.byFrame.clear();
    for (const inp of history) {
      if (typeof inp.frame !== 'number' || inp.frame < from) continue;
      let arr = this.byFrame.get(inp.frame);
      if (!arr) this.byFrame.set(inp.frame, (arr = []));
      arr.push(inp);
    }
    this.from = from; this.next = from; this.target = to; this.live = live;
    if (live) this.piles++;
    this.schedule();
  }

  /** A tick arrived while the backlog stands: it goes on the end. */
  absorb(frame: number, inputs: StreamInput[]): void {
    if (frame <= this.target) return;
    if (inputs.length) this.byFrame.set(frame, inputs);
    this.target = frame;
  }

  private sliceBudget(): number {
    if (this.rt.hidden()) return this.hiddenSliceMs;
    const ms = this.sliceMs + this.pending / 100;
    return ms > this.sliceMaxMs ? this.sliceMaxMs : ms;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.rt.defer(() => { this.scheduled = false; this.slice(); });
  }

  private slice(): void {
    if (!this.active) {
      // Nothing to replay - the join landed on the snapshot's own frame -
      // but the world still has to be declared standing.
      if (this.target === this.next - 1) { const reached = this.target, live = this.live; this.target = -1; this.hooks.done(reached, live); }
      return;
    }
    const t0 = this.rt.now();
    const budget = this.sliceBudget();
    while (this.next <= this.target) {
      const f = this.next++;
      const stride = !this.live && this.publishEvery > 0 && f > this.from && (f - this.from) % this.publishEvery === 0;
      const light = !stride && f < this.target - this.keepFrames;
      this.world.tick(f, this.byFrame.get(f) ?? [], light);
      this.byFrame.delete(f);
      if (this.live) this.piled++; else this.replayed++;
      if (stride) { this.hooks.publish(f); this.published++; }
      if (this.rt.now() - t0 > budget) break;
    }
    if (this.active) { this.schedule(); return; }
    const reached = this.target;
    const live = this.live;
    this.target = -1;
    this.hooks.done(reached, live);
  }
}
