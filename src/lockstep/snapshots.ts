/**
 * Snapshots for late joiners.
 *
 * Until the authority produces them itself (the recommended node change),
 * one client in the room has to. The election is a pure function of the
 * in-stream roster - the lowest id among connected members, as the stream
 * says at that frame - so every client picks the same publisher at the same
 * tick without a message. The node's out-of-band client list is deliberately
 * not used: it is not frame-consistent, so two clients reading it would
 * elect differently for a moment.
 *
 * Two things the live roof taught (7 Sep 2026): the elected publisher can be
 * a tab that is throttled or stuck catching up, and then the room's snapshot
 * goes stale for everyone - so when the node's snapshot is older than a few
 * periods, the members take turns; and a world that has not changed need
 * not be sent again - but must be sent eventually, in case the node lost it.
 *
 * The publisher sends its confirmed world with the seq and frame the node
 * needs to select catch-up history correctly; the SDK's bare `sendSnapshot`
 * writes seq 0 by default, which makes the node serve the entire retained
 * history to every joiner.
 */
export interface SnapshotsOptions {
  every: number;
  isConnected: (player: string) => boolean;
  /** Periods of `every` the node's snapshot may lag before the members take turns. */
  stalePeriods?: number;
  /** Identical worlds skipped before one is sent anyway. */
  republishAfterSkips?: number;
}

export class Snapshots {
  published = 0;
  skipped = 0;
  asStandIn = 0;
  /** The frame of the snapshot the node holds, as the last tick said. */
  nodeFrame = -1;
  private lastHash: number | null = null;
  private skippedAtLast = 0;
  private readonly stalePeriods: number;
  private readonly republishAfter: number;

  constructor(private readonly opts: SnapshotsOptions) {
    this.stalePeriods = opts.stalePeriods ?? 5;
    this.republishAfter = opts.republishAfterSkips ?? 60;
  }

  publisherOf(frame: number, members: string[]): string | null {
    const connected = members.filter((m) => this.opts.isConnected(m));
    if (!connected.length) return null;
    const stale = this.nodeFrame >= 0 && frame - this.nodeFrame > this.opts.every * this.stalePeriods;
    return stale ? connected[Math.floor(frame / this.opts.every) % connected.length] : connected[0];
  }

  /** True when this player should publish at this frame. */
  due(frame: number, me: string, members: string[]): boolean {
    if (this.opts.every <= 0 || frame % this.opts.every !== 0) return false;
    const p = this.publisherOf(frame, members);
    if (p !== me) return false;
    if (p !== members.filter((m) => this.opts.isConnected(m))[0]) this.asStandIn++;
    return true;
  }

  /** True if a world with this hash is worth sending: it changed, or it has been skipped long enough. */
  worthSending(hash: number): boolean {
    if (this.lastHash !== null && hash === this.lastHash && this.skipped - this.skippedAtLast < this.republishAfter) { this.skipped++; return false; }
    return true;
  }

  sent(hash: number): void { this.lastHash = hash; this.skippedAtLast = this.skipped; this.published++; }
}
