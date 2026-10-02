/**
 * Headless simulation bot: plays seeded runs through the real RunSim, generator, director and game-flow state
 * machine, and fails (exit 1) on any crash, softlock, impossible layout or broken certificate.
 *
 *   node tools/bot.ts --runs 100 --seed 1 [--mode both|perfect|human] [--seconds 240] [--json out.json]
 *
 * perfect: follows the certificate's lattice path; must NEVER die; every tick is re-checked by the oracle.
 * human:   delayed, noisy, lapsing player; deaths expected; exercises revive, flow and the director.
 */
import { writeFileSync } from 'node:fs';
import { HumanBot, PerfectBot } from '../src/core/bot/bot.ts';
import { Director } from '../src/core/director/director.ts';
import { ProceduralSource } from '../src/core/gen/generator.ts';
import { ROWS } from '../src/core/gen/grid.ts';
import { Oracle } from '../src/core/gen/oracle.ts';
import { Flow } from '../src/core/meta/flow.ts';
import { EV } from '../src/core/sim/events.ts';
import { BTN_REVIVE, InputFrame } from '../src/core/sim/input-frame.ts';
import { RunSim } from '../src/core/sim/run-sim.ts';
import { computeShipStats, ShipStats } from '../src/core/sim/ship-stats.ts';
import { DT } from '../src/data/tuning.ts';

type Mode = 'perfect' | 'human';

interface Args {
  runs: number;
  seed: number;
  seconds: number;
  mode: 'both' | Mode;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { runs: 100, seed: 1, seconds: 240, mode: 'both', json: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--runs') a.runs = Number(v);
    else if (k === '--seed') a.seed = Number(v);
    else if (k === '--seconds') a.seconds = Number(v);
    else if (k === '--mode') a.mode = v as Args['mode'];
    else if (k === '--json') a.json = v ?? null;
  }
  return a;
}

interface RunReport {
  mode: Mode;
  run: number;
  seed: number;
  ship: number;
  ticks: number;
  distance: number;
  score: number;
  deaths: number;
  revives: number;
  maxDifficulty: number;
  chunks: number;
  nearMisses: number;
  failures: string[];
}

const totals = {
  chunks: 0,
  attempts: 0,
  removals: 0,
  fallbacks: 0,
  obstacles: 0,
  oracleChecks: 0,
  worstSlack: Number.POSITIVE_INFINITY,
};
const director = new Director(); // shared by human runs, so adaptation across runs is exercised
let maxTickMs = 0;

function playRun(mode: Mode, run: number, seed: number, maxTicks: number): RunReport {
  const sim = new RunSim();
  const flow = new Flow();
  const ship = run % 4;
  const stats = computeShipStats(ship, {}, new ShipStats());
  const source = new ProceduralSource(mode === 'human' ? director : new Director());
  const bot = mode === 'perfect' ? new PerfectBot() : new HumanBot();
  bot.reset(seed ^ 0x9e3779b9);
  const oracle = new Oracle(8);
  const frame = new InputFrame();
  const failures: string[] = [];
  sim.reset(seed, source, stats);
  flow.start();
  let ticks = 0;
  let deaths = 0;
  let lastS = -1;
  let maxD = 0;
  let checkedChunk = -1;
  const checkChunks = (): void => {
    for (let k = 0; k <= 2; k++) {
      const c = sim.chunk(sim.chunkIndex + k);
      if (!c || c.index <= checkedChunk) continue;
      checkedChunk = c.index;
      if (c.difficulty > maxD) maxD = c.difficulty;
      if (!c.certified) failures.push(`chunk ${c.index} emitted without a certificate`);
      for (let j = 0; j < ROWS; j++) {
        if ((c.entry[j]! & ~c.viable[j]!) !== 0) {
          failures.push(`chunk ${c.index}: entry cell not viable (impossible layout)`);
          break;
        }
      }
    }
  };
  checkChunks();
  while (ticks < maxTicks) {
    if (flow.state === 'running') {
      bot.decide(sim, frame);
      const t0 = performance.now();
      sim.step(frame);
      const dt = performance.now() - t0;
      if (dt > maxTickMs) maxTickMs = dt;
      ticks++;
      if (mode === 'perfect') oracle.check(sim);
      checkChunks();
      for (let i = sim.events.shift(); i >= 0; i = sim.events.shift()) {
        if (sim.events.codes[i] === EV.DEATH) {
          deaths++;
          flow.died(sim.revives === 0);
        }
      }
      if (!Number.isFinite(sim.s + sim.x + sim.y + sim.score + sim.speed)) {
        failures.push(`NaN/Infinity in sim state at tick ${ticks}`);
        break;
      }
      if (sim.speed > sim.current.vCert + 1e-9) failures.push(`speed above certified speed at tick ${ticks}`);
      if (sim.alive) {
        if (sim.s <= lastS) {
          failures.push(`softlock: no forward progress at tick ${ticks}`);
          break;
        }
        lastS = sim.s;
      }
    } else {
      // Drive the flow like a player would; it must always lead back to running or results.
      let guard = 0;
      while ((flow.state as string) !== 'running' && flow.state !== 'results' && guard++ < 2000) {
        flow.update(DT);
        if (flow.state === 'revive') {
          if (flow.acceptRevive()) {
            frame.clear();
            frame.buttons = BTN_REVIVE;
            sim.step(frame);
            lastS = sim.s;
            if (!sim.alive) failures.push('revive did not bring the ship back');
          }
        }
      }
      if (guard >= 2000) {
        failures.push(`flow softlock in state ${flow.state}`);
        break;
      }
      if (flow.state === 'results') {
        let g = 0;
        while (!flow.start() && g++ < 600) flow.update(DT);
        if ((flow.state as string) !== 'running') failures.push('results screen never accepted a retry');
        break;
      }
    }
  }
  if (mode === 'perfect') {
    if (deaths > 0)
      failures.push(`perfect bot died ${deaths}× (certificate violated) near s=${sim.s.toFixed(1)}`);
    if (oracle.violations > 0)
      failures.push(`oracle: ${oracle.violations} clearance violations; last: ${oracle.lastViolation}`);
    if (bot.planFailures > 0) failures.push(`planner found no viable move ${bot.planFailures}×`);
    totals.oracleChecks += oracle.checks;
    if (oracle.worstSlack < totals.worstSlack) totals.worstSlack = oracle.worstSlack;
  }
  totals.chunks += source.stats.chunks;
  totals.attempts += source.stats.attempts;
  totals.removals += source.stats.removals;
  totals.fallbacks += source.stats.fallbacks;
  totals.obstacles += source.stats.obstacles;
  return {
    mode,
    run,
    seed,
    ship,
    ticks,
    distance: +sim.s.toFixed(1),
    score: Math.floor(sim.score),
    deaths,
    revives: sim.revives,
    maxDifficulty: +maxD.toFixed(3),
    chunks: source.stats.chunks,
    nearMisses: sim.nearMisses,
    failures,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const maxTicks = Math.round(args.seconds / DT);
  const modes: Mode[] = args.mode === 'both' ? ['perfect', 'human'] : [args.mode];
  const t0 = performance.now();
  const reports: RunReport[] = [];
  let crashes = 0;
  for (const mode of modes) {
    for (let r = 0; r < args.runs; r++) {
      const seed = (Math.imul(args.seed, 1_000_003) + r * 7919) >>> 0;
      try {
        reports.push(playRun(mode, r, seed, maxTicks));
      } catch (e) {
        crashes++;
        reports.push({
          mode,
          run: r,
          seed,
          ship: r % 4,
          ticks: 0,
          distance: 0,
          score: 0,
          deaths: 0,
          revives: 0,
          maxDifficulty: 0,
          chunks: 0,
          nearMisses: 0,
          failures: [`crash: ${(e as Error).stack}`],
        });
      }
    }
  }
  const ms = performance.now() - t0;
  const by = (m: Mode) => reports.filter((r) => r.mode === m);
  const sum = (rs: RunReport[], f: (r: RunReport) => number) => rs.reduce((a, r) => a + f(r), 0);
  const totalTicks = sum(reports, (r) => r.ticks);
  const failed = reports.filter((r) => r.failures.length > 0);
  const summary = {
    runsPerMode: args.runs,
    seed: args.seed,
    secondsPerRunCap: args.seconds,
    crashes,
    failedRuns: failed.length,
    perfect: by('perfect').length
      ? {
          runs: by('perfect').length,
          deaths: sum(by('perfect'), (r) => r.deaths),
          meanDistance: +(sum(by('perfect'), (r) => r.distance) / by('perfect').length).toFixed(0),
          maxDifficulty: Math.max(...by('perfect').map((r) => r.maxDifficulty)),
          oracleChecks: totals.oracleChecks,
          oracleWorstSlackMetres: +totals.worstSlack.toFixed(4),
        }
      : null,
    human: by('human').length
      ? {
          runs: by('human').length,
          deaths: sum(by('human'), (r) => r.deaths),
          revives: sum(by('human'), (r) => r.revives),
          meanDistance: +(sum(by('human'), (r) => r.distance) / by('human').length).toFixed(0),
          directorSkillAfter: +director.skill.toFixed(3),
        }
      : null,
    generator: {
      chunks: totals.chunks,
      attemptsPerChunk: +(totals.attempts / Math.max(1, totals.chunks)).toFixed(3),
      repairRemovals: totals.removals,
      fallbackChunks: totals.fallbacks,
      fallbackRate: +(totals.fallbacks / Math.max(1, totals.chunks)).toFixed(4),
      obstaclesPerChunk: +(totals.obstacles / Math.max(1, totals.chunks)).toFixed(1),
    },
    simulatedHours: +((totalTicks * DT) / 3600).toFixed(2),
    wallSeconds: +(ms / 1000).toFixed(1),
    usPerTickIncludingBotAndOracle: +((ms * 1000) / Math.max(1, totalTicks)).toFixed(2),
    maxSingleTickMs: +maxTickMs.toFixed(2),
  };
  console.log(JSON.stringify(summary, null, 2));
  for (const f of failed.slice(0, 12))
    console.error(
      `[${f.mode}] run ${f.run} seed ${f.seed} ship ${f.ship}: ${f.failures.slice(0, 3).join(' | ')}`,
    );
  if (args.json) writeFileSync(args.json, JSON.stringify({ summary, reports }, null, 2));
  process.exit(failed.length > 0 || crashes > 0 ? 1 : 0);
}

main();
