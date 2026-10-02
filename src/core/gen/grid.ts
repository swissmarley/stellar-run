import { HALF_H, HALF_W, TUNING } from '../../data/tuning.ts';

/**
 * Passability lattice. Each row (fixed y band) is one int32 bitboard; bit i = column i (x band).
 * Cells are closed rectangles of edge CELL tiling [-HALF_W, HALF_W] × [-HALF_H, HALF_H].
 */
export const COLS: number = TUNING.GRID_COLS;
export const ROWS: number = TUNING.GRID_ROWS;
export const CELL: number = TUNING.CELL;
export const X0 = -HALF_W;
export const Y0 = -HALF_H;

/** LOWMASK[n] = n low bits set (n ≤ 31, always a positive int32). */
const LOWMASK: number[] = [];
{
  let m = 0;
  for (let n = 0; n <= 31; n++) {
    LOWMASK.push(m);
    m = ((m << 1) | 1) & 0x7fffffff;
  }
}
export const FULL_ROW: number = LOWMASK[COLS]!;

if (COLS > 31 || COLS % 2 === 0 || ROWS % 2 === 0)
  throw new Error('lattice must have odd dimensions and ≤ 31 columns');

export const SPAWN_COL = (COLS - 1) / 2;
export const SPAWN_ROW = (ROWS - 1) / 2;

/** Bits lo..hi inclusive (clamped to the lattice). */
export function maskRange(lo: number, hi: number): number {
  if (lo < 0) lo = 0;
  if (hi > COLS - 1) hi = COLS - 1;
  if (lo > hi) return 0;
  return LOWMASK[hi + 1]! & ~LOWMASK[lo]!;
}

export function cellX(col: number): number {
  return X0 + (col + 0.5) * CELL;
}

export function cellY(row: number): number {
  return Y0 + (row + 0.5) * CELL;
}

export function colOf(x: number): number {
  const c = Math.floor((x - X0) / CELL);
  return c < 0 ? 0 : c >= COLS ? COLS - 1 : c;
}

export function rowOf(y: number): number {
  const r = Math.floor((y - Y0) / CELL);
  return r < 0 ? 0 : r >= ROWS ? ROWS - 1 : r;
}

/** Population count of a 32-bit integer (SWAR). */
export function popcount32(v: number): number {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Number of set cells in the ROWS rows starting at offset o. */
export function popcountRows(a: Int32Array, o: number): number {
  let n = 0;
  for (let j = 0; j < ROWS; j++) n += popcount32(a[o + j]!);
  return n;
}

/** dst[do..] = 4-neighbour dilation of src[so..] (each cell plus left/right/up/down), clipped to the lattice. */
export function dilate(src: Int32Array, so: number, dst: Int32Array, dO: number): void {
  for (let j = 0; j < ROWS; j++) {
    const r = src[so + j]!;
    let v = r | (r << 1) | (r >>> 1);
    if (j > 0) v |= src[so + j - 1]!;
    if (j < ROWS - 1) v |= src[so + j + 1]!;
    dst[dO + j] = v & FULL_ROW;
  }
}

export function fillRows(a: Int32Array, o: number, v: number): void {
  for (let j = 0; j < ROWS; j++) a[o + j] = v;
}

export function isEmptyRows(a: Int32Array, o: number): boolean {
  for (let j = 0; j < ROWS; j++) if (a[o + j] !== 0) return false;
  return true;
}

export function hasCell(a: Int32Array, o: number, col: number, row: number): boolean {
  return ((a[o + row]! >>> col) & 1) === 1;
}

/** Index of the n-th set cell (row-major) in rows at offset o, as row*COLS+col; -1 if fewer than n+1 cells. */
export function nthCell(a: Int32Array, o: number, n: number): number {
  for (let j = 0; j < ROWS; j++) {
    let r = a[o + j]!;
    while (r !== 0) {
      const low = r & -r;
      const col = 31 - Math.clz32(low);
      if (n === 0) return j * COLS + col;
      n--;
      r &= r - 1;
    }
  }
  return -1;
}
