import { DT, TUNING } from '../../data/tuning.ts';
import { type ChunkData, KIND_DRONE, SHAPE_SPHERE } from '../sim/chunk.ts';
import { droneLipschitz, obstaclePos, posOut } from '../sim/hazards.ts';
import {
  CELL,
  COLS,
  colOf,
  dilate,
  FULL_ROW,
  fillRows,
  isEmptyRows,
  maskRange,
  ROWS,
  rowOf,
  X0,
  Y0,
} from './grid.ts';
import { PROFILE } from './validation-profile.ts';

/**
 * The passability certificate (see docs/ARCHITECTURE.md, "Provably passable chunks").
 *
 * The chunk is cut into K slices along the track. During slice k (ship centre s ∈ [s_k, s_{k+1}]) a lattice
 * ship may move from its cell to a 4-neighbour (or stay); slices are long enough that even the slowest ship at
 * the certified speed can do so with two ticks of slack for tick quantisation. F_k marks cells whose whole
 * rectangle keeps the worst-case hitbox at least `margin` away from every obstacle during the slice.
 *
 *   forward  A_0 = E ∩ F_0,  A_{k+1} = D(A_k) ∩ F_k ∩ F_{k+1},  exit = D(A_{K-1}) ∩ F_{K-1}
 *   backward V_K = FULL,     V_k = F_k ∩ D(F_k ∩ V_{k+1})
 *
 * A chunk is certified iff E ⊆ V_0: every lattice-reachable cell at the chunk boundary has a path through the
 * chunk. Since exit ⊆ next chunk's E, this holds for the whole run by induction.
 */

const EPS = 1e-9;
/**
 * The proof assumes 99% of the slowest lateral speed, so input quantisation and float rounding can never
 * make a lattice move miss its slice by a hair.
 */
export const PROOF_SPEED_FACTOR = 0.99;
const scratchA = new Int32Array(ROWS);
const scratchB = new Int32Array(ROWS);
const scratchC = new Int32Array(ROWS);

/** Required slice length for a chunk (metres). */
export function requiredSliceLength(vCert: number, vLatEff: number): number {
  return vCert * (CELL / vLatEff + 2 * DT);
}

/** Chooses the slice structure (depends on vCert and gravity, so call after content is placed). */
export function computeSlices(c: ChunkData): void {
  const vLatEff = PROOF_SPEED_FACTOR * (PROFILE.vLatMin - c.gMax * c.vCert);
  c.vLatEff = vLatEff > 0.25 * PROFILE.vLatMin ? vLatEff : 0.25 * PROFILE.vLatMin;
  const req = requiredSliceLength(c.vCert, c.vLatEff);
  let k = Math.floor(c.length / req);
  if (k < 1) k = 1;
  if (k > TUNING.MAX_SLICES) k = TUNING.MAX_SLICES;
  c.sliceCount = k;
  c.sliceLen = c.length / k;
}

/** Clears cells within distance `rho` of the lateral rectangle [ox±hx]×[oy±hy] in row-set at offset o. */
function blockRoundedRect(
  free: Int32Array,
  o: number,
  ox: number,
  oy: number,
  hx: number,
  hy: number,
  rho: number,
): void {
  const r = rho + EPS;
  const jlo = rowOf(oy - hy - r - CELL);
  const jhi = rowOf(oy + hy + r + CELL);
  for (let j = jlo; j <= jhi; j++) {
    const y0 = Y0 + j * CELL;
    const y1 = y0 + CELL;
    let dy = y0 - (oy + hy);
    const dy2 = oy - hy - y1;
    if (dy2 > dy) dy = dy2;
    if (dy < 0) dy = 0;
    if (dy > r) continue;
    const w = Math.sqrt(r * r - dy * dy);
    const a = ox - hx - w;
    const b = ox + hx + w;
    const ilo = Math.ceil((a - X0) / CELL - 1);
    const ihi = Math.floor((b - X0) / CELL);
    const m = maskRange(ilo, ihi);
    if (m !== 0) free[o + j] = free[o + j]! & ~m;
  }
}

/** Rasterises every active obstacle into the free masks F_0..F_{K-1}. */
export function rasterize(c: ChunkData): void {
  const K = c.sliceCount;
  const L = c.sliceLen;
  const h = PROFILE.hMax;
  const r = PROFILE.rMax;
  const m = c.margin;
  for (let k = 0; k < K; k++) fillRows(c.free, k * ROWS, FULL_ROW);
  for (let i = 0; i < c.obsCount; i++) {
    if (!c.isActive(i)) continue;
    const sphere = c.obsShape[i] === SHAPE_SPHERE;
    const os = c.obsS[i]!;
    const hs = sphere ? 0 : c.obsHS[i]!;
    // Total radius of the inflated shape (sphere: R + r + m; box: r + m around the box).
    const inflate = sphere ? c.obsR[i]! + r + m : r + m;
    const drone = c.obsKind[i] === KIND_DRONE;
    const lip = drone ? droneLipschitz(c, i) : 0;
    const reachS = hs + inflate + h;
    let klo = Math.floor((os - reachS - c.startS) / L);
    let khi = Math.floor((os + reachS - c.startS) / L);
    if (klo < 0) klo = 0;
    if (khi > K - 1) khi = K - 1;
    for (let k = klo; k <= khi; k++) {
      const sa = c.startS + k * L;
      const sb = sa + L;
      // Gap along s between the obstacle body [os−hs, os+hs] and the ship capsule's span [sa−h, sb+h].
      let gap = os - hs - (sb + h);
      const g2 = sa - h - (os + hs);
      if (g2 > gap) gap = g2;
      if (gap < 0) gap = 0;
      if (gap >= inflate) continue;
      let rho = Math.sqrt(inflate * inflate - gap * gap);
      let ox = c.obsX[i]!;
      let oy = c.obsY[i]!;
      if (drone) {
        obstaclePos(c, i, (sa + sb) * 0.5);
        ox = posOut.x;
        oy = posOut.y;
        rho += lip * L * 0.5;
      }
      if (sphere) blockRoundedRect(c.free, k * ROWS, ox, oy, 0, 0, rho);
      else blockRoundedRect(c.free, k * ROWS, ox, oy, c.obsHX[i]!, c.obsHY[i]!, rho);
    }
  }
}

/** Backward-viable sets V_0..V_K (V_K = FULL). */
export function backward(c: ChunkData): void {
  const K = c.sliceCount;
  fillRows(c.viable, K * ROWS, FULL_ROW);
  for (let k = K - 1; k >= 0; k--) {
    const fo = k * ROWS;
    const vn = (k + 1) * ROWS;
    for (let j = 0; j < ROWS; j++) scratchA[j] = c.free[fo + j]! & c.viable[vn + j]!;
    dilate(scratchA, 0, scratchB, 0);
    for (let j = 0; j < ROWS; j++) c.viable[fo + j] = c.free[fo + j]! & scratchB[j]!;
  }
}

/** Forward reachable set from `start` rows; writes positions at the chunk end into `out`. Returns false if empty. */
export function forward(c: ChunkData, start: Int32Array, out: Int32Array): boolean {
  const K = c.sliceCount;
  for (let j = 0; j < ROWS; j++) scratchA[j] = start[j]! & c.free[j]!;
  for (let k = 0; k < K; k++) {
    dilate(scratchA, 0, scratchB, 0);
    const fo = k * ROWS;
    if (k + 1 < K) {
      const fn = (k + 1) * ROWS;
      for (let j = 0; j < ROWS; j++) scratchA[j] = scratchB[j]! & c.free[fo + j]! & c.free[fn + j]!;
    } else {
      for (let j = 0; j < ROWS; j++) scratchA[j] = scratchB[j]! & c.free[fo + j]!;
    }
  }
  for (let j = 0; j < ROWS; j++) out[j] = scratchA[j]!;
  return !isEmptyRows(out, 0);
}

/** Number of entry cells that are NOT viable (0 = certified). */
export function failingEntries(c: ChunkData): number {
  let n = 0;
  for (let j = 0; j < ROWS; j++) {
    let v = c.entry[j]! & ~c.viable[j]!;
    while (v !== 0) {
      v &= v - 1;
      n++;
    }
  }
  return n;
}

/** Full certificate computation: rasterise, backward pass, entry check, exit set. */
export function certify(c: ChunkData): boolean {
  rasterize(c);
  backward(c);
  const ok = failingEntries(c) === 0 && !isEmptyRows(c.entry, 0);
  c.certified = ok && forward(c, c.entry, c.exit);
  return c.certified;
}

/** Nearest cell (Manhattan rings via dilation) to (x, y) contained in mask rows at offset o; -1 if none. */
export function nearestCellIn(mask: Int32Array, o: number, x: number, y: number): number {
  const col = colOf(x);
  const row = rowOf(y);
  fillRows(scratchC, 0, 0);
  scratchC[row] = 1 << col;
  for (let ring = 0; ring < COLS + ROWS; ring++) {
    for (let j = 0; j < ROWS; j++) {
      const hit = scratchC[j]! & mask[o + j]!;
      if (hit !== 0) {
        // Prefer the column closest to the start column within this ring.
        let best = -1;
        let bestD = 1e9;
        let v = hit;
        while (v !== 0) {
          const low = v & -v;
          const cc = 31 - Math.clz32(low);
          const d = cc > col ? cc - col : col - cc;
          if (d < bestD) {
            bestD = d;
            best = cc;
          }
          v &= v - 1;
        }
        return j * COLS + best;
      }
    }
    dilate(scratchC, 0, scratchB, 0);
    for (let j = 0; j < ROWS; j++) scratchC[j] = scratchB[j]!;
  }
  return -1;
}
