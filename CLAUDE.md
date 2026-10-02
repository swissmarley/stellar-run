# STELLAR RUN

Open-source (MIT), portrait, one-handed 3D endless space runner for the web: a PWA deployed to GitHub Pages.
TypeScript + Three.js (the only runtime dependency) + Vite. Node ≥ 22.18 (runs `.ts` tools natively).

## Commands
- `npm run dev`: dev server on :5173 (`/stellar-run/`)
- `npm run lint`: Biome + `tsc` (must be clean)
- `npm test`: Vitest unit tests (`tests/unit`)
- `npm run test:e2e`: Playwright (Chromium + WebKit) against a production preview
- `npm run bot -- --runs 100 --seed 1`: headless simulation bot (must report 0 failures)
- `npm run build`: production build to `dist/`
- `npm run bench`: performance bench, writes `docs/perf/*.json`
- `npm run docs:tuning`: regenerates `docs/TUNING.md` from `src/data`
- `npm run ci`: everything CI runs

## Architecture map
- `src/core/`: pure, deterministic, DOM-free logic (sim, procgen and passability proof, director, bot, meta).
  It must not import `three`, use `Math.random`, `Math.sin/cos/pow/exp/log/...`, `**`, `Date` or `performance`.
  `tests/unit/architecture.test.ts` enforces this.
- `src/data/`: all gameplay data and constants (ships, obstacles, patterns, biomes, difficulty, upgrades...).
- `src/game/`: presentation: Three.js rendering, camera, input, audio, HUD; owns the fixed-step loop.
- `src/services/` + `src/ui/`: save/settings/consent/haptics/leaderboard services, and DOM screens.
- `tools/`: bot, bench, doc generators. `docs/`: PLAN, ARCHITECTURE, TUNING, DECISIONS, PERF, README.

## Conventions
- Sim runs at fixed 120 Hz; hot state lives in typed arrays (V8 boxes doubles in fields/args). No object, array, closure or string allocation in per-tick or per-frame paths.
- Every gameplay constant lives in `src/data/` and is documented (TUNING.md is generated from it).
- Imports use explicit `.ts` extensions (Node type stripping); only erasable TS syntax (no enums or namespaces).
- Record non-obvious choices in `docs/DECISIONS.md`. Commits are one per milestone or feature, with clear messages.
- No network calls, analytics or third-party origins (CSP enforces this). Monetisation is in-game currency only.

## Off-limits
- Do not edit `dist/`, `node_modules/`, or anything outside this repository.
- Do not add runtime dependencies or commit keys/secrets.
