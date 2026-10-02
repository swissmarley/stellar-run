import { describe, expect, it } from 'vitest';
import { PerfectBot } from '../../src/core/bot/bot.ts';
import { StateHasher } from '../../src/core/det/hash.ts';
import { Rng } from '../../src/core/det/rng.ts';
import { createBuildHandler } from '../../src/core/gen/build-handler.ts';
import { CHUNK_BYTES, packChunk, unpackChunk } from '../../src/core/gen/chunk-codec.ts';
import { ProceduralSource } from '../../src/core/gen/generator.ts';
import { hashChunk } from '../../src/core/gen/golden.ts';
import type { ChunkSource } from '../../src/core/gen/source.ts';
import { ChunkData } from '../../src/core/sim/chunk.ts';
import { InputFrame } from '../../src/core/sim/input-frame.ts';
import { RunSim } from '../../src/core/sim/run-sim.ts';
import { computeShipStats, ShipStats } from '../../src/core/sim/ship-stats.ts';
import { DT, TUNING } from '../../src/data/tuning.ts';
import { type GenTransport, WorkerSource } from '../../src/game/gen/worker-source.ts';

type Msg = { run: number; index: number; buf: ArrayBuffer };

/** In-process stand-in for the worker: runs the real build handler; delivery is controlled by the test. */
class FakeTransport implements GenTransport {
  onmessage: GenTransport['onmessage'] = null;
  readonly handler = createBuildHandler();
  readonly queue: { msg: Msg; postedAt: number }[] = [];
  tick = 0;
  post(msg: Msg): void {
    this.handler.handle(msg.buf);
    this.queue.push({ msg, postedAt: this.tick });
  }
  /** Delivers results posted at least `delay` ticks ago (in order, or shuffled with `rng`). */
  pump(delay: number, rng?: Rng): void {
    const ready = this.queue.filter((q) => this.tick - q.postedAt >= delay);
    if (rng) ready.sort(() => rng.float() - 0.5);
    for (const q of ready) {
      this.queue.splice(this.queue.indexOf(q), 1);
      this.onmessage?.({ data: q.msg });
    }
  }
}

function chunkDigest(c: ChunkData): number {
  const h = new StateHasher();
  hashChunk(h, c);
  return h.digest();
}

/** Flies the perfect bot for `seconds` and returns state hashes every second. */
function fly(
  source: ChunkSource,
  seed: number,
  seconds: number,
  onTick?: () => void,
  restartAt = -1,
): number[] {
  const sim = new RunSim();
  const bot = new PerfectBot();
  const f = new InputFrame();
  sim.reset(seed, source, computeShipStats(1, {}, new ShipStats()));
  bot.reset(seed);
  const h = new StateHasher();
  const out: number[] = [];
  for (let t = 0; t < seconds / DT; t++) {
    if (t === restartAt) {
      sim.reset(seed, source, computeShipStats(1, {}, new ShipStats()));
      bot.reset(seed);
    }
    bot.decide(sim, f);
    sim.step(f);
    while (sim.events.shift() >= 0) {
      /* drain */
    }
    onTick?.();
    expect(sim.alive).toBe(true);
    if (t % 120 === 0) {
      h.reset();
      sim.hashInto(h);
      out.push(h.digest());
    }
  }
  return out;
}

describe('chunk codec', () => {
  it('pack → unpack preserves every field of real chunks (drones, wells, repairs, shards)', () => {
    const src = new ProceduralSource();
    src.adaptive = false;
    src.beginRun(31);
    const buf = new ArrayBuffer(CHUNK_BYTES);
    let prev: ChunkData | null = null;
    for (let i = 0; i < 40; i++) {
      const c = new ChunkData();
      c.reset(i, i * TUNING.CHUNK_LENGTH);
      src.generate(i, c.startS, prev, c);
      packChunk(c, buf);
      const back = new ChunkData();
      unpackChunk(buf, back);
      expect(chunkDigest(back)).toBe(chunkDigest(c));
      for (const k of [
        'viable',
        'entry',
        'exit',
        'obsWellG',
        'obsAmpX',
        'obsPeriod',
        'shardY',
        'obsFlags',
      ] as const) {
        expect(Array.from(back[k])).toEqual(Array.from(c[k]));
      }
      for (const k of [
        'vCert',
        'vLatEff',
        'margin',
        'gMax',
        'sliceLen',
        'cruise',
        'biome',
        'repairs',
        'fallback',
        'certified',
      ] as const) {
        expect(back[k]).toBe(c[k]);
      }
      prev = c;
    }
  });
});

describe('worker-backed generation is deterministic regardless of timing', () => {
  const SEED = 9001;
  const SECONDS = 90;
  const reference = fly(new ProceduralSource(), SEED, SECONDS);

  it('results delivered on time: identical sim, every chunk came from the worker', () => {
    const t = new FakeTransport();
    const ws = new WorkerSource(new ProceduralSource(), t);
    const hashes = fly(ws, SEED, SECONDS, () => {
      t.tick++;
      t.pump(30);
    });
    expect(hashes).toEqual(reference);
    expect(ws.stats.fromWorker).toBeGreaterThan(20);
    expect(ws.stats.syncFallbacks).toBe(0);
  });

  it('worker never answers: every chunk falls back to a synchronous build, still identical', () => {
    const t = new FakeTransport();
    const ws = new WorkerSource(new ProceduralSource(), t);
    const hashes = fly(ws, SEED, SECONDS, () => {
      t.tick++;
    });
    expect(hashes).toEqual(reference);
    expect(ws.stats.fromWorker).toBe(0);
    expect(ws.stats.syncFallbacks).toBeGreaterThan(20);
  });

  it('random lateness and out-of-order delivery: identical; late results are discarded', () => {
    const t = new FakeTransport();
    const ws = new WorkerSource(new ProceduralSource(), t);
    const rng = new Rng(5);
    const hashes = fly(ws, SEED, SECONDS, () => {
      t.tick++;
      if (rng.chance(0.02)) t.pump(rng.int(600), rng);
    });
    expect(hashes).toEqual(reference);
    expect(ws.stats.fromWorker + ws.stats.syncFallbacks + ws.inFlight).toBe(ws.stats.requests);
    expect(ws.stats.fromWorker).toBeGreaterThan(0);
    expect(ws.stats.syncFallbacks).toBeGreaterThan(0);
  });

  it('results from a previous run are ignored after a restart', () => {
    const t = new FakeTransport();
    const ws = new WorkerSource(new ProceduralSource(), t);
    const restartAt = Math.round(20 / DT);
    let late = false;
    const restarted = fly(
      ws,
      SEED,
      SECONDS,
      () => {
        t.tick++;
        // Hold results across the restart so some arrive for the old run.
        if (t.tick > restartAt + 200) {
          late = late || t.queue.length > 0;
          t.pump(0);
        }
      },
      restartAt,
    );
    const ref2 = fly(new ProceduralSource(), SEED, SECONDS, undefined, restartAt);
    expect(restarted).toEqual(ref2);
    expect(late).toBe(true);
    expect(ws.stats.stale).toBeGreaterThan(0);
  });
});
