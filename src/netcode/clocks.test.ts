import { describe, it, expect } from 'vitest';
import { FakeRuntime } from './runtime.js';
import { ServerClock } from './server-clock.js';
import { Playout } from './playout.js';
import { Interpolation } from './interpolation.js';

/**
 * A node ticking every `period` ms whose ticks reach us `late(i)` ms after
 * the one-way trip; we send an input every tick which echoes back in the
 * next tick. Returns clock+playout and starvation over the run.
 */
function run(period: number, ticks: number, late: (i: number) => number, opts: { playout?: ConstructorParameters<typeof Playout>[2]; oneWay?: number } = {}) {
  const rt = new FakeRuntime();
  const clock = new ServerClock(rt, { periodMs: 50 });
  const playout = new Playout(rt, clock, opts.playout);
  const oneWay = opts.oneWay ?? 10;
  let starved = 0, renders = 0, maxDelay = 0;
  // We send one input 5 ms after each tick lands; it reaches the node one
  // trip later and is broadcast in the first tick that begins after that.
  const events: { at: number; tick: number; echoes: number[] }[] = [];
  const boundary = (i: number) => 10_000 + i * period;
  const sends: number[] = [];
  for (let i = 0; i < ticks; i++) {
    sends.push(boundary(i) + oneWay + late(i) + 5);
    events.push({ at: boundary(i) + oneWay + late(i), tick: i, echoes: [] });
  }
  for (const sentAt of sends) {
    const arrive = sentAt + oneWay;
    const land = Math.floor((arrive - 10_000) / period) + 1;
    if (land < ticks) events[land].echoes.push(sentAt);
  }
  let next = 0;
  const end = events[events.length - 1].at + period;
  for (let t = 10_000; t < end; t += 1000 / 60) {
    while (next < events.length && events[next].at <= t) {
      const e = events[next++];
      rt.advance(e.at - rt.now());
      clock.observe(e.tick);
      for (const sentAt of e.echoes) clock.echo(sentAt, e.tick - 0.5, e.at);
      playout.observe(e.tick);
    }
    rt.advance(t - rt.now());
    if (t - 10_000 > 3000) { const p = playout.now(); renders++; if (p.starved) starved++; if (playout.delay > maxDelay) maxDelay = playout.delay; }
  }
  return { clock, playout, starved, renders, maxDelay };
}

describe('ServerClock', () => {
  it('tracks a sender running slow, from echoes', () => {
    const { clock } = run(65, 600, () => 0);
    expect(clock.period).toBeGreaterThan(63);
    expect(clock.period).toBeLessThan(67);
    // And knows where the node's boundaries are: tick 500 began at 10000 + 500*65.
    expect(Math.abs(clock.serverBoundaryAt(500) - (10_000 + 500 * 65))).toBeLessThan(15);
  });

  it('is not pulled late by late ticks', () => {
    const { clock } = run(50, 600, (i) => (i % 10 === 0 ? 180 : 0));
    const due = clock.dueAt(590), actual = 10_000 + 590 * 50 + 10;
    expect(Math.abs(due - actual)).toBeLessThan(15);
  });

  it('measures the one-way trip', () => {
    const { clock } = run(50, 300, () => 0, { oneWay: 40 });
    expect(Math.abs(clock.oneWayMs - 40)).toBeLessThan(8);
  });
});

describe('Playout', () => {
  it('never starves on a regular stream at the minimum delay', () => {
    const r = run(50, 600, () => 0);
    expect(r.starved).toBe(0);
    expect(r.playout.delay).toBeLessThanOrEqual(2.1);
  });

  it('absorbs 100 ms one-way jitter after learning, with a bounded delay', () => {
    let s = 7;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const r = run(50, 1200, () => rnd() * 100);
    // After the first 3 s (excluded), starvation must be rare and the delay about jitter + 1 tick.
    expect(r.starved / r.renders).toBeLessThan(0.005);
    expect(r.maxDelay).toBeLessThan(5);
  });

  it('a rare half-second stall costs a short freeze, not permanent latency', () => {
    // Every 10 s, 6 ticks held up to 500 ms and delivered together. A 3%
    // event is below the covered quantile by design: covering it would cost
    // every player half a second of remote latency all the time.
    const r = run(50, 1200, (i) => (i % 200 >= 100 && i % 200 < 106 ? (105 - (i % 200)) * 50 + 250 : 0));
    expect(r.playout.starvations).toBeGreaterThan(0);
    expect(r.starved).toBeLessThan(6 * 32);      // each burst freezes for about its own length, no more
    expect(r.maxDelay).toBeLessThan(8);
    expect(r.playout.delay).toBeLessThan(8);     // and it comes back down between bursts
  });

  it('sustained jitter is covered: after learning, starvation is rare and the delay sits at the quantile', () => {
    let s = 11;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const r = run(50, 1200, () => rnd() * 200);  // 0..200 ms one-way jitter, every tick
    expect(r.starved / r.renders).toBeLessThan(0.02);
    expect(r.playout.delay).toBeGreaterThan(3);
    expect(r.playout.delay).toBeLessThan(7);
  });

  it('clamps at the newest tick rather than extrapolating', () => {
    const rt = new FakeRuntime();
    const clock = new ServerClock(rt, { periodMs: 50 });
    const playout = new Playout(rt, clock);
    for (let i = 0; i < 100; i++) { rt.advance(50); clock.observe(i); clock.echo(rt.now() - 45, i - 0.5, rt.now()); playout.observe(i); }
    rt.advance(5000); // nothing arrives for 5 s
    const p = playout.now();
    expect(p.tick).toBe(99);
    expect(p.starved).toBe(true);
  });
});

describe('Interpolation', () => {
  it('brackets a time inside the ring and never past its ends', () => {
    const ring = new Interpolation<number>(4);
    for (let t = 10; t < 20; t++) ring.record(t, t * 100);
    expect(ring.size).toBe(4);
    expect(ring.at(17, 0.25)).toEqual({ a: 1700, b: 1800, t: 0.25 });
    expect(ring.at(19, 0.5)).toEqual({ a: 1900, b: 1900, t: 0 });
    expect(ring.at(3, 0.5)).toEqual({ a: 1600, b: 1600, t: 0 });
  });

  it('interpolates across a recorded gap', () => {
    const ring = new Interpolation<number>(8);
    ring.record(1, 100); ring.record(4, 400);
    expect(ring.at(2, 0)).toEqual({ a: 100, b: 400, t: 1 / 3 });
  });
});

