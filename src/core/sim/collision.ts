import { type ChunkData, KIND_DRONE, SHAPE_SPHERE } from './chunk.ts';
import { obstaclePos, posOut } from './hazards.ts';

/**
 * Swept capsule-vs-obstacle clearance. The ship hitbox is a capsule along the track axis (half-length h,
 * radius r). Over one tick the ship moves linearly; the clearance (surface distance, negative = overlap)
 * is convex in t for static shapes, so golden-section search finds the minimum. No tunnelling at any speed.
 * Module-level scratch state keeps this allocation-free.
 */

const GR = 0.6180339887498949;
const ITER = 16;

let cx0 = 0;
let cy0 = 0;
let cs0 = 0;
let cdx = 0;
let cdy = 0;
let cds = 0;
let cr = 0;
let ch = 0;
let cc: ChunkData | null = null;
let ci = 0;

function clearanceAt(t: number): number {
  const c = cc!;
  const i = ci;
  const x = cx0 + cdx * t;
  const y = cy0 + cdy * t;
  const s = cs0 + cds * t;
  let ox = c.obsX[i]!;
  let oy = c.obsY[i]!;
  if (c.obsKind[i] === KIND_DRONE) {
    obstaclePos(c, i, s);
    ox = posOut.x;
    oy = posOut.y;
  }
  const os = c.obsS[i]!;
  if (c.obsShape[i] === SHAPE_SPHERE) {
    const dx = x - ox;
    const dy = y - oy;
    let gs = (s > os ? s - os : os - s) - ch;
    if (gs < 0) gs = 0;
    return Math.sqrt(dx * dx + dy * dy + gs * gs) - c.obsR[i]! - cr;
  }
  let dx = (x > ox ? x - ox : ox - x) - c.obsHX[i]!;
  if (dx < 0) dx = 0;
  let dy = (y > oy ? y - oy : oy - y) - c.obsHY[i]!;
  if (dy < 0) dy = 0;
  let gs = (s > os ? s - os : os - s) - c.obsHS[i]! - ch;
  if (gs < 0) gs = 0;
  return Math.sqrt(dx * dx + dy * dy + gs * gs) - cr;
}

/** Minimum clearance between the moving ship capsule and obstacle i over one tick. */
export function sweptClearance(
  c: ChunkData,
  i: number,
  x0: number,
  y0: number,
  s0: number,
  x1: number,
  y1: number,
  s1: number,
  r: number,
  h: number,
): number {
  cc = c;
  ci = i;
  cx0 = x0;
  cy0 = y0;
  cs0 = s0;
  cdx = x1 - x0;
  cdy = y1 - y0;
  cds = s1 - s0;
  cr = r;
  ch = h;
  let best = clearanceAt(0);
  const f1 = clearanceAt(1);
  if (f1 < best) best = f1;
  let a = 0;
  let b = 1;
  let p = b - GR * (b - a);
  let q = a + GR * (b - a);
  let fp = clearanceAt(p);
  let fq = clearanceAt(q);
  for (let k = 0; k < ITER; k++) {
    if (fp < fq) {
      b = q;
      q = p;
      fq = fp;
      p = b - GR * (b - a);
      fp = clearanceAt(p);
    } else {
      a = p;
      p = q;
      fp = fq;
      q = a + GR * (b - a);
      fq = clearanceAt(q);
    }
  }
  if (fp < best) best = fp;
  if (fq < best) best = fq;
  cc = null;
  return best;
}

/** Clearance with the ship at rest at (x, y, s). */
export function pointClearance(
  c: ChunkData,
  i: number,
  x: number,
  y: number,
  s: number,
  r: number,
  h: number,
): number {
  cc = c;
  ci = i;
  cx0 = x;
  cy0 = y;
  cs0 = s;
  cdx = 0;
  cdy = 0;
  cds = 0;
  cr = r;
  ch = h;
  const v = clearanceAt(0);
  cc = null;
  return v;
}

/** Conservative lateral half-extent of obstacle i including drone travel (for broad-phase rejection). */
export function lateralReach(c: ChunkData, i: number): number {
  const base =
    c.obsShape[i] === SHAPE_SPHERE ? c.obsR[i]! : c.obsHX[i]! > c.obsHY[i]! ? c.obsHX[i]! : c.obsHY[i]!;
  if (c.obsKind[i] !== KIND_DRONE) return base;
  const ax = c.obsAmpX[i]!;
  const ay = c.obsAmpY[i]!;
  return base + (ax > ay ? ax : ay);
}
