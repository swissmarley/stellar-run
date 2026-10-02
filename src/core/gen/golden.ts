import { TUNING } from '../../data/tuning.ts';
import { StateHasher } from '../det/hash.ts';
import { ChunkData } from '../sim/chunk.ts';
import { ProceduralSource } from './generator.ts';
import { ROWS } from './grid.ts';

/**
 * Hash of the first `n` chunks generated for `seed` (non-adaptive difficulty schedule). Used as a golden value
 * in unit tests (Node/V8) and in the e2e suite (Chromium + WebKit) to prove cross-engine determinism.
 */
export function generationHash(seed: number, n: number): number {
  const src = new ProceduralSource();
  src.adaptive = false;
  src.beginRun(seed);
  const h = new StateHasher();
  let prev: ChunkData | null = null;
  for (let i = 0; i < n; i++) {
    const c = new ChunkData();
    c.reset(i, i * TUNING.CHUNK_LENGTH);
    src.generate(i, c.startS, prev, c);
    hashChunk(h, c);
    prev = c;
  }
  return h.digest();
}

/** Folds everything observable about a generated chunk into `h`. */
export function hashChunk(h: StateHasher, c: ChunkData): void {
  h.addInt(c.index);
  h.addInt(c.obsCount);
  h.addInt(c.shardCount);
  h.addInt(c.sliceCount);
  h.addFloat(c.difficulty);
  for (let k = 0; k < c.obsCount; k++) {
    h.addInt(c.obsDef[k]!);
    h.addInt(c.obsFlags[k]!);
    h.addFloat(c.obsX[k]!);
    h.addFloat(c.obsY[k]!);
    h.addFloat(c.obsS[k]!);
    h.addFloat(c.obsScale[k]!);
  }
  for (let k = 0; k < c.shardCount; k++) {
    h.addFloat(c.shardX[k]!);
    h.addFloat(c.shardS[k]!);
  }
  for (let j = 0; j < c.sliceCount * ROWS; j++) h.addInt(c.free[j]!);
}

/** Golden values (update deliberately with `node tools/golden.ts` when generation output changes on purpose). */
export const GOLDEN_GENERATION: Readonly<Record<number, number>> = { 1: 740362528, 2024: 4246383544 };
