import { dcos, dsin, TWO_PI } from '../det/math.ts';
import { type ChunkData, KIND_DRONE, SHAPE_SPHERE } from './chunk.ts';

/**
 * Swept capsule-vs-obstacle clearance. The ship hitbox is a capsule along the track axis (half-length h,
 * radius r). Over one tick the ship moves linearly; the clearance (surface distance, negative = overlap)
 * is convex in t for static shapes, so golden-section search finds the minimum. No tunnelling at any speed.
 *
 * Allocation-free by construction: V8 boxes doubles that are passed to or returned from non-inlined calls or
 * stored in module-level `let` bindings, so inputs and results travel through Float64Array slots instead.
 * Callers fill SWEEP once per tick (the ship's motion is the same for every obstacle) and then call
 * sweptClearance(chunk, index) per obstacle.
 */

const GR = 0.6180339887498949;
const ITER = 16;

const X0 = 0;
const Y0 = 1;
const S0 = 2;
const DX = 3;
const DY = 4;
const DS = 5;
const R = 6;
const H = 7;
const RES = 8;
const T = 9;
const P = new Float64Array(10);

/** Sweep input: [x0, y0, s0, x1, y1, s1, radius, halfLength]. pointClearance uses x0, y0, s0 only. */
export const SWEEP = new Float64Array(8);
let cc: ChunkData | null = null;
let ci = 0;

/** Result slot of sweptClearance/pointClearance (read it right after the call). */
export const CLEARANCE = new Float64Array(1);
/** Result slots of lateralReach: [x half-extent, y half-extent]. */
export const REACH = new Float64Array(2);

/** Writes the clearance at sweep parameter P[T] into P[RES]. */
function clearanceAt(): void {
  const c = cc!;
  const i = ci;
  const t = P[T]!;
  const x = P[X0]! + P[DX]! * t;
  const y = P[Y0]! + P[DY]! * t;
  const s = P[S0]! + P[DS]! * t;
  const ch = P[H]!;
  const cr = P[R]!;
  let ox = c.obsX[i]!;
  let oy = c.obsY[i]!;
  if (c.obsKind[i] === KIND_DRONE) {
    const th = TWO_PI * ((s - c.obsS[i]!) / c.obsPeriod[i]! + c.obsPhase[i]!);
    const sn = dsin(th);
    ox += c.obsAmpX[i]! * sn;
    oy += c.obsAmpY[i]! * (c.obsOrbit[i] === 1 ? dcos(th) : sn);
  }
  const os = c.obsS[i]!;
  if (c.obsShape[i] === SHAPE_SPHERE) {
    const dx = x - ox;
    const dy = y - oy;
    let gs = (s > os ? s - os : os - s) - ch;
    if (gs < 0) gs = 0;
    P[RES] = Math.sqrt(dx * dx + dy * dy + gs * gs) - c.obsR[i]! - cr;
    return;
  }
  let dx = (x > ox ? x - ox : ox - x) - c.obsHX[i]!;
  if (dx < 0) dx = 0;
  let dy = (y > oy ? y - oy : oy - y) - c.obsHY[i]!;
  if (dy < 0) dy = 0;
  let gs = (s > os ? s - os : os - s) - c.obsHS[i]! - ch;
  if (gs < 0) gs = 0;
  P[RES] = Math.sqrt(dx * dx + dy * dy + gs * gs) - cr;
}

/** Minimum clearance between the moving ship capsule (SWEEP) and obstacle i over one tick → CLEARANCE[0]. */
export function sweptClearance(c: ChunkData, i: number): void {
  cc = c;
  ci = i;
  P[X0] = SWEEP[0]!;
  P[Y0] = SWEEP[1]!;
  P[S0] = SWEEP[2]!;
  P[DX] = SWEEP[3]! - SWEEP[0]!;
  P[DY] = SWEEP[4]! - SWEEP[1]!;
  P[DS] = SWEEP[5]! - SWEEP[2]!;
  P[R] = SWEEP[6]!;
  P[H] = SWEEP[7]!;
  P[T] = 0;
  clearanceAt();
  let best = P[RES]!;
  P[T] = 1;
  clearanceAt();
  if (P[RES]! < best) best = P[RES]!;
  let a = 0;
  let b = 1;
  let p = b - GR * (b - a);
  let q = a + GR * (b - a);
  P[T] = p;
  clearanceAt();
  let fp = P[RES]!;
  P[T] = q;
  clearanceAt();
  let fq = P[RES]!;
  for (let k = 0; k < ITER; k++) {
    if (fp < fq) {
      b = q;
      q = p;
      fq = fp;
      p = b - GR * (b - a);
      P[T] = p;
      clearanceAt();
      fp = P[RES]!;
    } else {
      a = p;
      p = q;
      fp = fq;
      q = a + GR * (b - a);
      P[T] = q;
      clearanceAt();
      fq = P[RES]!;
    }
  }
  if (fp < best) best = fp;
  if (fq < best) best = fq;
  cc = null;
  CLEARANCE[0] = best;
}

/** Clearance with the ship at rest at (SWEEP[0], SWEEP[1], SWEEP[2]) → CLEARANCE[0]. */
export function pointClearance(c: ChunkData, i: number): void {
  cc = c;
  ci = i;
  P[X0] = SWEEP[0]!;
  P[Y0] = SWEEP[1]!;
  P[S0] = SWEEP[2]!;
  P[DX] = 0;
  P[DY] = 0;
  P[DS] = 0;
  P[R] = SWEEP[6]!;
  P[H] = SWEEP[7]!;
  P[T] = 0;
  clearanceAt();
  cc = null;
  CLEARANCE[0] = P[RES]!;
}

/** Conservative lateral half-extents of obstacle i including drone travel → REACH[0] (x), REACH[1] (y). */
export function lateralReach(c: ChunkData, i: number): void {
  const sphere = c.obsShape[i] === SHAPE_SPHERE;
  let rx = sphere ? c.obsR[i]! : c.obsHX[i]!;
  let ry = sphere ? c.obsR[i]! : c.obsHY[i]!;
  if (c.obsKind[i] === KIND_DRONE) {
    rx += c.obsAmpX[i]!;
    ry += c.obsAmpY[i]!;
  }
  REACH[0] = rx;
  REACH[1] = ry;
}
