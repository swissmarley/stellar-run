import { OBSTACLES } from '../../data/obstacles.ts';
import { obstacleIndex } from '../../data/registry.ts';
import { HALF_H, HALF_W, TUNING } from '../../data/tuning.ts';
import type { DRange, ElementDef, PatternDef, Range } from '../../data/types.ts';
import { dcos, dsin, lerp, TWO_PI } from '../det/math.ts';
import type { Rng } from '../det/rng.ts';
import type { ChunkData } from '../sim/chunk.ts';
import { placeObstacle, setDronePath } from './place.ts';
import { PROFILE } from './validation-profile.ts';

/** Instantiates pattern layouts into a chunk. All randomness comes from the supplied Rng. */

function dr(r: DRange, d: number): number {
  return lerp(r[0], r[1], d);
}

function rr(rng: Rng, r: Range): number {
  return rng.range(r[0], r[1]);
}

/** Stochastic rounding: 2.3 → 2 (70%) or 3 (30%). */
function count(rng: Rng, v: number): number {
  const f = Math.floor(v);
  return f + (rng.float() < v - f ? 1 : 0);
}

/** Keeps an obstacle's whole influence (body + worst-case ship + margin) inside its chunk. */
function clampS(c: ChunkData, def: number, scale: number, s: number): number {
  const d = OBSTACLES[def]!;
  const body = d.shape === 'sphere' ? d.radius * scale : d.half[2] * scale;
  let infl = body + PROFILE.rMax + TUNING.MARGIN_EASY + PROFILE.hMax + 0.05;
  if (d.well) infl = d.well.range + 0.05;
  if (infl < TUNING.CHUNK_EDGE_CLEARANCE) infl = TUNING.CHUNK_EDGE_CLEARANCE;
  const lo = c.startS + infl;
  const hi = c.endS - infl;
  return s < lo ? lo : s > hi ? hi : s;
}

function put(c: ChunkData, rng: Rng, def: number, x: number, y: number, s: number, scale: number): number {
  return placeObstacle(c, def, x, y, clampS(c, def, scale, s), scale, rng.float());
}

function element(c: ChunkData, e: ElementDef, s0: number, d: number, density: number, rng: Rng): void {
  const def = obstacleIndex(e.obstacle);
  const xr: Range = [-HALF_W - 0.4, HALF_W + 0.4];
  const yr: Range = [-HALF_H - 0.3, HALF_H + 0.3];
  switch (e.type) {
    case 'scatter': {
      const n = count(rng, dr(e.count, d) * density);
      for (let k = 0; k < n; k++) {
        put(c, rng, def, rr(rng, e.x ?? xr), rr(rng, e.y ?? yr), s0 + rr(rng, e.s), rr(rng, e.scale));
      }
      break;
    }
    case 'wall': {
      const holes = Math.max(1, Math.round(dr(e.holes, d)));
      const hr = dr(e.holeRadius, d);
      const hx: number[] = [];
      const hy: number[] = [];
      for (let k = 0; k < holes; k++) {
        hx.push(rng.range(-HALF_W + 1.2, HALF_W - 1.2));
        hy.push(rng.range(-HALF_H + 1, HALF_H - 1));
      }
      for (let y = -HALF_H; y <= HALF_H + 1e-9; y += e.spacing) {
        for (let x = -HALF_W; x <= HALF_W + 1e-9; x += e.spacing) {
          const px = x + rng.range(-e.jitter, e.jitter);
          const py = y + rng.range(-e.jitter, e.jitter);
          let inHole = false;
          for (let k = 0; k < holes; k++) {
            const dx = px - hx[k]!;
            const dy = py - hy[k]!;
            if (dx * dx + dy * dy < hr * hr) inHole = true;
          }
          if (!inHole) put(c, rng, def, px, py, s0 + e.s + rng.range(-0.6, 0.6), rr(rng, e.scale));
        }
      }
      break;
    }
    case 'beam': {
      const n = count(rng, dr(e.count, d) * density);
      let s = s0 + rr(rng, e.s);
      for (let k = 0; k < n; k++) {
        const off = rr(rng, e.offset);
        if (e.axis === 'x') put(c, rng, def, 0, off, s, 1);
        else put(c, rng, def, off, 0, s, 1);
        s += rr(rng, e.spacing);
      }
      break;
    }
    case 'gate': {
      const defV = obstacleIndex(e.obstacleV);
      const w = dr(e.opening, d);
      const hyH = OBSTACLES[def]!.half[1];
      const hxV = OBSTACLES[defV]!.half[0];
      const cx = rng.range(-HALF_W + w / 2 + 0.6, HALF_W - w / 2 - 0.6);
      const cy = rng.range(-HALF_H + w / 2 + 0.4, HALF_H - w / 2 - 0.4);
      const s = s0 + e.s;
      put(c, rng, def, 0, cy + w / 2 + hyH, s, 1);
      put(c, rng, def, 0, cy - w / 2 - hyH, s, 1);
      put(c, rng, defV, cx - w / 2 - hxV, 0, s, 1);
      put(c, rng, defV, cx + w / 2 + hxV, 0, s, 1);
      break;
    }
    case 'slalom': {
      const n = Math.max(2, count(rng, dr(e.count, d) * density));
      const a = s0 + e.s[0];
      const step = (e.s[1] - e.s[0]) / (n - 1);
      const side = rng.sign();
      for (let k = 0; k < n; k++) {
        const amp = rr(rng, e.amplitude) * (k % 2 === 0 ? side : -side);
        const lat = rng.range(-1.2, 1.2);
        if (e.axis === 'x') put(c, rng, def, amp, lat, a + k * step, rr(rng, e.scale));
        else put(c, rng, def, lat, amp * 0.7, a + k * step, rr(rng, e.scale));
      }
      break;
    }
    case 'ring': {
      const n = Math.max(3, count(rng, dr(e.count, d) * density));
      const R = rr(rng, e.radius);
      const gap = dr(e.gap, d);
      const cx = rng.range(-HALF_W + R * 0.6, HALF_W - R * 0.6);
      const cy = rng.range(-HALF_H + R * 0.4, HALF_H - R * 0.4);
      const a0 = rng.float() * TWO_PI;
      const span = TWO_PI - gap;
      for (let k = 0; k < n; k++) {
        const a = a0 + gap / 2 + (span * k) / (n - 1);
        put(
          c,
          rng,
          def,
          cx + R * dcos(a),
          cy + R * dsin(a),
          s0 + e.s + rng.range(-0.8, 0.8),
          rr(rng, e.scale),
        );
      }
      break;
    }
    case 'drone': {
      const n = Math.max(1, count(rng, dr(e.count, d) * density));
      const span = e.s[1] - e.s[0];
      for (let k = 0; k < n; k++) {
        const amp = rr(rng, e.amplitude);
        const s = s0 + e.s[0] + (span * (k + 0.5)) / n;
        let cx = 0;
        let cy = 0;
        if (e.mode === 'x') {
          cx = rng.range(-HALF_W + amp, HALF_W - amp);
          cy = rng.range(-HALF_H + 0.6, HALF_H - 0.6);
        } else if (e.mode === 'y') {
          cx = rng.range(-HALF_W + 0.6, HALF_W - 0.6);
          cy = rng.range(-HALF_H + amp * 0.7, HALF_H - amp * 0.7);
        } else {
          cx = rng.range(-HALF_W + amp, HALF_W - amp);
          cy = rng.range(-HALF_H + amp * 0.7, HALF_H - amp * 0.7);
        }
        const i = put(c, rng, def, cx, cy, s, 1);
        if (i < 0) continue;
        const ax = e.mode === 'y' ? 0 : amp;
        const ay = e.mode === 'x' ? 0 : amp * 0.7;
        setDronePath(c, i, ax, ay, rr(rng, e.period), rng.float(), e.mode === 'orbit');
      }
      break;
    }
    case 'well': {
      put(c, rng, def, rr(rng, e.x), rr(rng, e.y), s0 + e.s, 1);
      break;
    }
  }
}

/** Places one pattern starting at track distance s0. */
export function instantiatePattern(
  c: ChunkData,
  p: PatternDef,
  s0: number,
  d: number,
  density: number,
  rng: Rng,
): void {
  for (const e of p.elements) element(c, e, s0, d, density, rng);
}
