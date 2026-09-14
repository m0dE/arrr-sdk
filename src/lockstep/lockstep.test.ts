import { describe, it, expect } from 'vitest';
import { FakeRuntime } from '../netcode/runtime.js';
import { Lockstep, type TransportConnection, type TransportEvents } from './lockstep.js';
import { Interpolation } from '../netcode/interpolation.js';
import type { Sim } from './sim.js';

/** A one-axis lockstep sim: each player has x and vx; an input sets vx. Deterministic, integer. */
interface S { tick: number; players: { id: string; x: number; vx: number }[] }
type I = { vx: number };
const sim: Sim<S, I> = {
  name: 'line',
  init: ({ roster, frame }) => ({ tick: frame, players: roster.map((id, i) => ({ id, x: i * 1000, vx: 0 })) }),
  addPlayer: (s, id) => { if (!s.players.some((p) => p.id === id)) { s.players.push({ id, x: s.players.length * 1000, vx: 0 }); s.players.sort((a, b) => (a.id < b.id ? -1 : 1)); } },
  removePlayer: (s, id) => { s.players = s.players.filter((p) => p.id !== id); },
  applyInput: (s, d, _c, who) => { const p = s.players.find((q) => q.id === who); if (p) p.vx = d.vx | 0; },
  step: (s) => { s.tick++; for (const p of s.players) p.x += p.vx; },
  hash: (s) => { let h = 2166136261; for (const p of s.players) { h ^= p.x & 0xff; h = Math.imul(h, 16777619) >>> 0; h ^= p.vx & 0xff; h = Math.imul(h, 16777619) >>> 0; } h ^= s.tick; return h >>> 0; },
  serialize: (s) => JSON.parse(JSON.stringify(s)),
  deserialize: (j) => JSON.parse(JSON.stringify(j)) as S,
  fingerprint: (s, id) => { const p = s.players.find((q) => q.id === id); return p ? `${p.x},${p.vx}` : ''; },
  status: (s) => ({ players: s.players.map((p) => ({ id: p.id, x: p.x, vx: p.vx })) }),
};

/**
 * A fake node: sequences inputs in arrival order, ticks on the fake clock,
 * serves late joiners the last snapshot plus history, computes a majority
 * from hashes, and delivers ticks to each client with a scripted delay.
 */
class FakeNode {
  frame = 0;
  seq = 0;
  history: any[] = [];
  pending: any[] = [];
  clients = new Map<string, { events: TransportEvents; delay: () => number; conn: FakeConn; joinedAt: number; downAt: number; upAt: number }>();

  /** Deliver in order per link, as TCP does: jitter delays, never reorders. */
  later(c: { downAt: number; upAt: number; delay: () => number }, dir: 'downAt' | 'upAt', fn: () => void) {
    const at = Math.max(this.rt.now() + c.delay(), c[dir]);
    c[dir] = at;
    this.rt.setTimeout(fn, at - this.rt.now());
  }
  snapshot: { payload: any; hash: string; seq: number; frame: number } | null = null;
  hashes = new Map<number, Map<string, number>>();
  majority = new Map<number, number>();
  timer: unknown = null;
  constructor(readonly rt: FakeRuntime, readonly period: number) {}

  start() { this.timer = this.rt.setInterval(() => this.tick(), this.period); }

  join(player: string, events: TransportEvents, delay: () => number): FakeConn {
    const clientId = `c-${player}-${this.seq}`;
    const conn = new FakeConn(this, clientId, player);
    const join = { seq: ++this.seq, clientId, data: { type: 'join', clientId, user: { id: player } } };
    this.history.push(join); this.pending.push(join);
    // As the SDK does: ticks that land before INITIAL_STATE are held and
    // replayed after it, only those past the frame it described.
    let connectedAt = -1;
    const held: any[][] = [];
    const gated: TransportEvents = {
      ...events,
      onTick: (frame, inputs, sf, sh, maj) => { if (connectedAt < 0) held.push([frame, inputs, sf, sh, maj]); else events.onTick(frame, inputs, sf, sh, maj); },
    };
    this.clients.set(clientId, { events: gated, delay, conn, joinedAt: this.frame, downAt: 0, upAt: 0 });
    // INITIAL_STATE: snapshot (if any) + history after it.
    const snap = this.snapshot;
    const catchUp = this.history.filter((h) => typeof h.frame === 'number' && (!snap || h.seq > snap.seq || h.data?.type === 'join'));
    const frame = this.frame;
    this.later(this.clients.get(clientId)!, 'downAt', () => {
      connectedAt = frame;
      events.onConnect(snap ? snap.payload : null, catchUp, frame, null, 1000 / this.period, clientId);
      held.sort((a, b) => a[0] - b[0]);
      for (const h of held) if (h[0] > frame) events.onTick(h[0], h[1], h[2], h[3], h[4]);
    });
    return conn;
  }

  /** Set to make the node hold inputs until their target frame and report slack, as the real node now does. */
  buffers = false;
  /** Every slack value ever recorded, for a test to read the distribution. */
  slackLog: number[] = [];
  held = new Map<number, any[]>();
  slack = new Map<string, { target: number; slack: number }[]>();

  input(clientId: string, data: any, target?: number) {
    const next = this.frame + 1;
    const s = this.buffers && typeof target === 'number' ? Math.min(40, target - next) : 0;
    if (this.buffers) { this.slackLog.push(s); if (!this.slack.has(clientId)) this.slack.set(clientId, []); this.slack.get(clientId)!.push({ target: target ?? next, slack: s }); }
    if (s > 0) { if (!this.held.has(next + s)) this.held.set(next + s, []); this.held.get(next + s)!.push({ clientId, data }); return; }
    const inp = { seq: ++this.seq, clientId, data };
    this.history.push(inp); this.pending.push(inp);
  }

  stateHash(clientId: string, frame: number, hash: number) {
    if (!this.hashes.has(frame)) this.hashes.set(frame, new Map());
    this.hashes.get(frame)!.set(clientId, hash);
  }

  publish(seq: number, frame: number, payload: any, hash: string) { this.snapshot = { payload, hash, seq, frame }; }

  private verdict(frame: number): number {
    const votes = this.hashes.get(frame);
    if (!votes) return 0;
    const counts = new Map<number, number>();
    for (const h of votes.values()) counts.set(h, (counts.get(h) || 0) + 1);
    let best = 0, n = 0;
    for (const [h, c] of counts) if (c > n) { best = h; n = c; }
    return n > this.clients.size / 2 ? best : 0;
  }

  tick() {
    this.frame++;
    const due = this.held.get(this.frame);
    if (due) {
      this.held.delete(this.frame);
      const late = this.pending; this.pending = [];
      for (const d of due) { const inp = { seq: ++this.seq, clientId: d.clientId, data: d.data }; this.history.push(inp); this.pending.push(inp); }
      this.pending.push(...late);
    }
    const inputs = this.pending; this.pending = [];
    for (const i of inputs) i.frame = this.frame;
    const majority = this.verdict(this.frame - 1);
    for (const c of this.clients.values()) {
      const f = this.frame, copy = inputs.map((i) => ({ ...i }));
      this.later(c, 'downAt', () => c.events.onTick(f, copy, 0, '', majority));
    }
    if (this.buffers && this.frame % 20 === 0) {
      for (const [id, samples] of this.slack) {
        const c = this.clients.get(id)!, f = this.frame;
        this.later(c, 'downAt', () => c.conn.onInputSlack?.(f, samples));
      }
      this.slack = new Map();
    }
  }
}

class FakeConn implements TransportConnection {
  connected = true;
  onResyncSnapshot?: (data: Uint8Array, frame: number, inputs: any[]) => void;
  onInputSlack?: (frame: number, samples: { target: number; slack: number }[]) => void;
  sent: any[] = [];
  constructor(private node: FakeNode, readonly clientId: string, readonly player: string) {}
  send(data: any, targetFrame?: number) { this.sent.push(data); const c = this.node.clients.get(this.clientId)!; this.node.later(c, 'upAt', () => this.node.input(this.clientId, data, targetFrame)); }
  sendSnapshot(snapshot: any, hash: string, seq?: number, frame?: number) { this.node.publish(seq ?? 0, frame ?? 0, snapshot, hash); }
  sendStateHash(frame: number, hash: number) { const c = this.node.clients.get(this.clientId)!; this.node.later(c, 'upAt', () => this.node.stateHash(this.clientId, frame, hash)); }
  requestResync() { /* not exercised here */ }
  close() { this.connected = false; }
  leaveRoom() { this.connected = false; }
}

function client(rt: FakeRuntime, node: FakeNode, player: string, delay: () => number, opts: { predict?: boolean; input?: () => I | null; snapshotEvery?: number } = {}) {
  const ring = new Map<string, Interpolation<number>>();
  const ls = new Lockstep<S, I>({
    sim, player, room: 'r', runtime: rt, fps: 1000 / node.period,
    predict: opts.predict, inputSource: opts.input, snapshotEvery: opts.snapshotEvery ?? 0,
    dial: async (events) => node.join(player, events, delay),
  });
  ls.world.onTick = (s, f) => { for (const p of s.players) { if (!ring.has(p.id)) ring.set(p.id, new Interpolation(32)); ring.get(p.id)!.record(f, p.x); } };
  return { ls, ring };
}

function xorshift(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

describe('Lockstep end to end', () => {
  it('two clients on a jittery link agree, the late joiner restores from a snapshot, and remotes never starve', async () => {
    const rt = new FakeRuntime();
    const node = new FakeNode(rt, 50);
    node.start();
    const rnd = xorshift(3);
    const jitter = () => 30 + rnd() * 60;               // 30..90 ms one way
    const a = client(rt, node, 'a', jitter, { predict: true, input: () => ({ vx: 3 }), snapshotEvery: 40 });
    await a.ls.start(); rt.advance(200);
    const b = client(rt, node, 'b', jitter, { predict: true, input: () => ({ vx: -2 }) });
    await b.ls.start(); rt.advance(200);
    // Play 20 s, sampling playout every render frame for starvation.
    let starvedA = 0, renders = 0, drawn = 0;
    for (let t = 0; t < 20_000; t += 1000 / 60) {
      rt.advance(1000 / 60);
      const p = a.ls.playout.now(); renders++;
      if (p.starved) starvedA++;
      const br = a.ring.get('b')?.at(p.tick, p.frac); if (br) drawn++;
    }
    // Late joiner after a snapshot exists.
    const c = client(rt, node, 'c', jitter, { predict: false });
    await c.ls.start(); rt.advance(3000);
    expect(a.ls.world.origin?.via).toBe('seed');
    expect(c.ls.world.origin?.via).toBe('snapshot');
    // Agreement: same hash at the same frame for all three.
    const f = Math.min(a.ls.frame, b.ls.frame, c.ls.frame) - 2;
    expect(a.ls.world.hashAt(f)).toBe(b.ls.world.hashAt(f));
    expect(a.ls.world.hashAt(f)).toBe(c.ls.world.hashAt(f));
    expect(a.ls.world.roster.stats.unmapped).toBe(0);
    expect(c.ls.world.roster.stats.unmapped).toBe(0);
    // Remote rendering: after warm-up, no starvation and a bounded delay.
    expect(starvedA / renders).toBeLessThan(0.01);
    expect(a.ls.playout.delayMs).toBeLessThan(250);
    expect(drawn).toBeGreaterThan(renders * 0.9);
    // Prediction: the local player is ahead of the confirmed world and rarely mispredicts on a steady input.
    const ra = a.ls.report();
    expect(ra.prediction!.lead).toBeGreaterThanOrEqual(1);
    expect(ra.prediction!.mispredictions).toBeLessThan(ra.prediction!.beats * 0.05);
    // At this RTT the node's one-tick verdict window never fills - the audit's finding #6 - so only no-disagreement can be asserted here.
    expect(ra.desync.disagreed).toBe(0);
  });

  it('on a fast link the verdict flows and agrees', async () => {
    const rt = new FakeRuntime();
    const node = new FakeNode(rt, 50);
    node.start();
    const a = client(rt, node, 'a', () => 5, { predict: true, input: () => ({ vx: 1 }) });
    const b = client(rt, node, 'b', () => 5, { predict: true, input: () => ({ vx: 2 }) });
    await a.ls.start(); await b.ls.start(); rt.advance(5000);
    const r = a.ls.report();
    expect(r.desync.verdicts).toBeGreaterThan(50);
    expect(r.desync.disagreed).toBe(0);
  });

  it('a beat runs on wall time when ticks are late, and the lead holds', async () => {
    const rt = new FakeRuntime();
    const node = new FakeNode(rt, 50);
    node.start();
    let late = 0;
    const a = client(rt, node, 'a', () => 20 + late, { predict: true, input: () => ({ vx: 1 }) });
    await a.ls.start(); rt.advance(3000);
    const beats0 = a.ls.prediction!.beats;
    late = 400;                                   // a stall: every tick now lands 400 ms late
    rt.advance(1000);
    // In that second the local world kept stepping ~20 times regardless of the ticks.
    expect(a.ls.prediction!.beats - beats0).toBeGreaterThanOrEqual(17);
    late = 20;
    rt.advance(10_000);
    const r = a.ls.report();
    expect(Math.abs(r.prediction!.lead - r.prediction!.leadTarget)).toBeLessThanOrEqual(2);
  });
});

describe('Prediction against a node that holds inputs until their frame', () => {
  function jittery(seed: number, base: number, spread: number) { const r = xorshift(seed); return () => base + r() * spread; }

  it('lands every input exactly once the margin has learned the uplink jitter', async () => {
    const rt = new FakeRuntime();
    const node = new FakeNode(rt, 50);
    node.buffers = true;
    node.start();
    const a = client(rt, node, 'a', jittery(7, 60, 120), { predict: true, input: () => ({ vx: 1 }) });
    await a.ls.start();
    rt.advance(15_000);
    const before = new Map(a.ls.prediction!.landing);
    rt.advance(30_000);
    const p = a.ls.report().prediction!;
    let exact = 0, total = 0;
    for (const [err, n] of Object.entries(p.landing)) { const d = (n as number) - (before.get(Number(err)) || 0); total += d; if (Number(err) === 0) exact += d; }
    const recent = node.slackLog.slice(-600);
    const hist: Record<number, number> = {};
    for (const v of recent) hist[v] = (hist[v] || 0) + 1;
    // Held as long as the jitter needs (±60 ms one way is ±1.2 ticks) and no longer.
    const mean = recent.reduce((x, y) => x + y, 0) / recent.length;
    expect(mean).toBeLessThan(2.5);
    expect(recent.filter((v) => v < 0).length / recent.length).toBeLessThan(0.01);
    expect(total).toBeGreaterThan(400);
    expect(exact / total).toBeGreaterThan(0.99);
    expect(p.marginMs).toBeGreaterThan(0);
    expect(p.marginMs).toBeLessThanOrEqual(200);
    expect(p.slackReports).toBeGreaterThan(20);
  });

  it('against a node that reports nothing the margin stays zero', async () => {
    const rt = new FakeRuntime();
    const node = new FakeNode(rt, 50);
    node.start();
    const a = client(rt, node, 'a', jittery(3, 60, 120), { predict: true, input: () => ({ vx: 1 }) });
    await a.ls.start();
    rt.advance(20_000);
    expect(a.ls.report().prediction!.marginMs).toBe(0);
  });
});

describe('Catch-up', () => {
  it('a joiner far behind replays between frames, absorbs ticks that land meanwhile, and agrees', async () => {
    const rt = new FakeRuntime();
    const node = new FakeNode(rt, 50);
    node.start();
    const a = client(rt, node, 'a', () => 10, { input: () => ({ vx: 1 }), snapshotEvery: 40 });
    await a.ls.start();
    for (let i = 0; i < 400; i++) { rt.advance(50); if (i % 3 === 0) a.ls.send({ vx: (i % 5) - 2 }); }
    // The snapshot the node holds is old by now: unpublish it so the joiner replays the whole history.
    node.snapshot = null;
    const b = client(rt, node, 'b', () => 10, {});
    await b.ls.start();
    rt.advance(2000);
    const r = b.ls.report();
    expect(r.catchup.pending).toBe(0);
    expect(r.catchup.replayed).toBeGreaterThan(300);
    expect(b.ls.frame).toBe(a.ls.frame);
    expect(b.ls.world.hashAt(b.ls.frame)).toBeDefined();
    expect(b.ls.world.hashAt(b.ls.frame)).toBe(a.ls.world.hashAt(a.ls.frame));
    expect(r.desync.disagreed).toBe(0);
  });
});

describe('World', () => {
  it('draws the same rng for every client in a tick', async () => {
    const { World } = await import('./world.js');
    const a = new World(sim, { player: 'a', room: 'r' }), b = new World(sim, { player: 'b', room: 'r' });
    expect(a.ctx(7).rng()).toBe(b.ctx(7).rng());
    expect(a.ctx(7).rng()).not.toBe(a.ctx(8).rng());
  });

  it('refuses to step across a gap and stays holed until restored', async () => {
    const { World } = await import('./world.js');
    const w = new World(sim, { player: 'a', room: 'r' });
    w.seedAt(0, [], 0);
    expect(w.tick(1, [])).not.toBeNull();
    expect(w.tick(3, [])).toBeNull();
    expect(w.frame).toBe(1);
    expect(w.holed).toBe(true);
    expect(w.tick(4, [])).toBeNull();
    expect(w.gaps).toEqual([{ from: 1, to: 4 }]);
    w.restore(sim.serialize(w.state!), 4, [], 4);
    expect(w.holed).toBe(false);
    expect(w.tick(5, [])).not.toBeNull();
  });
});
