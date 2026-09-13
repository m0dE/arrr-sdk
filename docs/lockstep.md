# Lockstep layer — design

The SDK carries inputs into a room in a total order and hands back ticks.
Every game built on it then has to solve the same eight problems before it
can draw a frame, and today each one does — rooftop in a file copied out of
the mesh repo's test fixtures, mecharoyale in its own 2,500 lines. This module
owns those problems once, in the SDK, and games implement a small
deterministic sim contract and nothing else.

Reasoned from the two facts that decide everything:

1. **A lockstep client cannot advance the confirmed world until the next tick
   arrives.** Wall time keeps moving while the world does not. Any renderer
   that draws at the edge of what it has will freeze on a late tick and lurch
   on the burst after it — measured on rooftop over a satellite link: every
   stall had the render clock pinned at its extrapolation cap.
2. **The network only ever delivers latency, jitter and stalls.** They can be
   traded against each other, never removed. Every choice below says which
   one the player pays in, and the answer is always the same: pay in latency
   you cannot see (other people a little behind, your own inputs a little
   early) rather than judder you can.

## Objects

Each has one job, no DOM, no timers of its own; time and scheduling are
injected (`Runtime`) so all of it runs under a fake clock in tests.

| object | job |
|---|---|
| `ServerClock` | Where the node's tick clock is, from **echoes** (NetStorm / TrinityCore / netlib `time-sync.ts`): per own input confirmed in tick `s`, latency = RTT/2, delta = s − receive + latency, spike-filtered, followed with slew. Plus a fitted **rate** (nodes tick at 19.95 Hz idle, 15 Hz saturated). Two references from one rate: the node's boundary for tick k (what a sender needs) and the earliest a tick reaches us (floor over arrivals — what a renderer needs; an echo cannot split the round trip). Not synced until the first echo; an idle game sends its idle input. |
| `Playout` | The render time for other players: `arrival clock − delay`. The delay is learned like librsc's `AdaptiveInputBuffer`: lateness into a forgetting histogram, a quantile of it plus one tick — but at render grade (98th stable / 99.5th unstable), because an input underrun repeats an input and nobody sees it while an uncovered tick here is a frame standing still. Smoothed, boosted at once on a starvation, slewed when drawn, bounded. Never past the newest confirmed tick. Rare stalls are deliberately *not* covered: a 3 % event is a short freeze, not permanent latency for everyone. |
| `Interpolation` | A ring of per-tick states keyed by tick, `at(tick, frac)` → the bracketing pair. Deep enough for the delay plus a burst. |
| `Prediction` | The local player: a beat steps the predicted world one tick at a time with the held input and sends it; confirmed ticks only *reconcile* (fingerprint the local player, roll back and replay on mismatch). **Where an input lands** with today's node is the tick after it *arrives*, and node timers only fire late, so an input reaching the node near a boundary is inherently ambiguous — a free-running beat drifts through that band and dwells there (measured: 44–70 % of inputs off by one). So the beat is **phase-locked to the node's clock**: it fires when its input, one trip later, reaches the node mid-tick, and that tick is the target, exact by construction (measured: 99.3 % exact on a clean link, ~4 mispredictions per 600 beats). The lock follows the smoothed clock, not arrivals, so tick jitter never enters the cadence. A `dilation` hook lets a node that reports its input-buffer depth ask the client to tick a little faster or slower. |
| `Lead` | With the lock, the landing offset is `1 + floor(oneWay / period)`, from the echo. On a link whose uplink jitter exceeds half a tick (satellite: ±1–2 ticks scatter, 34 % rollbacks) no client-side placement can be exact: that is the measured case for the node-side target-frame input buffer below. |
| `Roster` | Who is in the room and which connection is whose: join/reconnect/leave/disconnect inputs and the client list, resolved so that every input the sim applies is attributed to a player, never to a claim in its payload. |
| `World` | The confirmed simulation: seed at an agreed frame or restore from a snapshot plus catch-up, apply the stream in seq order, step, hash, keep a window of hashes and statuses. Duplicate and out-of-order ticks are refused here; so is a gap - stepping once across missing ticks would make a world nobody else has - and a gap asks the node for a resync. |
| `Desync` | Compares this client's hash for frame F against the room's verdict for F *when the verdict arrives* - windowed, not only on the very next tick (the node's verdict is empty above one tick of RTT today; a windowed comparison also works when that is fixed). Reports, and asks for a resync on a sustained disagreement. |
| `Snapshots` | Publisher election by the in-stream roster - the lowest id present, as the stream says at that frame - so every client elects the same publisher at the same tick without a message. The node's out-of-band client list is deliberately not used: it is not frame-consistent, so two clients reading it would elect differently for a moment. Publish cadence, and the seq/frame the node needs to serve late joiners correctly - the SDK's bare `sendSnapshot` gets both wrong by default. Until the authority produces snapshots itself, which is the recommended node change. |
| `Reconnect` | Redial with backoff, resume as the same member, restore from the resync the node sends. The node's grace period is sized on the assumption this exists; the SDK never had it. |
| `Lockstep` | Composes the above over a `Connection`; the one object a game talks to. |

## Sim contract (unchanged from the harness games already implement)

```
init(ctx) -> state            seeded only from the sorted roster and the frame
addPlayer(state, id, ctx)     a join arrived in the stream
removePlayer(state, id, ctx)  a leave arrived in the stream
applyInput(state, data, ctx, playerId)
step(state, ctx)              advance exactly one tick
hash(state) -> uint32
serialize(state) -> json; deserialize(json) -> state
fingerprint?(state, player)   what the local player would notice being wrong; compared predicted vs confirmed, rolls back on a difference
status?(state) -> object      human-readable, diagnostics only
substep?(state, ctx), substeps?
```
`ctx` = `{ frame, player, roster, rng }` with a deterministic rng seeded from
the room and the frame - the same sequence on every client in the same tick. Integer / fixed-point math only, no `Math.random`, no
`Date`, no iteration over unordered maps.

## What the game does per frame

```
const ls = lockstep.create(app, { connect: ..., player, room, predict: true })
render loop: const { tick, frac } = ls.playout.now(); const me = ls.prediction.now()
             draw remotes from their Interpolation ring at (tick, frac); draw self from the predicted world at me.frac
```

## Node changes this design wants (recorded, not required)

- Honour `clientFrame` as a target frame: an adaptive per-client input buffer
  on the node (librsc's `AdaptiveInputBuffer` is the reference: forgetting
  histogram, quantile by stability, boost on underrun) that holds inputs until
  their tick and reports its depth so the client can dilate its beat. This is
  what makes prediction exact on jittery uplinks; the phase lock is the best
  a client can do without it.
- Carry the node's timestamp and current period in every tick.
- Produce snapshots on the authority instead of trusting a client.
- Compute the majority verdict for F after a window, not one tick later.

## Migration

- rooftop: `public/net/harness.js` is replaced by `arrrNetwork.lockstep`; the
  e2e driver hooks (`__app.report()`) are kept as a thin adapter. `sync-sdk`
  stops copying `harness.js`.
- mecharoyale: keeps its embedded-authority shape; `NetClock` is the model for
  `ServerClock` here and can be swapped for it when the client is next touched.
