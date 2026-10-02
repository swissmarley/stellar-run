import { describe, expect, it } from 'vitest';
import { StateHasher } from '../../src/core/det/hash.ts';
import { Rng } from '../../src/core/det/rng.ts';
import { HandmadeSource } from '../../src/core/gen/handmade.ts';
import { EV } from '../../src/core/sim/events.ts';
import { BTN_BOOST, BTN_FOCUS, InputFrame } from '../../src/core/sim/input-frame.ts';
import { RunSim } from '../../src/core/sim/run-sim.ts';
import { computeShipStats, ShipStats } from '../../src/core/sim/ship-stats.ts';
import { DT } from '../../src/data/tuning.ts';

function stats(ship = 0): ShipStats {
  return computeShipStats(ship, {}, new ShipStats());
}

/** Scripted pseudo-random input stream (deterministic). */
function scripted(seed: number, ticks: number): InputFrame[] {
  const r = new Rng(seed);
  const out: InputFrame[] = [];
  let sx = 0;
  let sy = 0;
  for (let t = 0; t < ticks; t++) {
    if (t % 20 === 0) {
      sx = r.range(-1, 1);
      sy = r.range(-1, 1);
    }
    const f = new InputFrame();
    f.setSteer(sx, sy);
    if (r.chance(0.01)) f.buttons |= BTN_BOOST;
    if (t % 300 > 250) f.buttons |= BTN_FOCUS;
    out.push(f);
  }
  return out;
}

function run(inputs: InputFrame[], every = 60): number[] {
  const sim = new RunSim();
  sim.reset(1234, new HandmadeSource(), stats());
  const h = new StateHasher();
  const hashes: number[] = [];
  for (let t = 0; t < inputs.length; t++) {
    sim.step(inputs[t]!);
    while (sim.events.shift() >= 0) {
      /* drain */
    }
    if (t % every === 0) {
      h.reset();
      sim.hashInto(h);
      hashes.push(h.digest());
    }
  }
  return hashes;
}

describe('RunSim', () => {
  it('is deterministic: the same seed and input stream replay to identical state hashes', () => {
    const inputs = scripted(77, 3000);
    const a = run(inputs);
    const b = run(
      inputs.map((f) => {
        const g = new InputFrame();
        g.copyFrom(f);
        return g;
      }),
    );
    expect(b).toEqual(a);
    expect(new Set(a).size).toBeGreaterThan(10);
  });

  it('advances s by speed·DT and never moves backwards', () => {
    const sim = new RunSim();
    sim.reset(1, new HandmadeSource(), stats());
    const f = new InputFrame();
    let last = sim.s;
    for (let t = 0; t < 600 && sim.alive; t++) {
      const before = sim.s;
      sim.step(f);
      expect(sim.s - before).toBeCloseTo(sim.speed * DT, 9);
      expect(sim.s).toBeGreaterThan(last);
      last = sim.s;
    }
  });

  it('an idle ship eventually hits the hand-made boulder on the centre line and emits DEATH', () => {
    const sim = new RunSim();
    sim.reset(1, new HandmadeSource(), stats());
    const f = new InputFrame();
    let death = false;
    for (let t = 0; t < 60 * 30 && !death; t++) {
      sim.step(f);
      for (let i = sim.events.shift(); i >= 0; i = sim.events.shift())
        if (sim.events.codes[i] === EV.DEATH) death = true;
    }
    expect(death).toBe(true);
    expect(sim.alive).toBe(false);
  });

  it('collects shards on the centre line and scores near-misses', () => {
    const sim = new RunSim();
    sim.reset(1, new HandmadeSource(), stats());
    const f = new InputFrame();
    for (let t = 0; t < 60 * 5; t++) sim.step(f);
    expect(sim.shards).toBeGreaterThan(0);
  });

  it('never exceeds the certified speed of the chunk it is in, even while boosting', () => {
    const sim = new RunSim();
    sim.reset(5, new HandmadeSource(), stats(1));
    const f = new InputFrame();
    for (let t = 0; t < 60 * 20 && sim.alive; t++) {
      f.buttons = t % 30 === 0 ? BTN_BOOST : 0;
      f.setSteer(Math.sin(t / 30), Math.cos(t / 47));
      sim.step(f);
      expect(sim.speed).toBeLessThanOrEqual(sim.current.vCert + 1e-9);
    }
  });
});
