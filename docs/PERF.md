# Performance report

> **Measured on:** Apple M4 (16 GB, macOS 26.6), headless Playwright.
> - Chromium renders on the real GPU through ANGLE/Metal.
> - WebKit is Playwright's build.
>
> Raw data: `docs/perf/bench.json` (`npm run bench`), plus the Node measurements below.
> **No physical phone was available.** Phone figures are estimates, labelled as such.

## Method

**Bench.** `npm run bench` builds the production bundle, serves it and opens it with a Pixel 7 profile in Chromium
and an iPhone 15 profile in WebKit.
- **Run:** the **perfect bot** flies the real game: rendering, sim, HUD, pop-ups and particles. Audio is not
  unlocked, because no user gesture happens.
- **Warm-up:** 4 s before measuring.
- **Recorded per frame:**
  - frame interval;
  - main-thread work inside the frame (sim ticks + render submission);
  - draw calls and triangles from `renderer.info`.
- **Chromium also records:**
  - JS heap (CDP `Performance.getMetrics`);
  - every main-thread `MinorGC` and `MajorGC` event from a DevTools trace of the measured window.

**Chrome CPU throttling is not a phone model here.** It suspends the main thread *between* tasks, so 1–2 ms frames
mostly escape it: 4× throttling measured *lower* per-frame work. It was verified to slow long tasks by 3.7×. So
phone estimates instead scale the measured M4 work time by **×5**. That is a conservative JS-performance gap
between an M4 and a 2021 mid-range Android phone (Snapdragon 778G class). A 2021 iPhone is closer to ×2–3.

**Sim and generation in isolation** (Node 22, V8):
- `tools/alloc-check.ts`: allocation and GC over 5 simulated minutes.
- `tools/gen-bench.ts`: generation cost over 3000 chunks.
- `npm run bot`: per-tick cost over 6+ simulated hours.

## Results against the budget

| Budget (brief) | Web interpretation | Measured | Verdict |
|---|---|---|---|
| Stable 60 fps on a mid-range 2021 phone | Frame interval and main-thread work per frame | M4: 60 fps in every config; frame p99 16.8 ms, max 16.8 ms (Chromium); main-thread work p99 1.0–1.2 ms, max 4.1 ms. **Phone estimate (×5): work p99 ≈ 6 ms, worst ≈ 20 ms** | ✅ on M4; ⚠️ phone **estimated** within budget, GPU **unverified** |
| 30 fps fallback | Battery-saver mode + auto-downgrade | 30 fps mode halves render work (work p50 0.4 ms vs 0.8 ms); sim stays at 120 Hz | ✅ |
| Draw calls < 150 | `renderer.info.render.calls` | mean 18–27, max 31 (high tier at difficulty 0.9, incl. 6 post passes) | ✅ |
| No GC spikes during play | GC pauses vs frame budget | See the GC section below. No frame interval exceeded 16.8 ms in 4 min of Chromium frames despite the collections. | ✅ on M4; ⚠️ phones unverified |
| < 150 MB install | Download / offline cache size | **288 KB gzipped** (848 KB raw, 11 files; JS 206 KB gz, including the 31 KB raw generation worker). Cache Storage ≈ 0.85 MB. | ✅ |
| < 1.5 GB RAM | JS heap + GPU + audio | JS heap **5.4–6.1 MB** in steady play, plus ~2–3 MB for the generation worker's heap. Audio buffers 14–22 MB (once unlocked). GPU estimated at Pixel 7 size: high ≈ 70 MB (4× MSAA target), medium ≈ 15 MB. | ✅ (GPU and audio are estimates) |
| < 4% battery / 10 min | — | **Not measured** (no device). Mitigations below. | ❓ untested |

### Frame and work time by configuration (Apple M4, 60 Hz rAF)

| Config | fps | Frame p50 / p95 / p99 / max (ms) | Work p50 / p95 / p99 / max (ms) | Draw calls mean / max | Triangles mean / max | Minor GC (count, max ms) | Major GC (count, max ms) |
|---|---|---|---|---|---|---|---|
| Chromium, high, 60 s | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0.7 / 1.0 / 1.2 / 3.9 | 24.6 / 29 | 5797 / 8686 | 22, 0.72 | 16, 1.97 |
| Chromium, medium, 45 s | 60 | 16.7 / 16.8 / 16.8 / 16.8 | 0.7 / 1.0 / 1.2 / 2.7 | 17.7 / 21 | 6390 / 8625 | 15, 0.75 | 12, 4.70 |
| Chromium, low, 30 s | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0.6 / 0.9 / 1.0 / 2.7 | 18.6 / 20 | 6093 / 6968 | 8, 0.66 | 7, 2.80 |
| Chromium, medium, 30 fps mode, 30 s | 60 rAF / 30 rendered | 16.7 / 16.7 / 16.8 / 16.8 | 0.1 / 0.8 / 1.0 / 1.6 | 18.3 / 21 | 6064 / 7561 | 10, 0.49 | 4, 1.48 |
| Chromium, high, CPU throttle 4×, 30 s | 60 | 16.7 / 16.7 / 16.8 / 16.8 | 0.4 / 1.0 / 1.2 / 4.1 | 23.9 / 25 | 7487 / 9182 | 12, 1.23 | 7, 2.37 |
| WebKit, medium, 45 s | 60 | 17 / 18 / 18 / 21 | 0 / 1 / 1 / 4 | 20.5 / 23 | 5954 / 7777 | n/a | n/a |

- **WebKit timing:** WebKit's `performance.now()` is clamped to 1 ms, so its percentiles are coarse.
- **Throttled run:** the "CPU throttle 4×" row is reported for completeness. It does **not** model a slow
  phone (see Method).
- **Shader warm-up:** before it was added (`Game.warmup`), the first appearance of some archetypes cost a
  shader compile: a 100 ms frame on Chromium high, 64 ms on WebKit. Both are gone in the final runs above.

### GC in detail

- **Chromium minor GCs:** about 1 every 3–4 s, at most 1.4 ms.
- **Chromium major GCs:** similar frequency on a 6 MB heap, at most 3.8 ms. Not one coincided with a dropped
  frame.
  - The pattern (frequent, tiny heap, never in a busy frame) is consistent with V8 scheduling collections in
    the idle time left in each frame (~15 ms of 16.7 ms). We did not confirm the trigger.
  - Risk: on a phone with less idle time per frame, a 4–20 ms pause could cost a frame. This is listed as a
    risk below.
- **Steady-state allocation, browser:** about 3–7 KB per frame. Most of it is inside three.js's renderer
  (uniform uploads, render-list sorting). Our own sim adds about 1.5 KB per tick of boxed doubles. There are no
  object, array, closure or string allocations in our per-frame code, except when an event creates a pop-up
  string.
- **Node, sim + bot + generation, 5 simulated minutes** (`tools/alloc-check.ts`): 1.4 minor GCs per minute,
  max 0.16 ms, **0 major GCs**. Tick-path allocation median 1.48 KB per tick, all short-lived boxed doubles.
  Regression-guarded by `tests/unit/perf-alloc.test.ts`.

### Chunk generation in a Web Worker (A/B)

Chunks are built in a Web Worker; see ARCHITECTURE §3 and DECISIONS #28. A/B test: same seed, same bot, high
tier, every chunk forced to difficulty 0.9 (dense, repair-heavy content), 60 s, 20 chunk crossings each.

| Generation | Crossing-frame work p50 / max (ms) | All frames work p99 / max (ms) | Frame max (ms) | Worker results / sync fallbacks |
|---|---|---|---|---|
| Main thread (`?gen=sync`) | 1.7 / 5.8 | 1.4 / 5.8 | 16.8 | n/a |
| Web Worker | **1.0 / 3.7** | **1.2 / 3.7** | 16.8 | all from worker / 0 |

A second run gave the same picture: crossing p50 2.1 → 1.2 ms. The worst crossing frame is still ~4–5 ms, so it
is not caused by generation (the same spike appears in both modes).

- **On this M4, players will not notice:** both modes hold 60 fps with no frame above 16.8 ms.
- **Where it matters is slow phones:** with the ×5 estimate, about 4–10 ms per crossing comes off the frame,
  and a repair-heavy worst case (≈ 11 ms) no longer lands on the main thread.

### Simulation and generation cost (Node 22 on M4)

| Metric | Value |
|---|---|
| Sim + perfect bot + oracle, per tick | 1.22 µs average (7.94 simulated hours in 4.2 s) |
| Worst single tick, including chunk generation | 1.69 ms |
| Chunk generation (3000 chunks): mean / p50 / p95 / p99 / max | 0.078 / 0.028 / 0.30 / 0.70 / 2.28 ms |
| Generation attempts per chunk; repair removals per chunk | 1.04; 0.88 |
| Fallback (empty) chunks | 2 of 10,490 (0.02%) |
| Obstacles per 200 m chunk | 22.3 |

These costs are now paid in the generation worker, not in the frame (see the A/B above). On the main thread the
only remaining per-chunk work is packing the request, unpacking the result (a ~35 KB copy) and building the
chunk's instanced meshes.

## Battery

Not measured. Design choices that limit power draw:
- Rendering stops when the tab is hidden (rAF pauses, audio context suspended).
- A 30 fps battery-saver mode.
- Auto quality downgrade, and capped pixel ratio per tier (1.25 / 1.6 / 2).
- No network activity at all.
- The screen wake lock is held only while a run is active.
- About 1 ms of main-thread work per frame on M4.

**Verify on device:** Android `adb shell dumpsys batterystats` over a 10-minute session; iOS Xcode Energy Log via
Safari Web Inspector.

## What is not verified

- Real-phone frame rate, GPU time, thermals and battery. No device was available. Chrome CPU throttling is not a
  valid substitute (see Method).
- Android Chrome on a device. The engine is covered by Chromium with the Pixel 7 profile.
- iOS Safari gameplay. Mobile Safari in the iOS 27 simulator renders the app (`docs/screens/ios-safari-menu.png`).
  Gameplay is covered by the WebKit e2e suite, not on a device.
- Haptics (no vibration hardware in tests).
- Tilt steering (no sensors in tests).
- Audio on devices. Audio was rendered and checked in Chromium only.

