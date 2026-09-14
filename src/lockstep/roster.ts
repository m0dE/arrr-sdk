/**
 * Who is in the room, and which connection is whose.
 *
 * An input is attributed to the connection it arrived on - the node stamps
 * that - and connections are mapped to players by the join/reconnect inputs
 * the node generates. Nothing in an input's own payload is ever trusted for
 * identity: a payload is a claim, the stamp is a fact. A client that cannot
 * map a connection to a player drops the input and diverges from everyone who
 * could, which is why every source of the mapping is used: the replicated
 * stream, the catch-up history, the snapshot's id map and the node's client
 * list.
 */
export interface StreamInput {
  seq?: number;
  frame?: number;
  clientId?: string;
  clientHash?: number;
  data?: any;
}

export type LifecycleKind = 'join' | 'reconnect' | 'leave' | 'disconnect';

export function lifecycleOf(input: StreamInput): { kind: LifecycleKind; player: string | null } | null {
  const d = input?.data;
  if (!d || typeof d !== 'object' || d instanceof Uint8Array) return null;
  const kind = d.type;
  if (kind !== 'join' && kind !== 'reconnect' && kind !== 'leave' && kind !== 'disconnect') return null;
  const player = (d.user && d.user.id != null) ? String(d.user.id) : (d.id != null ? String(d.id) : null);
  return { kind, player };
}

export class Roster {
  /** Members in the sim, sorted. Joins add, leaves remove; disconnects do not. */
  readonly members: string[] = [];
  private memberSet = new Set<string>();
  /** Players whose connection is currently open. */
  readonly present = new Set<string>();
  /** connection id -> player id */
  readonly owner = new Map<string, string>();
  stats = { attributed: 0, unmapped: 0, noSender: 0 };

  own(clientId: string | undefined, player: string): void {
    if (clientId) this.owner.set(String(clientId), player);
  }

  /** Apply a lifecycle input to membership. Returns what changed for the sim. */
  apply(input: StreamInput): { kind: LifecycleKind; player: string } | null {
    const lc = lifecycleOf(input);
    if (!lc || !lc.player) return null;
    const p = lc.player;
    switch (lc.kind) {
      case 'join':
      case 'reconnect':
        this.own(input.clientId, p);
        if (!this.memberSet.has(p)) { this.memberSet.add(p); this.members.push(p); this.members.sort(); }
        this.present.add(p);
        break;
      case 'leave':
        if (this.memberSet.has(p)) { this.memberSet.delete(p); this.members.splice(this.members.indexOf(p), 1); }
        this.present.delete(p);
        break;
      case 'disconnect':
        this.present.delete(p);
        break;
    }
    return { kind: lc.kind, player: p };
  }

  /** The player an input came from, or null if its connection is unknown. */
  senderOf(input: StreamInput): string | null {
    if (!input.clientId) { this.stats.noSender++; return null; }
    const p = this.owner.get(String(input.clientId));
    if (p) { this.stats.attributed++; return p; }
    this.stats.unmapped++;
    return null;
  }

  has(player: string): boolean { return this.memberSet.has(player); }

  /** Members as of a frame, from a history: everyone whose join is at or before it and not left since. */
  static membersAt(history: StreamInput[], frame: number): string[] {
    const r = new Roster();
    for (const inp of history) {
      if (typeof inp.frame !== 'number' || inp.frame > frame) continue;
      r.apply(inp);
    }
    return r.members.slice();
  }
}
