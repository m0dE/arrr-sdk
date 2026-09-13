/**
 * The contract a game implements. Everything else in this layer is generic.
 *
 * Determinism rules for the implementation: integer or fixed-point math only,
 * no Math.random (use `ctx.rng`), no Date, no floating-point accumulation, no
 * iteration over unordered maps. Two clients given the same inputs must
 * produce the same `hash` at every tick; that is the whole premise.
 */
export interface SimContext {
  /** The tick being simulated. */
  frame: number;
  /** This client's player id. */
  player: string;
  /** Every player currently in the room, sorted. */
  roster: string[];
  /** Deterministic per (player, frame). */
  rng: () => number;
}

export interface InitContext {
  roster: string[];
  frame: number;
  seed: number;
}

export interface Sim<S = unknown, I = unknown> {
  name?: string;
  init(ctx: InitContext): S;
  addPlayer?(state: S, id: string, ctx: SimContext): void;
  removePlayer?(state: S, id: string, ctx: SimContext): void;
  applyInput(state: S, data: I, ctx: SimContext, playerId: string | null): void;
  step(state: S, ctx: SimContext): void;
  substep?(state: S, ctx: SimContext): void;
  substeps?: number;
  hash(state: S): number;
  serialize(state: S): unknown;
  deserialize(json: unknown): S;
  /** Human-readable; `players` (an array of {id,...} or a map by id) with x,y,z,vx,vy,vz is the prediction fingerprint. */
  status?(state: S): { players?: unknown } & Record<string, unknown>;
}

/** mulberry32: integer-only, identical on every machine. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, for seeds and fingerprints. */
export function hashString(s: string, h = 2166136261): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

export function simVersionOf(sim: Sim): string {
  const parts = [sim.name || '?'];
  for (const k of ['init', 'addPlayer', 'removePlayer', 'applyInput', 'step', 'substep', 'hash', 'serialize', 'deserialize'] as const) {
    const f = (sim as any)[k];
    parts.push(`${k}:${typeof f === 'function' ? String(f) : '-'}`);
  }
  parts.push(`substeps:${sim.substeps || 1}`);
  return hashString(parts.join('\n')).toString(16);
}
