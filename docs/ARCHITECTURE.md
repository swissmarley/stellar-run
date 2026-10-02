# STELLAR RUN: architecture

A portrait, one-handed 3D endless runner for the web. TypeScript, Three.js (the only runtime dependency), Vite.
The design centres on a **pure, deterministic core** that the renderer, the tests and the headless bot all
drive in the same way.

```
┌──────────────────────────── src/app.ts (composition root) ─────────────────────────────┐
│ persistence (SlotStore) · settings · services · screens · audio unlock · wake lock     │
├───────────────────────────────┬────────────────────────────────────────────────────────┤
│ src/game  (presentation)      │ src/ui + src/services                                   │
│  Game: fixed-step loop        │  DOM screens (menu, hangar, upgrades, missions,         │
│  InputRouter → InputFrame     │  leaderboard, shop, settings, notice), HUD, pop-ups     │
│  Render: world, ship, sky,    │  save/settings/consent/haptics/leaderboard/ads/IAP     │
│  post, particles, camera      │                                                         │
│  Feedback: events → juice     │                                                         │
│  AudioEngine (Web Audio)      │                                                         │
├───────────────────────────────┴────────────────────────────────────────────────────────┤
│ src/core  (pure, deterministic, no DOM / three / clock / Math.random)                  │
│  det: Rng, hashing, DetMath   sim: RunSim, collision, hazards, events, ShipStats       │
│  gen: generator, layouts, passability certificate, oracle   director   bot   meta      │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ src/data: every gameplay number and definition (ships, obstacles, patterns, biomes...)  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

`tests/unit/architecture.test.ts` enforces the core rules. A core file fails the test if it imports `three` or
presentation code, or uses `Math.random`, an implementation-approximated `Math` function, `**`, `Date`,
`performance`, timers or DOM globals.

## 1. Fixed-step loop and time

- `RunSim.step(input)` advances exactly one tick at **120 Hz** (`TUNING.SIM_HZ`).
- `Game.tickFrame` runs a wall-clock accumulator, and renders with the ship and track interpolated between the
  last two ticks.
- **Presentation-only time scaling:** focus slow-mo, hit-stop and the slow-motion death scale only how fast
  wall time feeds the accumulator. The sim never knows, so these effects cannot change outcomes.
- **Battery saver** (30 fps) skips every other render. The sim keeps its 120 Hz cadence.
- **Speed is fixed per tick:** forward speed for the next tick is computed (and clamped, see §3) at the end of
  the current one, so controllers know the exact forward step in advance.
- **Floating origin:** sim distances are float64. Everything renders relative to the ship (z = −(s − s_ship)), so
  float32 precision never degrades over long runs.

## 2. Determinism

- **Same output everywhere:** the same seed, the same director state and the same `InputFrame` stream produce
  bit-identical runs in every JS engine.
- **Arithmetic:** only IEEE-754 correctly rounded operations (`+ − × ÷`, `sqrt`, `floor`).
- **Trigonometry:** `dsin`/`dcos` are polynomial (error < 1e-11).
- **Random numbers:** a xoshiro128** generator on 32-bit `Math.imul` arithmetic, seeded per chunk from
  `hash32(runSeed, chunk, attempt)`. Chunk N's random draws never depend on how many numbers earlier chunks
  used.
- **Input:** analog steering is quantised to integers in `InputFrame`.
- **Evidence:**
  - Golden values for the RNG and hashes come from an independent Python implementation
    (`tools/rng_ref.py`).
  - A golden 200-chunk generation hash is asserted in Node (V8), and in Chromium (V8) and WebKit
    (JavaScriptCore) in the e2e suite.
  - Replays hash-match tick by tick.

## 3. Procedural chunks and the passability proof

**Generation.** The track is cut into 200 m chunks, generated two ahead of the ship.
- A chunk is filled with data-driven **patterns** (`src/data/patterns.ts`): scatter fields, walls with holes,
  beams, gates, slaloms, rings, drones and gravity wells.
- Pattern counts and sizes interpolate with difficulty.
- Biomes rotate every 6 chunks: Asteroid Belt → Ion Storm → Dead Station → Singularity.

**Moving hazards are functions of the ship's track distance s**, never of time:
- drones follow `x = f(s_ship)`;
- gravity wells pull with a drift *per metre travelled*.

This makes passability independent of the speed profile. A chunk certified at its **certified speed** v_cert is
passable at every lower speed. v_cert includes boost and the fastest ship, and the sim clamps the ship to it.

**The certificate** (`src/core/gen/passability.ts`):
- **Lattice:** the corridor is a 31 × 21 grid of 0.3 m cells, one int32 bitboard per row.
- **Slices:** the chunk is cut into K slices along s. Each slice is long enough for the *slowest* ship, at v_cert
  and after gravity drift, to move one cell with two ticks of slack: `Δs ≥ v_cert·(cell / v_lat_eff + 2·DT)`.
  The slack covers tick quantisation.
- **Free masks F_k:** cells whose *entire rectangle* keeps the *largest* hitbox at least `margin(d)` away from
  every obstacle while the ship is anywhere in the slice. Rasterisation is conservative: obstacles are
  Minkowski-inflated, and drones are inflated by their Lipschitz bound times half the slice.
- **Forward pass:** `A_0 = E ∩ F_0`, `A_{k+1} = D(A_k) ∩ F_k ∩ F_{k+1}`, where D is 4-neighbour dilation.
  The exit set is the reachable set at the chunk end.
- **Backward pass:** `V_K = FULL`, `V_k = F_k ∩ D(F_k ∩ V_{k+1})`.
- **Acceptance:** a chunk is accepted iff **E ⊆ V_0**, where E is the previous chunk's exit set. Every position
  a player can legally reach at a chunk boundary has a path through the chunk, and its endpoints are again in
  the next entry set. By induction, the whole run is passable, and no player is ever trapped by where they
  crossed a boundary.
- **Repair:** failing chunks are repaired by removing the obstacles that help most, up to 6. Removals are
  evaluated incrementally, slice range by slice range. If repair fails, the chunk is regenerated (up to 4
  attempts), and finally replaced by the biome's empty fallback.

**Where generation runs.** In the browser, chunk building happens in a **Web Worker**
(`src/game/gen/gen-worker.ts`).
- **At the crossing tick, main thread:** the sim requests chunk N+2. The director decides its difficulty there
  (it is stateful) and every input is captured: seed, index, start, the previous chunk's exit set and cruise
  speed.
- **In the worker:** the pure `ProceduralSource.build` runs on those inputs, and the packed chunk returns in a
  pooled transferable buffer.
- **Deadline:** the chunk is first needed one crossing later. If the result is late, `WorkerSource.ensure`
  builds it synchronously from the same inputs, so the result is bit-identical.
- **Evidence:** worker timing provably cannot change a run. `tests/unit/worker-gen.test.ts` covers on-time,
  never, random-late, out-of-order and stale-after-restart delivery. The e2e suite checks the golden hash
  through a real worker.
- **Synchronous paths:** Node tools and tests use the synchronous source directly. The first three chunks of a
  run are built synchronously, to keep restart instant.

Measured on 100 + 100 runs:
- 0.02% fallback chunks;
- about 1 repair removal per chunk;
- about 22 obstacles per chunk;
- p99 generation time 0.7 ms on an M4.

**Soundness evidence** (the reason "provably" is more than a word):

1. **Geometric soundness test:** random points in random free cells, at random s in the slice, keep the
   worst-case hitbox ≥ margin from every obstacle (exact distance, ~12k samples).
2. **Bitboard vs brute force:** the bitboard viability agrees with an independent brute-force search over
   plain arrays.
3. **Perfect bot** (`src/core/bot/bot.ts`): it follows a lattice path inside the certificate through the
   *real* RunSim. It moves one cell per slice and cancels gravity exactly with feed-forward. It must never die.
   Any death would mean the proof, the rasteriser or the collision code is wrong.
4. **Independent oracle** (`src/core/gen/oracle.ts`): it re-checks every tick of the perfect bot. It uses a
   different distance formulation and 8 sub-steps per tick, and asserts the promised margin. Over 100 runs of
   3 minutes: about 16.5M checks, 0 violations, worst slack +0.15 m.

## 4. Difficulty director

`d ∈ [minD, maxD]` for each chunk is computed as:

```
d = base(distance) + skillOffset·skill + inRun
```

Then it is clamped and rate-limited to ±0.08 per chunk.

- **skill** (−1..1, persisted): an EMA over runs of how far the player gets relative to an expected distance.
  This is the death-rate signal.
- **inRun:** adapts within a run to the near-miss rate. A player threading tight gaps gets harder chunks.

Difficulty drives:
- density;
- cruise speed;
- the validation margin;
- which patterns are allowed.

The certificate is computed after difficulty is chosen, so the director can never make a chunk impossible. A
fuzz test feeds the director NaN, ±Infinity and extreme inputs and checks the bounds and rate limit.

## 5. Collision

The ship hitbox is a capsule along the track (radius r, half-length h).

- **Per tick:** a **swept** test. Clearance between the obstacle and the moving capsule is convex in the sweep
  parameter for static shapes, so a 16-step golden-section search finds the minimum. There is no tunnelling at
  any speed.
- **Near-misses:** the same query yields the minimum clearance, which drives the near-miss combo. Clearance under
  0.9 m is a near-miss; under 0.3 m is PERFECT.
- **Allocation:** collision inputs and outputs travel through `Float64Array` slots, and hot sim state lives in a
  `Float64Array` behind accessors. V8 would otherwise box doubles on every call (see DECISIONS #20).

## 6. Rendering (WebGL2, Three.js)

- **World:** per chunk slot, one `InstancedMesh` per obstacle archetype. Matrices are written once when a chunk
  is generated. Per frame, only a group offset moves, plus drone matrices.
- **Sky:** a camera-centred sphere sampling a baked tileable fBm texture (three parallax layers, procedural
  stars). There is no animated `Sky` re-render.
- **Speed effects:** a speed-line tunnel (one cylinder) and camera-facing dust streaks, both instanced and fully
  uniform-driven.
- **Particles:** a GPU pool. Each burst writes its start state once; the vertex shader integrates motion.
- **Post:** a small custom pipeline, used on the medium/high tiers:
  - MSAA target;
  - bright pass;
  - 2× separable blur at ¼ resolution;
  - composite with per-biome grading (lift/gamma/gain, saturation, contrast), vignette and an
    accessibility-gated flash.
- **Draw calls:** 14–22 per frame measured, against a budget of 150 (see PERF.md).
- **Colour:** colour management is off. Everything is authored and output in display space.
- **Readability:** the Okabe–Ito palette marks hazards with vermillion rims and pickups as sky-blue diamonds.
  Shapes differ too, so colour is never the only cue.
- **Quality tiers** (`render/quality.ts`): pixel-ratio cap, MSAA, bloom, grading and dust count. Auto-downgrade
  triggers when p95 frame time exceeds 18 ms for 3 s.

## 7. Audio (Web Audio)

All sound is synthesised in code. There are no files, the output is CC0, and any cue can point at a real
same-origin file instead.

- **Rendering:** SFX and 4 music stems are pre-rendered with `OfflineAudioContext`. Stems are 8 bars at 116 BPM
  per biome root, re-rendered per biome rather than pitch-shifted.
- **Adaptive mix:** layers start sample-aligned. Pad is always on, bass and drums follow speed (and boost), and
  the lead follows *danger*. Danger is the fraction of blocked lattice cells in the next second, read from the
  certificate.
- **Spatial cues:** near-miss whooshes are spatial (`PannerNode`).
- **Focus:** focus applies a low-pass and pitch time-warp. Music position is tracked through the rate change so
  crossfades stay on the beat.
- **iOS:** unlock happens on the first gesture. A WebKit offline-rendering crash is avoided by keeping node
  references alive until rendering finishes (DECISIONS #22).

## 8. Input

`InputRouter` turns pointer, keyboard and tilt input into one quantised `InputFrame` per tick. Edge actions
(boost, ability) are buffered until a tick consumes them.

| Input | Behaviour |
|---|---|
| Drag | Moves a target point (physical mm per CSS px). The ship flies to it at full lateral speed. |
| Tilt | `DeviceOrientationEvent` relative to a calibrated neutral, with dead zone and sensitivity. Uses the iOS permission flow. |
| Tap | Boost: under 220 ms and under 3 mm of travel. |
| Hold | Focus: still for 300 ms at touch start, latched until release. |
| Ability | Dedicated thumb button. |

Everything is remappable, including keys, the tap and hold actions, and a left-handed layout. Expected latency
is one tick (≤ 8.3 ms) plus one or two display frames.

## 9. Meta-game and persistence

- **Profile:** shards, ships, upgrades, cosmetics, best scores, lifetime stats, daily missions, the local
  leaderboard and director skill. Settings live in a separate store.
- **Storage:** `SlotStore` keeps **two alternating slots**. Each holds a `{v, seq, crc32, payload}` envelope.
  - Writes go to the older slot, so a torn write can only damage the older copy.
  - Load picks the newest valid copy, migrates it (`MIGRATIONS`) and sanitises it (unknown ids dropped, numbers
    clamped).
  - A newer schema is never overwritten.
  - Private-mode or quota failures fall back to memory.
- **Missions:** three daily missions per UTC day, the same for everyone. The day key comes from integer
  civil-from-days arithmetic, with no `Date` in core.
- **Monetisation:** `AdService`/`IapService` are interfaces with no-op implementations, and the UI hides those
  paths. Revive (once per run) and cosmetics cost shards earned by playing.

## 10. Privacy

- No network code exists outside fetching the game's own static files, and the CSP `default-src 'self'` enforces
  it. An e2e test asserts no request ever leaves the origin.
- No analytics, no third-party fonts or CDNs.
- `ConsentService` defaults every purpose to denied and unavailable, so the code is GDPR-ready if a fork adds
  something.
- The first launch shows a privacy notice. Data can be exported or deleted from Settings.

## 11. Verification map

| What | Where |
|---|---|
| RNG/hash golden vectors, DetMath accuracy | `tests/unit/det.test.ts` |
| Collision (sphere/box, tunnelling, drones) | `tests/unit/collision.test.ts` |
| Sim determinism (replay hashes), certified-speed clamp | `tests/unit/sim.test.ts` |
| Generator determinism + golden hash, certificate accept/reject, geometric soundness, brute-force agreement | `tests/unit/gen.test.ts` |
| Director bounds fuzz and adaptation | `tests/unit/director.test.ts` |
| Data lint (wells, drones, fallbacks, ships, upgrades) | `tests/unit/data-lint.test.ts` |
| Perfect bot per ship + oracle; human bot dies and revives | `tests/unit/bot.test.ts` |
| Save round-trip, corruption, torn writes, future version, migration, sanitising; economy; missions | `tests/unit/save.test.ts` |
| Pools (chunks, events, particles, world view) | `tests/unit/pools.test.ts` |
| Worker generation is timing-independent (on-time, never, late, out-of-order, stale); chunk codec round-trip | `tests/unit/worker-gen.test.ts` |
| GC behaviour of the tick path | `tests/unit/perf-alloc.test.ts` |
| Flow state machine has no softlocks | `tests/unit/flow.test.ts` |
| Core purity rules | `tests/unit/architecture.test.ts` |
| Audio data, mixes, recipes (mock context) | `tests/unit/audio.test.ts` |
| Restart < 2 s, no errors/CSP violations/foreign requests, drag steering, HUD layout, cross-engine determinism, golden hash through a real worker, zero main-thread fallbacks in play | `tests/e2e/smoke.spec.ts` |
| Persistence across reload, menus, text scale, pop-up pool, offline play | `tests/e2e/meta.spec.ts` |
| 100 seeded runs (perfect + human bots), certificates, softlocks, crashes | `npm run bot` |
| Frame/work time, draw calls, heap, GC traces, bundle size | `npm run bench` → `docs/PERF.md` |
