import { describe, expect, it } from 'vitest';
import { HumanBot, PerfectBot } from '../../src/core/bot/bot.ts';
import { ProceduralSource } from '../../src/core/gen/generator.ts';
import { ROWS } from '../../src/core/gen/grid.ts';
import { Oracle } from '../../src/core/gen/oracle.ts';
import { EV } from '../../src/core/sim/events.ts';
import { BTN_REVIVE, InputFrame } from '../../src/core/sim/input-frame.ts';
import { RunSim } from '../../src/core/sim/run-sim.ts';
import { computeShipStats, ShipStats } from '../../src/core/sim/ship-stats.ts';
import { DT } from '../../src/data/tuning.ts';

describe('bots through the real sim', () => {
  for (let ship = 0; ship < 4; ship++) {
    it(`perfect bot never dies and the oracle confirms every promise (ship ${ship})`, () => {
      const sim = new RunSim();
      const bot = new PerfectBot();
      const oracle = new Oracle(6);
      const frame = new InputFrame();
      sim.reset(1000 + ship, new ProceduralSource(), computeShipStats(ship, {}, new ShipStats()));
      bot.reset(ship);
      for (let t = 0; t < 90 / DT; t++) {
        bot.decide(sim, frame);
        sim.step(frame);
        oracle.check(sim);
        while (sim.events.shift() >= 0) {
          /* drain */
        }
        expect(sim.alive).toBe(true);
      }
      expect(oracle.violations, oracle.lastViolation).toBe(0);
      expect(bot.planFailures).toBe(0);
      expect(sim.s).toBeGreaterThan(3000);
    });
  }

  it('human bot dies, revives into a viable cell, and keeps going', () => {
    const sim = new RunSim();
    const bot = new HumanBot();
    bot.noise = 0.8;
    bot.lapseRate = 0.02;
    const frame = new InputFrame();
    sim.reset(5, new ProceduralSource(), computeShipStats(2, {}, new ShipStats()));
    bot.reset(5);
    let died = false;
    for (let t = 0; t < 240 / DT && !died; t++) {
      bot.decide(sim, frame);
      sim.step(frame);
      for (let i = sim.events.shift(); i >= 0; i = sim.events.shift())
        if (sim.events.codes[i] === EV.DEATH) died = true;
    }
    expect(died).toBe(true);
    frame.clear();
    frame.buttons = BTN_REVIVE;
    sim.step(frame);
    expect(sim.alive).toBe(true);
    expect(sim.ghostTime).toBeGreaterThan(0);
    const c = sim.current;
    const k = Math.min(c.sliceCount, Math.floor((sim.s - c.startS) / c.sliceLen) + 1);
    const col = Math.round((sim.x + 4.65) / 0.3 - 0.5);
    const row = Math.round((sim.y + 3.15) / 0.3 - 0.5);
    expect((c.viable[k * ROWS + row]! >>> col) & 1).toBe(1);
  });
});
