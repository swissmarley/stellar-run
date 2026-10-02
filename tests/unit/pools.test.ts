import { describe, expect, it } from 'vitest';
import { PerfectBot } from '../../src/core/bot/bot.ts';
import { ProceduralSource } from '../../src/core/gen/generator.ts';
import { EventRing } from '../../src/core/sim/events.ts';
import { InputFrame } from '../../src/core/sim/input-frame.ts';
import { RunSim } from '../../src/core/sim/run-sim.ts';
import { computeShipStats, ShipStats } from '../../src/core/sim/ship-stats.ts';
import { DT } from '../../src/data/tuning.ts';
import { Particles } from '../../src/game/render/particles.ts';
import { WorldView } from '../../src/game/render/world-view.ts';

describe('object pools', () => {
  it('chunk slots are reused: 4 ChunkData objects for an entire run', () => {
    const sim = new RunSim();
    const ids = sim.chunks.slice();
    const bot = new PerfectBot();
    const f = new InputFrame();
    sim.reset(3, new ProceduralSource(), computeShipStats(0, {}, new ShipStats()));
    bot.reset(3);
    for (let t = 0; t < 60 / DT; t++) {
      bot.decide(sim, f);
      sim.step(f);
      while (sim.events.shift() >= 0) {
        /* drain */
      }
    }
    expect(sim.chunkIndex).toBeGreaterThan(10);
    expect(sim.chunks.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(sim.chunks[i]).toBe(ids[i]);
  });

  it('event ring overwrites the oldest events instead of growing', () => {
    const ev = new EventRing();
    const codes = ev.codes;
    for (let i = 0; i < 10_000; i++) ev.push(1, i);
    expect(ev.codes).toBe(codes);
    expect(ev.pending).toBe(512);
    expect(ev.dropped).toBeGreaterThan(0);
  });

  it('particle pool wraps its ring; buffers are never reallocated', () => {
    const p = new Particles(256);
    const pos = p.points.geometry.attributes.position!.array;
    for (let i = 0; i < 2000; i++) p.burst(37, 0, 0, i, 5, 0, 0.5, 0xffffff, 0.4, i % 2 === 0);
    expect(p.points.geometry.attributes.position!.array).toBe(pos);
    expect(p.emitted).toBe(2000 * 37);
    expect(p.points.geometry.attributes.position!.count).toBe(256);
  });

  it('world view keeps a fixed set of instanced meshes across many chunks', () => {
    const sim = new RunSim();
    const view = new WorldView();
    const bot = new PerfectBot();
    const f = new InputFrame();
    sim.reset(8, new ProceduralSource(), computeShipStats(2, {}, new ShipStats()));
    bot.reset(8);
    const countMeshes = (): number => {
      let n = 0;
      view.root.traverse((o) => {
        if ((o as { isInstancedMesh?: boolean }).isInstancedMesh) n++;
      });
      return n;
    };
    view.update(sim, sim.s);
    const before = countMeshes();
    for (let t = 0; t < 45 / DT; t++) {
      bot.decide(sim, f);
      sim.step(f);
      while (sim.events.shift() >= 0) {
        /* drain */
      }
      if (t % 2 === 0) view.update(sim, sim.s);
    }
    expect(sim.chunkIndex).toBeGreaterThan(8);
    expect(countMeshes()).toBe(before);
  });
});
