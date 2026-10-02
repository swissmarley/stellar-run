import './styles.css';
import { HandmadeSource } from './core/gen/handmade.ts';
import type { RunSim } from './core/sim/run-sim.ts';
import { Game } from './game/game.ts';
import { Hud } from './game/hud/hud.ts';
import { defaultInputSettings, InputRouter } from './game/input/input-router.ts';
import { createRenderer } from './game/render/renderer.ts';
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

  const renderer = createRenderer({ canvas, antialias: true, pixelRatioCap: 2 });
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

  game = new Game(renderer, input, hud, ui, new HandmadeSource(), {
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
    if (document.hidden && game.flow.state === 'running') game.pause();
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
  };

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is optional */
    });
  }
}

boot();
