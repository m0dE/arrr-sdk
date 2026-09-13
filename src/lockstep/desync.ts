/**
 * Does this client's world agree with the room's?
 *
 * The node broadcasts, with each tick, the hash most clients reported for an
 * earlier frame - today the frame before, which is why the verdict is empty
 * for any client more than one tick of round trip away. Whatever frame the
 * verdict names, it is compared against the hash this client recorded for
 * that frame, so the check works for a verdict that arrives one tick later or
 * one second later. A disagreement is reported; a sustained one asks the
 * node for a resync, with a backoff so a client that cannot be repaired does
 * not ask twenty times a second.
 */
import type { Runtime } from '../netcode/runtime.js';

export interface DesyncEvent { frame: number; mine: number; majority: number }

export interface DesyncOptions {
  /** Consecutive disagreements before asking for a resync. */
  disagreeThreshold?: number;
  /** Minimum ms between resync requests. */
  resyncBackoffMs?: number;
  onDesync?: (e: DesyncEvent) => void;
  requestResync?: () => void;
}

export class Desync {
  readonly events: DesyncEvent[] = [];
  verdicts = 0;
  agreed = 0;
  disagreed = 0;
  resyncsRequested = 0;
  private streak = 0;
  private lastResyncAt = -Infinity;
  private readonly threshold: number;
  private readonly backoff: number;

  constructor(private readonly rt: Runtime, private readonly opts: DesyncOptions = {}) {
    this.threshold = opts.disagreeThreshold ?? 3;
    this.backoff = opts.resyncBackoffMs ?? 5000;
  }

  /** A verdict for `frame` arrived; `mine` is our hash for it, if we have one. */
  verdict(frame: number, majority: number, mine: number | undefined): void {
    if (!majority) return;                     // 0 = the node has no verdict
    if (mine === undefined) return;            // before we had that frame
    this.verdicts++;
    if ((mine >>> 0) === (majority >>> 0)) { this.agreed++; this.streak = 0; return; }
    this.disagreed++;
    this.streak++;
    const e = { frame, mine: mine >>> 0, majority: majority >>> 0 };
    this.events.push(e);
    if (this.events.length > 50) this.events.shift();
    this.opts.onDesync?.(e);
    const now = this.rt.now();
    if (this.streak >= this.threshold && now - this.lastResyncAt >= this.backoff && this.opts.requestResync) {
      this.lastResyncAt = now;
      this.resyncsRequested++;
      this.streak = 0;
      this.opts.requestResync();
    }
  }

  /** The stream skipped ticks: the world cannot continue without a resync. */
  hole(): void {
    const now = this.rt.now();
    if (now - this.lastResyncAt < this.backoff || !this.opts.requestResync) return;
    this.lastResyncAt = now;
    this.resyncsRequested++;
    this.opts.requestResync();
  }

  /** After a resync, a fresh start. */
  reset(): void { this.streak = 0; }
}
