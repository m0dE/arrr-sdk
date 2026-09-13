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
import { Catchup, type CatchupOptions } from './catchup.js';
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
  /** Hash the world every N ticks (see World). */
  hashEvery?: number;
  catchup?: CatchupOptions;
  /**
   * Ms of consecutive tick work (gaps under `pileGapMs`) after which the rest
   * of a burst goes to the backlog and is worked through between frames.
   */
  pileBudgetMs?: number;
  pileGapMs?: number;
  /**
   * The world moved: one tick landed, or a backlog was worked through to
   * `frame`. `corrected` is true when the prediction was rebuilt on it, so a
   * renderer can ease the local player onto the corrected path instead of
   * drawing the jolt. Not called for the ticks inside a backlog.
   */
  onTick?: (state: S, predicted: S | null, frame: number, corrected: boolean) => void;
  /** The world is standing again after a join, a resync or a pile. */
  onCaughtUp?: (frame: number, live: boolean) => void;
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
  readonly catchup: Catchup<S, I>;
  readonly simVersion: string;
  readonly session: Session<TransportEvents, TransportConnection>;
  connected = false;
  clientId: string | null = null;
  errors: string[] = [];
  private readonly pileBudgetMs: number;
  private readonly pileGapMs: number;
  private pileBurstMs = 0;
  private pileLastEnd = -Infinity;
  private rollbacksAtLastTick = 0;
  /** Ticks per second as the node reports them. */
  fps: number;

  constructor(private readonly opts: LockstepOptions<S, I>) {
    this.rt = opts.runtime ?? browserRuntime();
    this.fps = opts.fps ?? 20;
    this.simVersion = simVersionOf(opts.sim);
    this.clock = new ServerClock(this.rt, { periodMs: 1000 / this.fps });
    this.playout = new Playout(this.rt, this.clock, opts.playout);
    this.world = new World<S, I>(opts.sim, { player: opts.player, room: opts.room, hashEvery: opts.hashEvery });
    this.desync = new Desync(this.rt, {
      onDesync: opts.onDesync,
      requestResync: () => { if (this.conn && this.connected) this.conn.requestResync(); },
      report: (e) => {
        if (!this.conn || !this.connected) return;
        this.conn.send({
          type: 'desync_report', frame: e.frame, mine: e.mine, majority: e.majority, player: opts.player, app: opts.sim.name,
          simFrames: this.world.ticks, inputsApplied: this.world.inputsApplied, restoredFrom: this.world.origin?.frame ?? null,
          status: opts.sim.status && this.world.state !== null ? opts.sim.status(this.world.state) : null,
        });
      },
    });
    this.catchup = new Catchup<S, I>(this.rt, this.world, {
      publish: (frame) => this.publish(frame),
      done: (frame, live) => this.caughtUp(frame, live),
    }, opts.catchup);
    this.pileBudgetMs = opts.pileBudgetMs ?? 12;
    this.pileGapMs = opts.pileGapMs ?? 4;
    this.snapshots = new Snapshots({ every: opts.snapshotEvery ?? 0, isConnected: (p) => this.world.roster.present.has(p) });
    this.prediction = opts.predict
      ? new Prediction<S, I>(this.rt, opts.sim, this.world, {
        inputSource: opts.inputSource ?? (() => null),
        send: (data, target) => { if (this.conn && this.connected) { this.conn.send(data, target); this.noteSent(target); } },
        clock: this.clock,
      }, 1000 / this.fps)
      : null;
    this.session = new Session(this.rt, opts.dial, {
      onConnect: (snapshot, inputs, frame, _node, fps, clientId) => this.onConnect(snapshot, inputs, frame, fps, clientId),
      onTick: (frame, inputs, sf, _sh, majority) => this.onTick(frame, inputs, sf, majority),
      onDisconnect: () => this.onDisconnect(),
      onError: (e) => { this.errors.push(e); this.opts.onError?.(e); },
    }, {
      reconnect: opts.reconnect,
      onDialed: (conn) => {
        conn.onResyncSnapshot = (data, frame, inputs) => this.onResync(data, frame, inputs);
        conn.onInputSlack = (_f, samples) => this.onSlack(samples);
      },
    });
  }

  get conn(): TransportConnection | null { return this.session.conn; }
  get reconnects(): number { return this.session.reconnects; }
  get frame(): number { return this.world.frame; }
  get state(): S | null { return this.world.state; }

  async start(): Promise<void> {
    await this.session.start();
  }

  stop(): void {
    this.prediction?.stop();
    this.session.stop();
  }

  /** Own inputs not yet seen in a tick, oldest first: when sent and for which frame. Each confirmation is a clock echo. */
  private sentAt: { at: number; target: number }[] = [];
  /**
   * Once the node has reported input slack, it is a node that holds inputs
   * until their frame - and an echo then has to have the hold taken out of
   * it, or the clock would read the buffer as distance. Confirmed own inputs
   * wait here, by the frame they landed in, for the report that says how
   * long each was held.
   */
  private nodeBuffers = false;
  private awaitingSlack = new Map<number, { a: number; b: number }[]>();
  private awaitingCount = 0;

  /** Send an input outside the prediction beat (a bot, or a non-predicted client). */
  send(data: I): void {
    if (this.conn && this.connected) { const t = this.world.frame + 1; this.conn.send(data, t); this.noteSent(t); }
  }

  private noteSent(target: number): void {
    this.sentAt.push({ at: this.rt.now(), target });
    if (this.sentAt.length > 64) this.sentAt.shift();
  }

  /** An own input was confirmed in tick `k` at local `b`: echo now, or after the slack report says how long it was held. */
  private confirmed(a: number, k: number, b: number): void {
    if (!this.nodeBuffers) { this.clock.echo(a, k - 0.5, b); return; }
    let arr = this.awaitingSlack.get(k);
    if (!arr) this.awaitingSlack.set(k, (arr = []));
    arr.push({ a, b });
    if (++this.awaitingCount > 128) { const first = this.awaitingSlack.keys().next().value!; this.awaitingCount -= this.awaitingSlack.get(first)!.length; this.awaitingSlack.delete(first); }
  }

  /** The node's report: for each own input, the frame it named and how many ticks early it arrived. */
  private onSlack(samples: { target: number; slack: number }[]): void {
    this.nodeBuffers = true;
    this.prediction?.slack(samples);
    for (const { target, slack } of samples) {
      const hold = Math.max(0, slack);
      const k = target - Math.min(0, slack);        // the frame it landed in
      const arr = this.awaitingSlack.get(k);
      const e = arr?.shift();
      if (!e) continue;
      this.awaitingCount--;
      if (arr!.length === 0) this.awaitingSlack.delete(k);
      // Handled by the node during tick k - hold - 1, so at k - hold - 0.5 on
      // average; and the round trip is what it was minus the time it sat.
      this.clock.echo(e.a, k - hold - 0.5, e.b - hold * this.clock.period);
    }
  }

  private onConnect(snapshot: any, inputs: StreamInput[], frame: number, fps: number, clientId: string): void {
    this.connected = true;
    this.clientId = clientId;
    if (fps > 0 && fps !== this.fps) this.fps = fps;
    this.world.periodHint = 1000 / this.fps;
    this.clock.observe(frame);
    this.playout.observe(frame);
    if (!this.adopt(snapshot, inputs, frame)) {
      // No usable snapshot: the history is the whole story, so begin where it
      // begins and replay all of it. Seeding at the join frame instead would
      // put every player at their spawn, which is not where they are.
      let first = Infinity;
      for (const i of inputs) if (typeof i.frame === 'number' && i.frame < first) first = i.frame;
      const startAt = Number.isFinite(first) ? Math.max(0, first - 1) : frame;
      this.world.seedAt(startAt, inputs);
      this.catchup.start(startAt + 1, frame, inputs, false);
    }
    this.opts.onConnected?.(frame);
  }

  /** Restore from a snapshot object of ours ({ seq, frame, state }) plus catch-up history, replayed between frames. */
  private adopt(snapshot: any, inputs: StreamInput[], frame: number): boolean {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const at = typeof snapshot.frame === 'number' ? snapshot.frame : null;
    if (at === null || snapshot.state === undefined) return false;
    if (snapshot.v && snapshot.v !== this.simVersion) this.errors.push(`snapshot from sim version ${snapshot.v}, ours ${this.simVersion}`);
    if (!this.world.restore(snapshot.state, at, inputs)) return false;
    this.catchup.start(at + 1, frame, inputs, false);
    return true;
  }

  /** The backlog is worked through: the world stands at `frame` and everything that waits on it resumes. */
  private caughtUp(frame: number, live: boolean): void {
    if (this.world.state === null) return;
    this.prediction?.rebuild();
    if (!live) { this.desync.reset(); this.prediction?.start(); this.publish(frame); }
    this.notifyTick(frame, true);
    this.opts.onCaughtUp?.(frame, live);
  }

  private notifyTick(frame: number, force: boolean): void {
    if (!this.opts.onTick || this.world.state === null) return;
    const rb = this.prediction?.rollbacks ?? 0;
    const corrected = force || rb !== this.rollbacksAtLastTick;
    this.rollbacksAtLastTick = rb;
    try { this.opts.onTick(this.world.state, this.prediction?.state ?? null, frame, corrected); } catch (err) { this.errors.push(`onTick: ${(err as Error).message}`); }
  }

  /** Send the confirmed world as the room's snapshot, if it is worth sending. */
  private publish(frame: number): void {
    if (!this.conn || !this.connected || this.world.state === null || (this.opts.snapshotEvery ?? 0) <= 0) return;
    const h = this.world.hashNow();
    if (!this.snapshots.worthSending(h)) return;
    try {
      const payload = { seq: this.world.lastSeq, frame, v: this.simVersion, state: this.opts.sim.serialize(this.world.state) };
      this.conn.sendSnapshot(payload, h.toString(16), this.world.lastSeq, frame);
      this.snapshots.sent(h);
    } catch (err) { this.errors.push(`snapshot: ${(err as Error).message}`); }
  }

  private onTick(frame: number, inputs: StreamInput[], snapshotFrame: number | undefined, majority?: number): void {
    const at = this.rt.now();
    this.clock.observe(frame, at);
    this.world.periodHint = this.clock.period;
    if (typeof snapshotFrame === 'number' && snapshotFrame >= 0) this.snapshots.nodeFrame = snapshotFrame;
    // The verdict names the frame before this one.
    if (typeof majority === 'number' && majority !== 0) this.desync.verdict(frame - 1, majority, this.world.hashAt(frame - 1));
    if (this.catchup.active) { this.catchup.absorb(frame, inputs); return; }
    // A burst of ticks is not applied inside one frame: past the budget the
    // rest becomes a backlog, worked through between frames.
    if (at - this.pileLastEnd > this.pileGapMs) this.pileBurstMs = 0;
    if (this.pileBurstMs > this.pileBudgetMs && this.world.frame >= 0 && frame > this.world.frame) {
      this.catchup.start(frame, frame, inputs, true);
      return;
    }
    const h = this.world.tick(frame, inputs);
    const end = this.rt.now();
    this.pileBurstMs += end - at; this.pileLastEnd = end;
    if (h === null) { if (this.world.holed) this.desync.hole(); return; }
    this.playout.observe(frame, at);
    if (this.conn && h !== undefined) this.conn.sendStateHash(frame, h);
    let own = 0;
    for (const i of inputs) if (this.clientId && String(i.clientId) === this.clientId && !lifecycleOf(i)) own++;
    // Every own input that came back is an echo of the node's clock. The node
    // handled it somewhere inside the tick before the one it appears in -
    // half a tick earlier on average - which is the time the echo means.
    for (let i = 0; i < own && this.sentAt.length; i++) this.confirmed(this.sentAt.shift()!.at, frame, at);
    this.prediction?.reconcile(frame, own, at);
    this.prediction?.beatIfStalled(at);
    if (this.snapshots.due(frame, this.opts.player, this.world.roster.members)) this.publish(frame);
    this.notifyTick(frame, false);
  }

  private onResync(data: Uint8Array, frame: number, inputs: StreamInput[]): void {
    let snapshot: any = null;
    try { snapshot = JSON.parse(new TextDecoder().decode(data)); } catch { snapshot = null; }
    if (snapshot && snapshot.snapshot) snapshot = snapshot.snapshot;
    if (!this.adopt(snapshot, inputs, frame)) this.errors.push(`resync at ${frame} carried nothing restorable`);
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
      prediction: p ? { frame: p.frame, lead: p.frame - this.world.frame, leadTarget: p.leadTarget, pending: p.pendingCount, period: p.period, nodeBuffers: this.nodeBuffers, marginMs: p.marginMs, slackReports: p.slackReports, slackLate: p.slackLate, rollbacks: p.rollbacks, mispredictions: p.mispredictions, replayed: p.replayed, beats: p.beats, landing: Object.fromEntries([...p.landing.entries()].sort((a, b) => a[0] - b[0])), samples: p.landingSamples } : null,
      desync: { verdicts: this.desync.verdicts, agreed: this.desync.agreed, disagreed: this.desync.disagreed, resyncs: this.desync.resyncsRequested, last: this.desync.events.slice(-3) },
      snapshots: { published: this.snapshots.published, skipped: this.snapshots.skipped, asStandIn: this.snapshots.asStandIn, nodeFrame: this.snapshots.nodeFrame },
      catchup: { pending: this.catchup.pending, replayed: this.catchup.replayed, piles: this.catchup.piles, piled: this.catchup.piled, published: this.catchup.published },
      snapshotsPublished: this.snapshots.published, simVersion: this.simVersion, errors: [...this.session.errors, ...this.errors].slice(-5),
    };
  }
}
