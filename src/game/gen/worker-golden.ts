import { StateHasher } from '../../core/det/hash.ts';
import { ProceduralSource } from '../../core/gen/generator.ts';
import { hashChunk } from '../../core/gen/golden.ts';
import { ChunkData } from '../../core/sim/chunk.ts';
import { TUNING } from '../../data/tuning.ts';
import { createGenWorker, WorkerSource } from './worker-source.ts';

/**
 * Computes the golden generation hash with every chunk built by a real worker (no synchronous fallback).
 * Used by the e2e suite to prove worker output is bit-identical to Node's synchronous output.
 */
export async function generationHashViaWorker(
  seed: number,
  n: number,
): Promise<{ hash: number; fromWorker: number; syncFallbacks: number }> {
  const transport = createGenWorker();
  if (!transport) throw new Error('module workers unavailable');
  const gen = new ProceduralSource();
  gen.adaptive = false;
  const src = new WorkerSource(gen, transport);
  src.beginRun(seed);
  const h = new StateHasher();
  let prev: ChunkData | null = null;
  for (let i = 0; i < n; i++) {
    const c = new ChunkData();
    c.reset(i, i * TUNING.CHUNK_LENGTH);
    src.request(i, c.startS, prev, c);
    const t0 = performance.now();
    while (c.pending) {
      if (performance.now() - t0 > 5000) throw new Error(`worker timed out on chunk ${i}`);
      await new Promise((r) => setTimeout(r, 0));
    }
    hashChunk(h, c);
    prev = c;
  }
  return { hash: h.digest(), fromWorker: src.stats.fromWorker, syncFallbacks: src.stats.syncFallbacks };
}
