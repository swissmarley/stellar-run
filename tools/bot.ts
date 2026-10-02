/**
 * Headless simulation bot. Plays seeded runs through the real RunSim and game-flow state machine and
 * reports crashes, softlocks (no forward progress, NaN state, stuck flow) and invalid speeds.
 *
 *   node tools/bot.ts --runs 100 --seed 1 [--ticks 18000] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { DT } from '../src/data/tuning.ts';
import { Rng } from '../src/core/det/rng.ts';
import { HandmadeSource } from '../src/core/gen/handmade.ts';
import { Flow } from '../src/core/meta/flow.ts';
import { EV } from '../src/core/sim/events.ts';
import { BTN_ABILITY, BTN_BOOST, BTN_FOCUS, InputFrame } from '../src/core/sim/input-frame.ts';
import { RunSim } from '../src/core/sim/run-sim.ts';
import { computeShipStats, ShipStats } from '../src/core/sim/ship-stats.ts';

interface Args {
  runs: number;
  seed: number;
  ticks: number;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { runs: 100, seed: 1, ticks: 60 * 300, json: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--runs') a.runs = Number(v);
    else if (k === '--seed') a.seed = Number(v);
    else if (k === '--ticks') a.ticks = Number(v);
    else if (k === '--json') a.json = v ?? null;
  }
  return a;
}

interface RunReport {
  run: number;
  seed: number;
  ship: number;
  ticks: number;
  distance: number;
  died: boolean;
  failures: string[];
}

function playRun(run: number, seed: number, maxTicks: number): RunReport {
  const sim = new RunSim();
  const flow = new Flow();
  const ship = run % 4;
  const stats = computeShipStats(ship, {}, new ShipStats());
  const rng = new Rng(seed ^ 0x5bd1e995);
  const failures: string[] = [];
  const frame = new InputFrame();
  sim.reset(seed, new HandmadeSource(), stats);
  flow.start();
  let died = false;
  let ticks = 0;
  let sx = 0;
  let sy = 0;
  let lastS = -1;
  for (; ticks < maxTicks; ticks++) {
    if (ticks % 15 === 0) {
      sx = rng.range(-1, 1);
      sy = rng.range(-1, 1);
    }
    frame.setSteer(sx, sy);
    frame.buttons = (rng.chance(0.02) ? BTN_BOOST : 0) | (rng.chance(0.01) ? BTN_ABILITY : 0) | (ticks % 400 < 60 ? BTN_FOCUS : 0);
    sim.step(frame);
    for (let i = sim.events.shift(); i >= 0; i = sim.events.shift()) {
      if (sim.events.codes[i] === EV.DEATH) {
        died = true;
        flow.died(false);
      }
    }
    if (!Number.isFinite(sim.s) || !Number.isFinite(sim.x) || !Number.isFinite(sim.y) || !Number.isFinite(sim.score)) {
      failures.push(`NaN/Infinity in sim state at tick ${ticks}`);
      break;
    }
    if (sim.speed > sim.current.vCert + 1e-9) failures.push(`speed ${sim.speed} > vCert ${sim.current.vCert} at tick ${ticks}`);
    if (died) break;
    if (sim.s <= lastS) {
      failures.push(`softlock: no forward progress at tick ${ticks}`);
      break;
    }
    lastS = sim.s;
  }
  if (died) {
    // The flow must reach results and accept a retry: no softlock after death.
    let guard = 0;
    while (flow.state !== 'running' && guard++ < 600) {
      flow.update(DT);
      flow.start();
    }
    if (flow.state !== 'running') failures.push(`flow stuck in ${flow.state} after death`);
  }
  return { run, seed, ship, ticks, distance: sim.s, died, failures };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const t0 = process.hrtime.bigint();
  const reports: RunReport[] = [];
  let crashes = 0;
  for (let r = 0; r < args.runs; r++) {
    const seed = (args.seed * 1_000_003 + r * 7919) >>> 0;
    try {
      reports.push(playRun(r, seed, args.ticks));
    } catch (e) {
      crashes++;
      reports.push({ run: r, seed, ship: r % 4, ticks: 0, distance: 0, died: false, failures: [`crash: ${(e as Error).stack}`] });
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const failed = reports.filter((r) => r.failures.length > 0);
  const totalTicks = reports.reduce((a, r) => a + r.ticks, 0);
  const summary = {
    mode: 'chaos',
    runs: args.runs,
    seed: args.seed,
    crashes,
    failedRuns: failed.length,
    deaths: reports.filter((r) => r.died).length,
    totalTicks,
    simulatedMinutes: +((totalTicks * DT) / 60).toFixed(1),
    meanDistance: +(reports.reduce((a, r) => a + r.distance, 0) / reports.length).toFixed(1),
    wallMs: +ms.toFixed(0),
    usPerTick: +((ms * 1000) / Math.max(1, totalTicks)).toFixed(2),
  };
  console.log(JSON.stringify(summary, null, 2));
  for (const f of failed.slice(0, 10)) console.error(`run ${f.run} (seed ${f.seed}): ${f.failures.join('; ')}`);
  if (args.json) writeFileSync(args.json, JSON.stringify({ summary, reports }, null, 2));
  process.exit(failed.length > 0 || crashes > 0 ? 1 : 0);
}

main();
