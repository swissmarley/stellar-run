import { PerfectBot } from './core/bot/bot.ts';
import type { Game } from './game/game.ts';
import type { QualityTier } from './game/render/quality.ts';

export interface BenchOptions {
  tier: QualityTier;
  fps30: boolean;
  seed: number;
  /** Seconds flown before measuring (JIT warm-up, first chunks, shader compilation). */
  warmup: number;
}

interface Pct {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface BenchResult {
  tier: QualityTier;
  fps30: boolean;
  frames: number;
  seconds: number;
  fps: number;
  frameMs: Pct;
  /** Main-thread time inside one game frame (sim + render submission), excluding GPU and idle. */
  workMs: Pct;
  drawCalls: { mean: number; max: number };
  triangles: { mean: number; max: number };
  simTicks: number;
  distance: number;
  deaths: number;
  jsHeapMB: number | null;
  gpu: string;
}

const CAP = 130 * 120;
const ft = new Float64Array(CAP);
const work = new Float64Array(CAP);
const calls = new Float64Array(CAP);
const tris = new Float64Array(CAP);

let bench: {
  game: Game;
  o: BenchOptions;
  restore: (now: number) => void;
  recording: boolean;
  n: number;
  ticks: number;
  deaths: number;
  lastWork: number;
  t0: number;
} | null = null;

function pct(arr: Float64Array, n: number): Pct {
  const sorted = arr.slice(0, n).sort();
  const q = (p: number): number =>
    +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(2);
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}

/**
 * In-page benchmark, phase 1: starts the perfect bot flying the real game (audio-free) and resolves after the
 * warm-up, leaving it running. Phase 2 (benchMeasure) records frame/work times and renderer statistics.
 * Split in two so the harness can attach tracing (GC events) to the measured window only.
 */
export function benchStart(game: Game, o: BenchOptions): Promise<void> {
  game.applySettings({ ...game.settings, quality: o.tier, fps30: o.fps30 });
  game.applyQuality(o.tier);
  game.autoQuality.enabled = false;
  const bot = new PerfectBot();
  bot.reset(o.seed);
  game.inputOverride = (sim, f) => bot.decide(sim, f);
  game.newRun();
  const tick = game.tickFrame.bind(game);
  const b = {
    game,
    o,
    restore: tick,
    recording: false,
    n: 0,
    ticks: 0,
    deaths: 0,
    lastWork: 0,
    t0: 0,
  };
  bench = b;
  game.tickFrame = (now: number): void => {
    const a = performance.now();
    tick(now);
    b.lastWork = performance.now() - a;
  };
  game.onFrame = (ms) => {
    if (game.flow.state !== 'running') {
      if (game.flow.state === 'results' || game.flow.state === 'revive') {
        b.deaths++;
        game.toMenu();
        game.newRun();
      }
      return;
    }
    if (!b.recording || b.n >= CAP) return;
    b.ticks += game.ticksThisFrame;
    ft[b.n] = ms;
    work[b.n] = b.lastWork;
    calls[b.n] = game.renderer.info.render.calls;
    tris[b.n] = game.renderer.info.render.triangles;
    b.n++;
  };
  return new Promise((resolve) => setTimeout(resolve, o.warmup * 1000));
}

export function benchMeasure(seconds: number): Promise<BenchResult> {
  const b = bench;
  if (!b) return Promise.reject(new Error('benchStart first'));
  b.recording = true;
  b.t0 = performance.now();
  return new Promise((resolve) => {
    setTimeout(() => {
      const g = b.game;
      const elapsed = (performance.now() - b.t0) / 1000;
      b.recording = false;
      g.onFrame = null;
      g.inputOverride = null;
      g.tickFrame = b.restore;
      const n = b.n;
      let cSum = 0;
      let cMax = 0;
      let tSum = 0;
      let tMax = 0;
      for (let i = 0; i < n; i++) {
        cSum += calls[i]!;
        tSum += tris[i]!;
        if (calls[i]! > cMax) cMax = calls[i]!;
        if (tris[i]! > tMax) tMax = tris[i]!;
      }
      const gl = g.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      bench = null;
      resolve({
        tier: b.o.tier,
        fps30: b.o.fps30,
        frames: n,
        seconds: +elapsed.toFixed(2),
        fps: +(n / elapsed).toFixed(1),
        frameMs: pct(ft, n),
        workMs: pct(work, n),
        drawCalls: { mean: +(cSum / Math.max(1, n)).toFixed(1), max: cMax },
        triangles: { mean: Math.round(tSum / Math.max(1, n)), max: tMax },
        simTicks: b.ticks,
        distance: Math.round(g.sim.s),
        deaths: b.deaths,
        jsHeapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
        gpu: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
      });
    }, seconds * 1000);
  });
}
