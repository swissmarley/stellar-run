import './styles.css';
import { ProceduralSource } from './core/gen/generator.ts';
import { generationHash } from './core/gen/golden.ts';
import type { RunSim } from './core/sim/run-sim.ts';
import { AudioEngine } from './game/audio/audio-engine.ts';
import { Game } from './game/game.ts';
import { Hud } from './game/hud/hud.ts';
import { defaultInputSettings, InputRouter } from './game/input/input-router.ts';
import { detectTier } from './game/render/quality.ts';
import { createRenderer } from './game/render/renderer.ts';
import { HapticsService } from './services/haptics.ts';
import { Ui } from './ui/ui.ts';

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

function boot(): void {
  const app = document.getElementById('app')!;
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud-root')!;
  const uiRoot = document.getElementById('ui-root')!;

  const renderer = createRenderer({ canvas, antialias: false, pixelRatioCap: 2 });
  const input = new InputRouter(canvas, defaultInputSettings());
  const hud = new Hud();
  hudRoot.append(hud.root);
  hud.setVisible(false);

  let best = 0;
  let game: Game;
  const ui = new Ui(uiRoot, {
    play: () => game.newRun(),
    resume: () => game.resume(),
    restart: () => {
      game.toMenu();
      game.newRun();
    },
    quit: () => game.toMenu(),
    retry: () => game.retry(),
    menu: () => game.toMenu(),
    revive: () => game.acceptRevive(),
    declineRevive: () => game.declineRevive(),
    open: () => {},
  });

  const source = new ProceduralSource();
  game = new Game(renderer, input, hud, ui, source, {
    onRunEnd(sim: RunSim) {
      const newBest = sim.score > best;
      if (newBest) best = sim.score;
      ui.setBest(best);
      return {
        score: sim.score,
        distance: sim.s,
        nearMisses: sim.nearMisses,
        perfects: sim.perfects,
        maxCombo: sim.maxCombo,
        shards: sim.shards,
        earned: sim.shards,
        best,
        newBest,
        missionsCompleted: [],
      };
    },
    reviveOffer: () => ({ cost: 0, affordable: false }),
    payRevive: () => false,
    nextRun: () => ({ shipIndex: 0, upgrades: {}, seed: randomSeed() }),
  });

  hudRoot.append(game.popups.root);
  const haptics = new HapticsService();
  const audio = new AudioEngine();
  game.feedback.haptics = haptics;
  game.feedback.audio = audio;
  const unlock = (): void => audio.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true, passive: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  game.applySettings({ ...game.settings, reducedMotion: reduced });
  game.applyQuality(detectTier());

  input.onPause = () => {
    if (game.flow.state === 'running') game.pause();
    else if (game.flow.state === 'paused') game.resume();
  };
  hud.pauseBtn.addEventListener('click', () => game.pause());
  hud.abilityBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    input.requestAbility();
  });

  const resize = (): void => {
    const r = app.getBoundingClientRect();
    game.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
  };
  new ResizeObserver(resize).observe(app);
  resize();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.flow.state === 'running') game.pause();
      audio.suspend();
    } else audio.resume();
  });

  ui.show('menu');
  game.start();
  document.getElementById('boot')?.classList.add('done');

  // Read-only introspection plus a kill switch for automated tests and the bench (no gameplay effect otherwise).
  (window as unknown as { __stellar: unknown }).__stellar = {
    game,
    state: () => ({
      flow: game.flow.state,
      s: game.sim.s,
      x: game.sim.x,
      y: game.sim.y,
      alive: game.sim.alive,
      score: game.sim.score,
    }),
    kill: () => game.sim.debugKill(),
    genHash: (seed: number, n: number) => generationHash(seed, n),
  };

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is optional */
    });
  }
}

boot();
