# STELLAR RUN

An open-source, portrait, one-handed endless space runner for the web. Thread asteroid belts, ion storms, dead
stations and singularities at ever higher speed. Installable as an app (PWA) and playable offline. No ads, no
tracking, no accounts, nothing sold for money.

**Play:** https://swissmarley.github.io/stellar-run/

| Action | Touch | Keyboard |
|---|---|---|
| Steer | drag (or tilt, in Settings) | arrows / WASD |
| Boost | tap | Space |
| Focus (slow motion) | press and hold | Shift |
| Ability | ✦ button | E |
| Pause | ⏸ button | Esc |

## What's inside

- **Every layout is provably passable.** Each 200 m chunk carries a lattice certificate: every position you
  could legally be in when entering a chunk has a way through it. A bot that follows the certificate has flown
  6+ hours of runs without a crash, and an independent oracle checks every tick.
- **Adaptive difficulty** from your run distance and near-miss rate. Four biomes, four ships with their own
  handling and ability, an upgrade tree, daily missions, cosmetics and leaderboards.
- **Deterministic core:** the same seed gives the same layout on every browser engine (tested on V8 and
  JavaScriptCore).
- **Game feel:** chase camera with FOV kick and banking, hit-stop, slow-motion death, near-miss combo,
  procedural adaptive music, haptics where the browser allows them.
- **Accessibility:** colour-blind-safe palette, high-contrast mode, reduced motion, remappable controls,
  left-handed layout and scalable text.

## Develop

```bash
npm ci
npm run dev                     # http://localhost:5173/stellar-run/
npm run ci                      # lint, unit tests, 100-run bot, build, e2e
```

See [docs/README.md](docs/README.md) for build, test and bench details, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works.

## Licence

MIT for the code. The generated art and audio are CC0. Three.js is MIT.
