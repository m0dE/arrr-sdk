/**
 * Snapshots for late joiners.
 *
 * Until the authority produces them itself (the recommended node change),
 * one client in the room has to. The election is a pure function of the
 * roster the room agrees on - the lowest id among connected members - so
 * every client picks the same publisher without a message. The publisher
 * sends its confirmed world every `every` ticks with the seq and frame the
 * node needs to select catch-up history correctly; the SDK's bare
 * `sendSnapshot` writes seq 0 by default, which makes the node serve the
 * entire retained history to every joiner.
 */
export interface SnapshotsOptions {
  every: number;
  isConnected: (player: string) => boolean;
}

export class Snapshots {
  published = 0;
  constructor(private readonly opts: SnapshotsOptions) {}

  publisherOf(members: string[]): string | null {
    for (const m of members) if (this.opts.isConnected(m)) return m;
    return null;
  }

  /** True when this player should publish at this frame. */
  due(frame: number, me: string, members: string[]): boolean {
    if (this.opts.every <= 0 || frame % this.opts.every !== 0) return false;
    return this.publisherOf(members) === me;
  }
}
