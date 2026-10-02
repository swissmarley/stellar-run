/**
 * Chunk-generation cost distribution (the only non-constant-time work in the tick path).
 *   node tools/gen-bench.ts [--chunks 3000]
 */

import { ProceduralSource } from '../src/core/gen/generator.ts';
import { ChunkData } from '../src/core/sim/chunk.ts';
import { TUNING } from '../src/data/tuning.ts';

const n = Number(process.argv[process.argv.indexOf('--chunks') + 1] || 3000);
const times: number[] = [];
let repairs = 0;
let attempts = 0;
for (let run = 0; run < Math.ceil(n / 60); run++) {
  const src = new ProceduralSource();
  src.adaptive = false;
  src.beginRun(1000 + run);
  let prev: ChunkData | null = null;
  const a = new ChunkData();
  const b = new ChunkData();
  for (let i = 0; i < 60; i++) {
    const c = i % 2 === 0 ? a : b;
    c.reset(i, i * TUNING.CHUNK_LENGTH);
    const t0 = performance.now();
    src.generate(i, c.startS, prev, c);
    times.push(performance.now() - t0);
    repairs += c.repairs;
    attempts += c.attempts;
    prev = c;
  }
}
times.sort((x, y) => x - y);
const q = (p: number) => +times[Math.min(times.length - 1, Math.floor(times.length * p))]!.toFixed(3);
console.log(
  JSON.stringify({
    chunks: times.length,
    meanMs: +(times.reduce((s, t) => s + t, 0) / times.length).toFixed(3),
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    p99Ms: q(0.99),
    maxMs: q(1),
    repairsPerChunk: +(repairs / times.length).toFixed(2),
    attemptsPerChunk: +(attempts / times.length).toFixed(2),
  }),
);
