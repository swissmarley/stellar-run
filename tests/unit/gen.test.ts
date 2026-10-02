import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/det/rng.ts';
import { ProceduralSource } from '../../src/core/gen/generator.ts';
import { GOLDEN_GENERATION, generationHash } from '../../src/core/gen/golden.ts';
import { CELL, COLS, FULL_ROW, fillRows, ROWS, X0, Y0 } from '../../src/core/gen/grid.ts';
import { Oracle } from '../../src/core/gen/oracle.ts';
import { certify, computeSlices } from '../../src/core/gen/passability.ts';
import { placeObstacle } from '../../src/core/gen/place.ts';
import { certifiedSpeed, cruiseFor, PROFILE } from '../../src/core/gen/validation-profile.ts';
import { ChunkData } from '../../src/core/sim/chunk.ts';
import { obstacleIndex } from '../../src/data/registry.ts';
import { TUNING } from '../../src/data/tuning.ts';

/** Generates `n` consecutive chunks for a seed at a fixed (non-adaptive) difficulty schedule. */
function generateRun(seed: number, n: number, fixedD = -1): ChunkData[] {
  const src = new ProceduralSource();
  src.adaptive = false;
  src.fixedDifficulty = fixedD;
  src.beginRun(seed);
  const out: ChunkData[] = [];
  let prev: ChunkData | null = null;
  for (let i = 0; i < n; i++) {
    const c = new ChunkData();
    c.reset(i, i * TUNING.CHUNK_LENGTH);
    src.generate(i, c.startS, prev, c);
    out.push(c);
    prev = c;
  }
  return out;
}

describe('chunk generator determinism', () => {
  it('same seed → bit-identical chunks; different seed → different chunks', () => {
    const a = generationHash(42, 120);
    expect(generationHash(42, 120)).toBe(a);
    expect(generationHash(43, 120)).not.toBe(a);
  });

  it('chunk N does not depend on how many chunks were generated after it (stream isolation)', () => {
    expect(generationHash(9, 10)).toBe(generationHash(9, 10));
    const long = generateRun(9, 40)[9]!;
    const short = generateRun(9, 10)[9]!;
    expect(Array.from(long.obsX.slice(0, long.obsCount))).toEqual(
      Array.from(short.obsX.slice(0, short.obsCount)),
    );
  });

  it('matches the recorded golden hashes (cross-version determinism; also checked in Chromium + WebKit e2e)', () => {
    for (const [seed, want] of Object.entries(GOLDEN_GENERATION))
      expect(generationHash(Number(seed), 200)).toBe(want);
  });
});

describe('passability certificate', () => {
  function emptyChunk(d = 0.5): ChunkData {
    const c = new ChunkData();
    c.reset(5, 1000);
    c.difficulty = d;
    c.cruise = cruiseFor(d);
    c.vCert = certifiedSpeed(c.cruise, c.cruise);
    c.margin = 0.2;
    fillRows(c.entry, 0, FULL_ROW);
    return c;
  }

  it('accepts an empty corridor from every entry cell', () => {
    const c = emptyChunk();
    computeSlices(c);
    expect(certify(c)).toBe(true);
  });

  it('rejects a chunk sealed by a wall of beams across the full height', () => {
    const c = emptyChunk();
    const beam = obstacleIndex('ion_beam');
    for (let y = -3.2; y <= 3.2; y += 0.4) placeObstacle(c, beam, 0, y, 1100, 1, 0);
    computeSlices(c);
    expect(certify(c)).toBe(false);
  });

  it('rejects a window too far to reach from the opposite corner, accepts it with enough lead-in', () => {
    const make = (s: number): boolean => {
      const c = emptyChunk(1);
      const h = obstacleIndex('girder_h');
      const v = obstacleIndex('girder_v');
      // A 2.4 m window on the right edge.
      placeObstacle(c, h, 0, 1.2 + 0.32, s, 1, 0);
      placeObstacle(c, h, 0, -1.2 - 0.32, s, 1, 0);
      placeObstacle(c, v, 3.0 - 1.2 - 0.32, 0, s, 1, 0);
      computeSlices(c);
      return certify(c);
    };
    expect(make(1012)).toBe(false);
    expect(make(1185)).toBe(true);
  });

  it('every generated chunk is certified and every entry cell is viable', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const c of generateRun(seed, 80)) {
        expect(c.certified).toBe(true);
        for (let j = 0; j < ROWS; j++) expect(c.entry[j]! & ~c.viable[j]!).toBe(0);
      }
    }
  });

  it('free cells are geometrically safe: random points/positions inside free cells keep the worst-case hitbox ≥ margin away', () => {
    const rng = new Rng(2025);
    let samples = 0;
    for (const seed of [11, 12, 13]) {
      for (const d of [0.1, 0.5, 1]) {
        for (const c of generateRun(seed, 25, d)) {
          for (let n = 0; n < 400; n++) {
            const k = rng.int(c.sliceCount);
            const j = rng.int(ROWS);
            const i = rng.int(COLS);
            if (((c.free[k * ROWS + j]! >>> i) & 1) === 0) continue;
            const x = X0 + (i + rng.float()) * CELL;
            const y = Y0 + (j + rng.float()) * CELL;
            const s = c.startS + (k + rng.float()) * c.sliceLen;
            for (let o = 0; o < c.obsCount; o++) {
              if (!c.isActive(o)) continue;
              const clear = Oracle.clearance(c, o, x, y, s, PROFILE.rMax, PROFILE.hMax);
              expect(clear, `chunk ${c.index} obstacle ${o}`).toBeGreaterThanOrEqual(c.margin - 1e-9);
            }
            samples++;
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(5000);
  });

  it('bitboard viability agrees with an independent brute-force search', () => {
    for (const c of generateRun(77, 30, 0.8)) {
      const K = c.sliceCount;
      const free = (k: number, i: number, j: number): boolean =>
        i >= 0 && i < COLS && j >= 0 && j < ROWS && ((c.free[k * ROWS + j]! >>> i) & 1) === 1;
      // Plain boolean arrays, walked forward from each cell.
      let reach: boolean[] = [];
      for (let start = 0; start < COLS * ROWS; start += 7) {
        const si = start % COLS;
        const sj = (start - si) / COLS;
        reach = new Array(COLS * ROWS).fill(false);
        if (!free(0, si, sj)) continue;
        reach[start] = true;
        for (let k = 0; k < K; k++) {
          const next = new Array(COLS * ROWS).fill(false);
          for (let q = 0; q < COLS * ROWS; q++) {
            if (!reach[q]) continue;
            const qi = q % COLS;
            const qj = (q - qi) / COLS;
            for (const [di, dj] of [
              [0, 0],
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const) {
              const ni = qi + di;
              const nj = qj + dj;
              if (!free(k, ni, nj)) continue;
              if (k + 1 < K && !free(k + 1, ni, nj)) continue;
              next[nj * COLS + ni] = true;
            }
          }
          reach = next;
        }
        const brute = reach.some(Boolean);
        const bits = ((c.viable[sj]! >>> si) & 1) === 1;
        expect(bits, `chunk ${c.index} cell ${si},${sj}`).toBe(brute);
      }
    }
  });
});
