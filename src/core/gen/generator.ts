import { BIOMES } from '../../data/biomes.ts';
import { OBSTACLES } from '../../data/obstacles.ts';
import { PATTERNS } from '../../data/patterns.ts';
import { BIOME_INDEX } from '../../data/registry.ts';
import { TUNING } from '../../data/tuning.ts';
import { hash32 } from '../det/hash.ts';
import { lerp } from '../det/math.ts';
import { Rng } from '../det/rng.ts';
import { Director } from '../director/director.ts';
import { type ChunkData, OF_REMOVED } from '../sim/chunk.ts';
import {
  COLS,
  cellX,
  cellY,
  dilate,
  fillRows,
  nthCell,
  popcountRows,
  ROWS,
  SPAWN_COL,
  SPAWN_ROW,
} from './grid.ts';
import { instantiatePattern } from './layouts.ts';
import { backward, certify, computeSlices, failingEntries, rasterize } from './passability.ts';
import { placeShard } from './place.ts';
import type { ChunkSource } from './source.ts';
import { certifiedSpeed, cruiseFor, PROFILE } from './validation-profile.ts';

/** Generator health counters (diagnostics; reported by the bot and the bench). */
export interface GenStats {
  chunks: number;
  attempts: number;
  removals: number;
  fallbacks: number;
  obstacles: number;
}

const STREAM_GEN = 1;
const scratch = new Int32Array(ROWS);
const scratch2 = new Int32Array(ROWS);
const BIOME_PATTERNS: number[][] = BIOMES.map((b) =>
  PATTERNS.flatMap((p, i) => (p.biomes.includes(b.id) ? [i] : [])),
);

export function biomeFor(index: number): number {
  if (index < TUNING.INTRO_CHUNKS) return 0;
  return Math.floor((index - TUNING.INTRO_CHUNKS) / TUNING.BIOME_CHUNKS) % BIOMES.length;
}

/**
 * Seeded, deterministic chunk generator with a passability certificate for every chunk it emits.
 * Chunk N's random stream is seeded from hash(runSeed, N, attempt), so draws never depend on how many numbers
 * earlier chunks consumed. Difficulty comes from the Director; content is validated and repaired, and the
 * biome's empty fallback pattern is used as a last resort.
 */
export class ProceduralSource implements ChunkSource {
  readonly director: Director;
  readonly stats: GenStats = { chunks: 0, attempts: 0, removals: 0, fallbacks: 0, obstacles: 0 };
  private seed = 0;
  private readonly rng = new Rng();
  private readonly weights = new Float64Array(PATTERNS.length);
  /** When false, chunk feedback does not change difficulty (fixed-difficulty tests/benchmarks). */
  adaptive = true;
  /** Optional fixed difficulty override (tests). */
  fixedDifficulty = -1;

  constructor(director = new Director()) {
    this.director = director;
  }

  beginRun(seed: number): void {
    this.seed = seed >>> 0;
    this.director.beginRun();
  }

  generate(index: number, startS: number, prev: ChunkData | null, out: ChunkData): void {
    const intro = index < TUNING.INTRO_CHUNKS;
    const curve = this.director.curve;
    const d =
      this.fixedDifficulty >= 0
        ? this.fixedDifficulty
        : intro
          ? curve.minD
          : this.director.difficultyFor(startS);
    out.difficulty = d;
    out.cruise = cruiseFor(d);
    out.vCert = certifiedSpeed(out.cruise, prev ? prev.cruise : out.cruise);
    out.margin = lerp(TUNING.MARGIN_EASY, TUNING.MARGIN_HARD, d);
    out.biome = biomeFor(index);
    if (prev) out.entry.set(prev.exit);
    else {
      fillRows(out.entry, 0, 0);
      out.entry[SPAWN_ROW] = 1 << SPAWN_COL;
    }
    this.stats.chunks++;
    let ok = false;
    for (let a = 0; a < TUNING.MAX_GEN_ATTEMPTS && !ok; a++) {
      out.attempts = a + 1;
      this.stats.attempts++;
      this.rng.seed(hash32(this.seed, index, (a << 4) | STREAM_GEN));
      out.clearContent();
      if (!intro) this.fill(out, d);
      computeSlices(out);
      ok = this.certifyWithRepair(out);
    }
    if (!ok) {
      out.clearContent();
      out.fallback = true;
      this.stats.fallbacks++;
      computeSlices(out);
      if (!certify(out)) throw new Error(`fallback chunk ${index} failed certification`);
    }
    this.stats.obstacles += out.obsCount;
    this.placeShards(out);
  }

  /** Fills the chunk with patterns back to back. */
  private fill(c: ChunkData, d: number): void {
    const rng = this.rng;
    const curve = this.director.curve;
    const density = lerp(curve.density[0], curve.density[1], d);
    const gap = lerp(curve.patternGap[0], curve.patternGap[1], d);
    const list = BIOME_PATTERNS[c.biome]!;
    let s = c.startS + TUNING.CHUNK_EDGE_CLEARANCE + curve.leadInSeconds * c.vCert + rng.range(0, 6);
    const end = c.endS - TUNING.CHUNK_EDGE_CLEARANCE;
    for (let guard = 0; guard < 16; guard++) {
      const room = end - s;
      for (let k = 0; k < list.length; k++) {
        const p = PATTERNS[list[k]!]!;
        this.weights[k] = d >= p.minD && d <= p.maxD && p.length <= room ? p.weight : 0;
      }
      const pick = rng.weighted(this.weights, list.length);
      if (pick < 0) break;
      const p = PATTERNS[list[pick]!]!;
      instantiatePattern(c, p, s, d, density, rng);
      s += p.length + gap * rng.range(0.7, 1.3);
    }
  }

  /** Certifies the chunk, removing the most helpful obstacles (up to MAX_REPAIR_REMOVALS) if needed. */
  private certifyWithRepair(c: ChunkData): boolean {
    rasterize(c);
    backward(c);
    let fail = failingEntries(c);
    let removals = 0;
    while (fail > 0 && removals < TUNING.MAX_REPAIR_REMOVALS) {
      const [lo, hi] = this.troubleSlices(c);
      let best = -1;
      let bestFail = fail;
      for (let i = 0; i < c.obsCount; i++) {
        if (!c.isActive(i) || !this.removable(c, i) || !this.touchesSlices(c, i, lo, hi)) continue;
        c.obsFlags[i]! |= OF_REMOVED;
        rasterize(c);
        backward(c);
        const f = failingEntries(c);
        c.obsFlags[i]! &= ~OF_REMOVED;
        if (f < bestFail) {
          bestFail = f;
          best = i;
        }
      }
      if (best < 0) break;
      c.obsFlags[best]! |= OF_REMOVED;
      removals++;
      this.stats.removals++;
      fail = bestFail;
    }
    c.repairs = removals;
    // Final, authoritative certificate on the repaired content (slices stay as computed: still conservative).
    return certify(c);
  }

  private removable(c: ChunkData, i: number): boolean {
    return OBSTACLES[c.obsDef[i]!]!.removable;
  }

  /** Slice window where paths from the failing entry cells die (repair candidates must touch it). */
  private troubleSlices(c: ChunkData): [number, number] {
    const K = c.sliceCount;
    for (let j = 0; j < ROWS; j++) scratch[j] = c.entry[j]! & ~c.viable[j]! & c.free[j]!;
    let kDie = K - 1;
    for (let k = 0; k < K; k++) {
      let any = 0;
      for (let j = 0; j < ROWS; j++) any |= scratch[j]!;
      if (any === 0) {
        kDie = k;
        break;
      }
      dilate(scratch, 0, scratch2, 0);
      const fo = k * ROWS;
      const fn = (k + 1 < K ? k + 1 : k) * ROWS;
      for (let j = 0; j < ROWS; j++) scratch[j] = scratch2[j]! & c.free[fo + j]! & c.free[fn + j]!;
    }
    const lo = kDie - 8 < 0 ? 0 : kDie - 8;
    return [lo, kDie + 1 > K - 1 ? K - 1 : kDie + 1];
  }

  private touchesSlices(c: ChunkData, i: number, lo: number, hi: number): boolean {
    const reach = c.obsSMax(i) - c.obsS[i]! + PROFILE.rMax + c.margin + PROFILE.hMax;
    const klo = Math.floor((c.obsS[i]! - reach - c.startS) / c.sliceLen);
    const khi = Math.floor((c.obsS[i]! + reach - c.startS) / c.sliceLen);
    return khi >= lo && klo <= hi;
  }

  /** Lays shards along one guaranteed-safe lattice path (they double as a racing line). */
  private placeShards(c: ChunkData): void {
    const rng = this.rng;
    const K = c.sliceCount;
    const n = popcountRows(c.entry, 0);
    if (n === 0) return;
    let cell = nthCell(c.entry, 0, rng.int(n));
    let col = cell % COLS;
    let row = (cell - col) / COLS;
    let dc = 0;
    let dr = 0;
    for (let k = 0; k < K; k++) {
      if (rng.chance(0.25)) {
        const pick = rng.int(5);
        dc = pick === 1 ? 1 : pick === 2 ? -1 : 0;
        dr = pick === 3 ? 1 : pick === 4 ? -1 : 0;
      }
      const fo = k * ROWS;
      const vo = (k + 1) * ROWS;
      const ok = (cc: number, rr: number): boolean =>
        cc >= 0 &&
        cc < COLS &&
        rr >= 0 &&
        rr < ROWS &&
        ((c.free[fo + rr]! >>> cc) & 1) === 1 &&
        ((c.viable[vo + rr]! >>> cc) & 1) === 1;
      if (ok(col + dc, row + dr)) {
        col += dc;
        row += dr;
      } else if (!ok(col, row)) {
        // Find any viable neighbour (one must exist because the current cell is viable).
        if (ok(col + 1, row)) col++;
        else if (ok(col - 1, row)) col--;
        else if (ok(col, row + 1)) row++;
        else if (ok(col, row - 1)) row--;
        dc = 0;
        dr = 0;
      }
      cell = row * COLS + col;
      if ((k + 1) % TUNING.SHARD_SPACING_SLICES === 0 && k + 1 < K) {
        placeShard(c, cellX(col), cellY(row), c.startS + (k + 1) * c.sliceLen);
      }
    }
  }

  onChunkCleared(chunk: ChunkData, nearMisses: number): void {
    if (this.adaptive) this.director.onChunkCleared(chunk.length, nearMisses);
  }

  onDeath(distance: number): void {
    if (this.adaptive) this.director.onRunEnd(distance);
  }
}

/** Index of a biome by id (re-export for UI). */
export function biomeIndexOf(id: string): number {
  return BIOME_INDEX[id] ?? 0;
}
