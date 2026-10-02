# STELLAR RUN - Plan

> Status is tracked in the milestone checklist at the end. This file was produced in plan mode and approved on 2026-10-02.


## Context
The project folder `/Users/nakya/Documents/ClaudeProjects/Stellar-Run` is empty and not yet a git repo.

**Original brief:** a native iOS/Android Unity runner. Unity is not installed.

**User decisions (2026-10-02)**
- Target the **web**, not the app stores (user prefers open source and avoids the Apple/Google monopolies).
- Deploy on **GitHub Pages**.
- Stack: **TypeScript + Three.js + Vite**.
- Licence: **MIT** for code, **CC0** for generated placeholder art and audio.
- Monetisation: **in-game currency only**. `IAdService` and `IIapService` exist only as no-op interfaces.
- Repository: **public**, `swissmarley/stellar-run`, with **GitHub Actions** running CI and deploying to Pages.

**Outcome:** a playable vertical slice at `https://swissmarley.github.io/stellar-run/`.
- Portrait, one-handed, touch first. Keyboard and mouse on desktop.
- Installable as a PWA and playable offline.
- Every original requirement is mapped to its web equivalent.

**Environment (verified)**
- Machine: Apple M4, 16 GB RAM, 45 GB free disk.
- Tools: Node 22.22, npm 11, Xcode 27 with the iOS 27 simulator (real Mobile Safari for smoke tests).
- GitHub CLI: logged in as `swissmarley` with `repo` scope but **no `workflow` scope**. The user runs `gh auth refresh -h github.com -s workflow` once, before the first push.

## Dependencies (complete list)
| Package | Role | Licence |
|---|---|---|
| three 0.186 | renderer, the **only runtime dependency** | MIT |
| vite 8 | dev server and bundler | MIT |
| typescript 7 (pin 5.9 if TypeScript 7 tooling breaks) | type checking | Apache-2.0 |
| vitest 5 | unit tests | MIT |
| @playwright/test 1.63 + Chromium and WebKit binaries (~250 MB) | play-mode tests and perf bench | Apache-2.0 |
| @biomejs/biome | lint and format | MIT/Apache-2.0 |
| @types/three | types | MIT |
| GitHub Actions (all GitHub-owned): checkout, setup-node, upload-pages-artifact, deploy-pages | CI and deploy | MIT |

- The bot and other tools run with Node's built-in TypeScript type stripping (`node tools/bot.ts`), so no `tsx` is needed.
- tsconfig uses `erasableSyntaxOnly` and `.ts` import extensions to make that work.

## Architecture
- **Pure core (`src/core/`)**
  - No Three.js, DOM, `Date` or `performance`; runs unchanged in Node.
  - Contents: `det/` (Rng, DetMath), `sim/` (RunSim, InputFrame, collision, events ring buffer, score), `gen/` (generator, passability, oracle), `director/`, `bot/`, `meta/` (economy, missions, save codec, flow state machine).
  - The game renders it. The tests and the headless bot drive it directly.
  - An architecture-lint test enforces these bans. Any import of `three`, `Math.random`, `Math.sin/cos/tan/atan2/pow/exp/log/hypot`, `**`, `Date` or `performance` inside core fails the test.
- **Determinism**
  - All sim math is float64 using IEEE correctly-rounded operations only (+ − × ÷ sqrt, floor), plus polynomial DetMath.
  - RNG: xoshiro128** on 32-bit words using `Math.imul` and `>>> 0`. Golden vectors come from a reference implementation.
  - Seeding: FNV-1a over `(seed, chunk, stream)`.
  - Inputs are quantised to ints in `InputFrame`, so a replay produces the same state hash.
- **Loop**
  - The sim runs at a fixed 60 Hz in a `requestAnimationFrame` accumulator, with interpolated rendering (also correct on 120 Hz screens).
  - Hit-stop, slow-mo death and the focus slow-mo scale only the scheduler.
  - 30 fps fallback: render every second frame and run 2 ticks per frame.
  - Pause when the tab is hidden (`visibilitychange`), to save battery.
- **Ship lateral motion is kinematic in the sim.** Velocity is instant within the cap, so the hitbox always matches the drawn ship. Handling *feel* comes from banking, camera lag and FOV.
- **Floating origin.** Sim distance is stored in float64; the ship renders at z≈0.
- **Data-driven definitions.**
  - Typed, frozen TS definition modules in `src/data/` (the ScriptableObject equivalent).
  - Ships, obstacles, patterns, biomes, difficulty curves, upgrades, missions, cosmetics, haptics, control schemes, tuning constants and audio cues live there. One ordered registry exposes them.
  - Upgrades produce derived `ShipStats` and never mutate a definition.
- **Event bus.**
  - The sim writes events into a ring buffer. The game drains it each frame and dispatches on a typed `EventBus` used by the presentation layer.
  - Services sit behind interfaces with swappable implementations: Save, Settings, Haptics, Consent, Platform, Leaderboard (local, plus a mock online one), and Ad/IAP (no-op).
- **No per-frame allocations.**
  - Simulation state is stored as structure-of-arrays in `Float64Array`/`Uint32Array`.
  - Three.js gets scratch `Vector3`/`Matrix4` objects that are reused.
  - Pools: `InstancedMesh` per obstacle archetype, a 4-slot chunk view pool, popup DOM nodes, audio voices and particle bursts.
  - HUD text is written only when its value changes.
  - Checked by a Node test (0 GC events over 20k ticks with a 1 MB semi-space) and Chrome trace GC counts in the bench.

## Procgen and "provably passable"
- **Hazards depend on track distance s, never on time.**
  - Drones follow `x=f(s)`. Gravity wells are an s-domain drift field.
  - So a chunk is passable at every speed up to its certified speed `v_cert`, which already includes max boost and upgrades.
  - The sim clamps the ship to `v_cert`.
- **Bitboard lattice**
  - Corridor X∈[-4.5,4.5], Y∈[-3,3]. Cells are 0.3 m, giving 30×20 cells. Each row is one uint32.
  - Slice length is chosen so the ship can move at least 1 cell per slice at `v_cert`.
  - The free mask is built from obstacles inflated by the worst-case ship radius plus `margin(d)`, rasterised conservatively.
  - Reachable set per slice: `R_{k+1}=D(R_k∩F_k)∩F_k`, where D is 4-neighbour dilation; gravity reduces it.
  - A chunk passes iff its final set `R_K` is non-empty. `R_K` becomes the next chunk's entry set, so passability holds by induction over the whole run.
- **Backward viable sets** guide the bot and enforce a fairness gate at chunk boundaries.
- **Repair:** remove up to 6 slots. If still blocked, use the biome's safe fallback pattern. The fallback rate is reported.
- **Swept-capsule collision** prevents tunnelling. The same query gives the near-miss distance.
- **Evidence**
  1. A perfect bot follows lattice paths through the real RunSim and must never die.
  2. An independent oracle re-checks every chunk on a byte grid at 0.15 m with exact geometry.
  3. A 10k-chunk property test.
  4. Data lint: gravity drift authority and drone Lipschitz bounds.
- **Director**
  - Tracks skill via exponential moving averages of death rate, near-misses per 100 m and distance.
  - Keeps difficulty d in [min,max], with a rate limit.
  - d maps to density, speed and pattern pool. Only certified chunks are ever emitted.

## Rendering, audio, input (web)
- **Rendering:** WebGL2 `WebGLRenderer`. Target under 80 draw calls, budget 150; read from `renderer.info`.
  - `InstancedMesh` per archetype.
  - Procedural geometry: noise-displaced icosahedron asteroids, truss stations, drones, accretion-disc black hole.
  - Nebula: 3 parallax layers sampling a noise texture baked once per biome.
  - Speed-line cylinder shader. Dust that wraps around in the vertex shader.
  - Bloom at quarter resolution on the high tier; additive halo sprites on every tier.
  - Per-biome grading uniforms (lift/gamma/gain, saturation, tint) tweened between biomes.
  - Okabe-Ito colour-blind-safe palette, plus fresnel rims and distinct silhouettes so colour is never the only cue.
  - Quality tiers: pixel ratio cap, bloom, dust count. Auto-downgrade when p95 frame time exceeds 18 ms, falling back to 30 fps.
  - Shader warm-up behind the splash screen.
- **Audio:** Web Audio, unlocked on the first user gesture (needed on iOS).
  - Procedural recipes are pre-rendered once at boot via `OfflineAudioContext` into looped music stems and SFX buffers. No audio files ship.
  - Each cue can also point to a file URL instead, so real audio drops in by changing one value.
  - Music layer gains follow `speed01` and `danger01`; danger is read from the bitboards.
  - Spatial SFX via `PannerNode`. A near-miss whoosh.
- **Haptics:** `navigator.vibrate` (Android Chrome and Firefox), behind HapticsService, rate-limited. iOS Safari has no vibration API, so haptics there are a documented no-op.
- **Input**
  - Pointer events with `touch-action:none`, pointer capture and coalesced events, sampled at the sim tick. Expected latency is well under 100 ms.
  - Steering by drag (physical mm per pixel) or by tilt. Tilt uses `DeviceOrientationEvent`, with iOS permission requested on a user gesture, plus calibration.
  - Boost = tap. Focus = holding still for 220 ms or more.
  - Keyboard and mouse on desktop. Keys and gestures are remappable, with a left-handed mode.
- **Layout:** `viewport-fit=cover` with `env(safe-area-inset-*)`.
  - Resize and `visualViewport` observers handle notches and foldables. On landscape or desktop, the portrait column is letterboxed.
  - The camera framing adjusts so the whole corridor stays visible at any aspect ratio.
  - UI sizes in rem, with a text scale of 100–150%. Reduced motion follows `prefers-reduced-motion` by default and has its own toggle.
- **PWA:** manifest with portrait orientation, plus a hand-written versioned service worker for offline play. PNG icons are generated by a small Node script (zlib-based).
- **Privacy**
  - No network calls apart from the game's own static files, enforced by a CSP `default-src 'self'` meta tag.
  - No analytics, no third-party fonts. ConsentService defaults to deny and is GDPR-ready.
  - The README notes that GitHub Pages hosting logs are covered by GitHub's own privacy policy.

## Meta-game
- **Save**
  - localStorage, two slots A and B with a `seq` number and a CRC32 envelope `{v, seq, crc, payload}`.
  - Each write goes to the older slot. Load takes the newest slot that passes validation, otherwise defaults.
  - Versioned migrations. A save from an unknown future version is never overwritten.
  - Handles quota errors and private-mode browsing (in-memory fallback with a notice).
  - Storage sits behind an interface so tests can use an in-memory store.
- **Ships:** 4, each with distinct handling (lateral speed, hitbox, top speed, boost) and a unique sim-side ability:
  - **Phase:** pass through obstacles for a short time.
  - **Pulse:** clear the obstacles ahead.
  - **Magnet:** pull in currency.
  - **Overdrive:** a longer, safe boost.
  - Abilities are triggered through `InputFrame`, so they stay deterministic.
  - The passability proof covers each ability: Phase and Pulse are designed to only make a chunk easier.
- **Other systems**
  - Upgrade tree.
  - 3 daily missions, seeded from the UTC date.
  - Local leaderboard, plus an `IOnlineLeaderboard` interface with a mock.
  - Revive: once per run, paid with in-game currency. Respawn into a viable cell with a 1.5 s ghost period.
  - Cosmetic shop using in-game currency.
  - Settings and remap UI.

## Milestones (each one tested, playable, committed and pushed, which deploys to Pages)
- **M0 Setup**
  - npm project and dependencies, Playwright browsers.
  - `git init`, MIT LICENSE, .gitignore, tsconfig, Biome, Vite (`base:'/stellar-run/'`).
  - Docs: `docs/PLAN.md` (from this plan), `docs/DECISIONS.md` (including the Unity → Godot → web pivot), CLAUDE.md.
  - CI workflow `.github/workflows/ci.yml`: lint, typecheck, unit tests, bot, e2e in Chromium and WebKit, build, deploy.
  - `gh repo create swissmarley/stellar-run --public`, then enable Pages with `build_type=workflow`. This needs the user's `workflow` scope refresh.
- **M1 Core loop**
  - Rng, DetMath, RunSim, swept collision, one hand-made pattern, accumulator loop.
  - Three.js scene: ship, instanced obstacles, basic chase camera.
  - Drag and keyboard input, death, instant restart (no page reload).
  - Tests: RNG golden vectors, collision, replay hash, Playwright restart under 2 s, no console errors.
  - First Pages deploy, plus an iOS simulator Safari screenshot.
- **M2 Procgen and director**
  - Data definitions, generator, passability, repair, oracle, drones and wells.
  - Director, skill model, bot planner, `tools/bot.ts` (a perfect bot, plus a noisy human-like bot that exercises the director).
  - Tests: determinism golden hash, validator accept/reject cases, property test, director bounds fuzz, data and architecture lint, 100-run bot.
- **M3 Juice**
  - Camera (trauma shake, FOV kick, banking), shaders, biome grading, bloom, particles, popups and combo multiplier, hit-stop and slow-mo.
  - Audio engine and procedural recipes. The audio work goes to a parallel subagent.
  - Haptics, diegetic safe-area HUD, reduced motion.
  - Tests: pooling, no-allocation steady state.
- **M4 Meta**
  - Save system, economy, ships and abilities, upgrades, missions, leaderboards, revive, shop.
  - Consent screen, settings and remapping, PWA and offline.
  - Tests: save round-trip, truncation, bit-flip, missing slot, future version, migrations, plus an e2e offline reload.
- **M5 Optimise, accessibility, report**
  - Quality tiers, warm-up, accessibility pass.
  - Bench, profiled in a subagent, giving `docs/PERF.md`.
  - Final 100-run bot.
  - Docs: ARCHITECTURE.md, TUNING.md (every constant, generated from tuning and definitions), README.

## Verification (exit criteria, adapted to web)
- **Build:** `npm run build` produces no warnings. `npm run lint` (Biome + `tsc --noEmit`) is clean. CI is green on GitHub, and the live Pages URL loads.
- **Tests:** `npm test` (Vitest) and `npm run test:e2e` (Playwright in Chromium and WebKit, at portrait mobile viewports including notched and foldable sizes).
  - Must cover chunk determinism, director bounds, save round-trip and corruption, pooling, restart under 2 s, offline play, and that no request leaves the site's own origin.
- **Bot:** `npm run bot -- --runs 100 --seed 1` must report 0 crashes, 0 softlocks (no progress, NaN, or a stuck game-flow state), 0 oracle failures and 0 perfect-bot deaths.
  - The bot also drives the game-flow loop: run, death, revive, restart.
- **Perf:** `npm run bench` uses Playwright Chromium with GPU on the production build, running the bot for 60 s.
  - Configurations: CPU throttling 1× and 4× (the 4× approximates a mid-range phone), plus the 30 fps mode and WebKit.
  - It records:
    - fps and frame-time p50/p95/p99;
    - draw calls and triangles;
    - JS heap;
    - GC event count and maximum pause (Chrome trace);
    - µs per sim tick and per chunk generation;
    - gzipped bundle size (budget under 1 MB; the original 150 MB install budget is reinterpreted for the web).
  - It is reported honestly as proxy numbers. Real-phone fps and battery use stay untested.
- **Smoke test:** real Mobile Safari in the iOS 27 simulator (`xcrun simctl openurl`), with a screenshot.

## Top risks
1. Mobile browser GPU and thermal limits. Mitigations: quality tiers, auto-downgrade, quarter-resolution bloom.
2. iOS Safari limits: no vibration, tilt permission prompt, audio unlock, no orientation lock. Each is a documented graceful fallback.
3. GC hitches in JavaScript. Mitigations: typed arrays, pooling, GC tests and bench traces.
4. A conservative validator produces sparse layouts. Tune cell size, margin and fairness using the bot's density statistics.
5. TypeScript 7 tooling maturity. Fall back to pinning 5.9 and record it in DECISIONS.md.

## Milestone checklist
- [x] M0 Setup
- [x] M1 Core loop
- [x] M2 Procgen + director
- [x] M3 Juice
- [x] M4 Meta
- [x] M5 Optimise, accessibility, report
