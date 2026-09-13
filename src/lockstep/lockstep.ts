/**
 * The one object a game talks to. Composes the clocks, the confirmed world,
 * the prediction, desync detection, snapshot publishing and reconnection over
 * a transport connection, and exposes what a renderer needs each frame:
 * `playout.now()` for everyone else and `prediction` for the local player.
 */
import { ServerClock } from '../netcode/server-clock.js';
import { Playout, type PlayoutOptions } from '../netcode/playout.js';
import { World } from './world.js';
import { Prediction } from './prediction.js';
import { Desync, type DesyncEvent } from './desync.js';
import { Snapshots } from './snapshots.js';
import { browserRuntime, type Runtime } from '../netcode/runtime.js';
import { Session } from '../netcode/session.js';
import type { Dial, TransportConnection, TransportEvents } from './transport.js';
import { simVersionOf, type Sim } from './sim.js';
import type { StreamInput } from './roster.js';
import { lifecycleOf } from './roster.js';

export interface LockstepOptions<S, I> {
  sim: Sim<S, I>;
  player: string;
  room: string;
  dial: Dial;
  runtime?: Runtime;
  /** Predict the local player (a person); off for a bot. */
  predict?: boolean;
  /** This beat's input for the local player; called once per predicted tick. */
  inputSource?: () => I | null;
  /** Publish a snapshot every N ticks when elected; 0 = never. */
  snapshotEvery?: number;
  /** Ticks per second, until the node says. */
  fps?: number;
  playout?: PlayoutOptions;
  reconnect?: boolean;
  onDesync?: (e: DesyncEvent) => void;
  onError?: (err: string) => void;
  onConnected?: (frame: number) => void;
  onDisconnected?: () => void;
}

export class Lockstep<S = unknown, I = unknown> {
  readonly rt: Runtime;
  readonly clock: ServerClock;
  readonly playout: Playout;
  readonly world: World<S, I>;
  readonly prediction: Prediction<S, I> | null;
  readonly desync: Desync;
  readonly snapshots: Snapshots;
  readonly simVersion: string;
  readonly session: Session<TransportEvents, TransportConnection>;
  connected = false;
  clientId: string | null = null;
  errors: string[] = [];
  /** Ticks per second as the node reports them. */
  fps: number;

  constructor(private readonly opts: LockstepOptions<S, I>) {
    this.rt = opts.runtime ?? browserRuntime();
    this.fps = opts.fps ?? 20;
    this.simVersion = simVersionOf(opts.sim);
    this.clock = new ServerClock(this.rt, { periodMs: 1000 / this.fps });
    this.playout = new Playout(this.rt, this.clock, opts.playout);
    this.world = new World<S, I>(opts.sim, { player: opts.player, room: opts.room });
    this.desync = new Desync(this.rt, {
      onDesync: opts.onDesync,
      requestResync: () => { if (this.conn && this.connected) this.conn.requestResync(); },
    });
    this.snapshots = new Snapshots({ every: opts.snapshotEvery ?? 0, isConnected: (p) => this.world.roster.present.has(p) });
    this.prediction = opts.predict
      ? new Prediction<S, I>(this.rt, opts.sim, this.world, {
        inputSource: opts.inputSource ?? (() => null),
        send: (data, target) => { if (this.conn && this.connected) { this.conn.send(data, target); this.noteSent(); } },
        clock: this.clock,
      }, 1000 / this.fps)
      : null;
    this.session = new Session(this.rt, opts.dial, {
      onConnect: (snapshot, inputs, frame, _node, fps, clientId) => this.onConnect(snapshot, inputs, frame, fps, clientId),
      onTick: (frame, inputs, _sf, _sh, majority) => this.onTick(frame, inputs, majority),
      onDisconnect: () => this.onDisconnect(),
      onError: (e) => { this.errors.push(e); this.opts.onError?.(e); },
    }, { reconnect: opts.reconnect });
  }

  get conn(): TransportConnection | null { return this.session.conn; }
  get reconnects(): number { return this.session.reconnects; }
  get frame(): number { return this.world.frame; }
  get state(): S | null { return this.world.state; }

  async start(): Promise<void> {
    await this.session.start();
    if (this.session.conn) this.session.conn.onResyncSnapshot = (data, frame, inputs) => this.onResync(data, frame, inputs);
  }

  stop(): void {
    this.prediction?.stop();
    this.session.stop();
  }

  /** Send times of own inputs not yet seen in a tick, oldest first - each confirmation is a clock echo. */
  private sentAt: number[] = [];

  /** Send an input outside the prediction beat (a bot, or a non-predicted client). */
  send(data: I): void {
    if (this.conn && this.connected) { this.conn.send(data, this.world.frame + 1); this.noteSent(); }
  }

  private noteSent(): void {
    this.sentAt.push(this.rt.now());
    if (this.sentAt.length > 64) this.sentAt.shift();
  }

  private onConnect(snapshot: any, inputs: StreamInput[], frame: number, fps: number, clientId: string): void {
    this.connected = true;
    this.clientId = clientId;
    if (this.session.conn) this.session.conn.onResyncSnapshot = (data, f, inputs) => this.onResync(data, f, inputs);
    if (fps > 0 && fps !== this.fps) this.fps = fps;
    this.world.periodHint = 1000 / this.fps;
    const restored = this.adopt(snapshot, inputs, frame);
    if (!restored) {
      // No usable snapshot: the history is the whole story, so begin where it
      // begins and replay all of it. Seeding at the join frame instead would
      // put every player at their spawn, which is not where they are.
      let first = Infinity;
      for (const i of inputs) if (typeof i.frame === 'number' && i.frame < first) first = i.frame;
      const startAt = Number.isFinite(first) ? Math.max(0, first - 1) : frame;
      this.world.seedAt(startAt, inputs, frame);
    }
    this.clock.observe(frame);
    this.playout.observe(frame);
    this.prediction?.rebuild();
    this.prediction?.start();
    this.opts.onConnected?.(frame);
  }

  /** Restore from a snapshot object of ours ({ seq, frame, state }) plus catch-up history. */
  private adopt(snapshot: any, inputs: StreamInput[], frame: number): boolean {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const at = typeof snapshot.frame === 'number' ? snapshot.frame : null;
    if (at === null || snapshot.state === undefined) return false;
    if (snapshot.v && snapshot.v !== this.simVersion) this.errors.push(`snapshot from sim version ${snapshot.v}, ours ${this.simVersion}`);
    return this.world.restore(snapshot.state, at, inputs, frame);
  }

  private onTick(frame: number, inputs: StreamInput[], majority?: number): void {
    const at = this.rt.now();
    this.clock.observe(frame, at);
    this.world.periodHint = this.clock.period;
    // The verdict names the frame before this one.
    if (typeof majority === 'number' && majority !== 0) this.desync.verdict(frame - 1, majority, this.world.hashAt(frame - 1));
    const h = this.world.tick(frame, inputs);
    if (h === null) { if (this.world.holed) this.desync.hole(); return; }
    this.playout.observe(frame, at);
    if (this.conn) this.conn.sendStateHash(frame, h);
    let own = 0;
    for (const i of inputs) if (this.clientId && String(i.clientId) === this.clientId && !lifecycleOf(i)) own++;
    // Every own input that came back is an echo of the node's clock. The node
    // handled it somewhere inside the tick before the one it appears in -
    // half a tick earlier on average - which is the time the echo means.
    for (let i = 0; i < own && this.sentAt.length; i++) this.clock.echo(this.sentAt.shift()!, frame - 0.5, at);
    this.prediction?.reconcile(frame, own, at);
    this.prediction?.beatIfStalled(at);
    if (this.snapshots.due(frame, this.opts.player, this.world.roster.members) && this.conn && this.world.state !== null) {
      try {
        const payload = { seq: this.world.lastSeq, frame, v: this.simVersion, state: this.opts.sim.serialize(this.world.state) };
        this.conn.sendSnapshot(payload, h.toString(16), this.world.lastSeq, frame);
        this.snapshots.published++;
      } catch (err) { this.errors.push(`snapshot: ${(err as Error).message}`); }
    }
  }

  private onResync(data: Uint8Array, frame: number, inputs: StreamInput[]): void {
    let snapshot: any = null;
    try { snapshot = JSON.parse(new TextDecoder().decode(data)); } catch { snapshot = null; }
    if (snapshot && snapshot.snapshot) snapshot = snapshot.snapshot;
    if (this.adopt(snapshot, inputs, frame)) {
      this.desync.reset();
      this.prediction?.rebuild();
    } else {
      this.errors.push(`resync at ${frame} carried nothing restorable`);
    }
  }

  private onDisconnect(): void {
    this.connected = false;
    this.prediction?.stop();
    this.opts.onDisconnected?.();
    this.session.lost();
  }

  /** Everything a dashboard or a test wants to know. */
  report() {
    const p = this.prediction;
    return {
      player: this.opts.player, clientId: this.clientId, connected: this.connected, reconnects: this.reconnects,
      frame: this.world.frame, origin: this.world.origin, ticks: this.world.ticks, duplicateTicks: this.world.duplicateTicks, gaps: this.world.gaps.length,
      inputsApplied: this.world.inputsApplied, roster: this.world.roster.members.slice(), attribution: { ...this.world.roster.stats },
      clock: { period: this.clock.period, snaps: this.clock.snaps, tick: this.clock.tickAt(), serverTick: this.clock.serverTickAt(), oneWayMs: this.clock.oneWayMs, echoes: this.clock.echoCount },
      playout: { delayTicks: this.playout.delay, delayMs: this.playout.delayMs, targetTicks: this.playout.targetTicks, starvations: this.playout.starvations, stable: this.playout.stable },
      prediction: p ? { frame: p.frame, lead: p.frame - this.world.frame, leadTarget: p.leadTarget, pending: p.pendingCount, period: p.period, rollbacks: p.rollbacks, mispredictions: p.mispredictions, replayed: p.replayed, beats: p.beats, landing: Object.fromEntries([...p.landing.entries()].sort((a, b) => a[0] - b[0])), samples: p.landingSamples } : null,
      desync: { verdicts: this.desync.verdicts, agreed: this.desync.agreed, disagreed: this.desync.disagreed, resyncs: this.desync.resyncsRequested, last: this.desync.events.slice(-3) },
      snapshotsPublished: this.snapshots.published, simVersion: this.simVersion, errors: [...this.session.errors, ...this.errors].slice(-5),
    };
  }
}
