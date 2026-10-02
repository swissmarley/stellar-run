# STELLAR RUN

An open-source, portrait, one-handed endless space runner for the web. Thread asteroid belts, ion storms,
dead stations and singularities. Installable as a PWA, playable offline, no tracking, no ads.

**Play:** https://swissmarley.github.io/stellar-run/

- Drag to steer · tap to boost · press & hold to focus (slow-mo) · ✦ fires your ship's ability
- Keyboard: arrows/WASD steer, Space boost, Shift focus, E ability, Esc pause

```bash
npm ci
npm run dev          # http://localhost:5173/stellar-run/
npm run lint && npm test && npm run bot -- --runs 100 --seed 1
npm run build        # production build in dist/
npm run test:e2e     # Playwright (Chromium + WebKit)
```

See [docs/README.md](docs/README.md) for build, test and architecture details. MIT licensed (code);
generated placeholder art and audio are CC0.
