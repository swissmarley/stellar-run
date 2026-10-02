/**
 * Measures JS heap allocation of the per-tick path (sim + bot) with V8's young generation made large enough
 * that no scavenge happens inside a measurement window. Run:
 *   node --expose-gc --max-semi-space-size=64 tools/alloc-check.ts
 * Prints JSON { bytesPerTickMedian, bytesPerTickMax, windows, generationBytesPerChunk }.
 */
import { getHeapStatistics } from 'node:v8';
import { PerfectBot } from '../src/core/bot/bot.ts';
import { ProceduralSource } from '../src/core/gen/generator.ts';
import { InputFrame } from '../src/core/sim/input-frame.ts';
import { RunSim } from '../src/core/sim/run-sim.ts';
import { computeShipStats, ShipStats } from '../src/core/sim/ship-stats.ts';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc');

const sim = new RunSim();
const bot = new PerfectBot();
const frame = new InputFrame();
sim.reset(4242, new ProceduralSource(), computeShipStats(1, {}, new ShipStats()));
bot.reset(1);

function tick(): void {
  bot.decide(sim, frame);
  sim.step(frame);
  while (sim.events.shift() >= 0) {
    /* drain */
  }
}

for (let i = 0; i < 120 * 30; i++) tick(); // warm-up: JIT, inline caches, first chunks

const WINDOW = 100;
const perTick: number[] = [];
const genBytes: number[] = [];
for (let w = 0; w < 120 && perTick.length < 60; w++) {
  gc();
  const before = sim.chunkIndex;
  const h0 = getHeapStatistics().used_heap_size;
  for (let i = 0; i < WINDOW; i++) tick();
  const h1 = getHeapStatistics().used_heap_size;
  if (sim.chunkIndex === before) perTick.push((h1 - h0) / WINDOW);
  else genBytes.push(h1 - h0);
}
perTick.sort((a, b) => a - b);
const median = perTick[Math.floor(perTick.length / 2)] ?? -1;
console.log(
  JSON.stringify({
    bytesPerTickMedian: +median.toFixed(2),
    bytesPerTickMax: +(perTick[perTick.length - 1] ?? -1).toFixed(2),
    windows: perTick.length,
    generationBytesPerChunkWindow: genBytes.length
      ? Math.round(genBytes.reduce((a, b) => a + b, 0) / genBytes.length)
      : 0,
  }),
);

// Phase 2: real GC behaviour with default heap settings: minor/major collections per simulated minute.
const { PerformanceObserver } = await import('node:perf_hooks');
const gcs: { kind: number; ms: number }[] = [];
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries())
    gcs.push({ kind: (e as unknown as { detail: { kind: number } }).detail.kind, ms: e.duration });
});
obs.observe({ entryTypes: ['gc'] });
const ticks = 120 * 300;
for (let i = 0; i < ticks; i++) tick();
await new Promise((r) => setTimeout(r, 50));
obs.disconnect();
const minor = gcs.filter((g) => g.kind === 1);
const major = gcs.filter((g) => g.kind === 2 || g.kind === 4);
console.log(
  JSON.stringify({
    simulatedSeconds: ticks / 120,
    minorGcPerMinute: +((minor.length / (ticks / 120)) * 60).toFixed(1),
    minorGcMaxMs: +Math.max(0, ...minor.map((g) => g.ms)).toFixed(3),
    majorGcCount: major.length,
    majorGcMaxMs: +Math.max(0, ...major.map((g) => g.ms)).toFixed(3),
  }),
);
