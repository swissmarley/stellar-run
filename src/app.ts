import { type BenchOptions, benchMeasure, benchStart } from './bench.ts';
import { ProceduralSource } from './core/gen/generator.ts';
import { generationHash } from './core/gen/golden.ts';
import type { ChunkSource } from './core/gen/source.ts';
import {
  buyCosmetic,
  buyShip,
  buyUpgrade,
  equipCosmetic,
  reviveCost,
  runEarnings,
} from './core/meta/economy.ts';
import { applyRun, claimMission, dayKey, ensureMissions } from './core/meta/missions.ts';
import {
  defaultProfile,
  migrate,
  PROFILE_VERSION,
  type Profile,
  sanitizeProfile,
} from './core/meta/profile.ts';
import { SlotStore } from './core/meta/save-codec.ts';
import type { RunSim } from './core/sim/run-sim.ts';
import { COSMETICS } from './data/cosmetics.ts';
import { PALETTES } from './data/palette.ts';
import { SHIP_INDEX } from './data/registry.ts';
import { SHIPS } from './data/ships.ts';
import { AudioEngine } from './game/audio/audio-engine.ts';
import { Game } from './game/game.ts';
import { generationHashViaWorker } from './game/gen/worker-golden.ts';
import { createGenWorker, WorkerSource } from './game/gen/worker-source.ts';
import { Hud } from './game/hud/hud.ts';
import { InputRouter } from './game/input/input-router.ts';
import { SHARED } from './game/render/materials.ts';
import { detectTier } from './game/render/quality.ts';
import { createRenderer } from './game/render/renderer.ts';
import { ConsentService } from './services/consent.ts';
import { HapticsService } from './services/haptics.ts';
import { LocalLeaderboard, MockOnlineLeaderboard } from './services/leaderboard.ts';
import { NoAds, NoIap } from './services/monetisation.ts';
import { defaultSettings, SETTINGS_VERSION, type Settings, sanitizeSettings } from './services/settings.ts';
import { openStorage } from './services/storage.ts';
import { h } from './ui/dom.ts';
import {
  hangarScreen,
  leaderboardScreen,
  type MetaActions,
  missionsScreen,
  noticeScreen,
  settingsScreen,
  shopScreen,
  upgradesScreen,
} from './ui/screens.ts';
import { Ui } from './ui/ui.ts';

export const VERSION = '1.0.0';

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

/**
 * Composition root: wires persistence, settings, services, the game loop and the UI together. Everything
 * player-facing that is not the run itself lives here.
 */
export class App {
  readonly game: Game;
  readonly ui: Ui;
  readonly hud: Hud;
  readonly input: InputRouter;
  readonly haptics = new HapticsService();
  readonly audio = new AudioEngine();
  readonly consent = new ConsentService();
  readonly ads = new NoAds();
  readonly iap = new NoIap();
  /** Synchronous generator: owns the director; the worker source delegates decisions and fallbacks to it. */
  readonly gen = new ProceduralSource();
  readonly source: ChunkSource;
  readonly workerSource: WorkerSource | null;
  private readonly profileStore: SlotStore<Profile>;
  private readonly settingsStore: SlotStore<Settings>;
  private readonly local: LocalLeaderboard;
  private readonly online = new MockOnlineLeaderboard();
  readonly persistent: boolean;
  profile: Profile;
  settings: Settings;
  private readonly fpsEl: HTMLElement;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  private screenBack: string = 'menu';

  constructor() {
    const app = document.getElementById('app')!;
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const hudRoot = document.getElementById('hud-root')!;
    const uiRoot = document.getElementById('ui-root')!;

    // `?gen=sync` keeps generation on the main thread (A/B benchmarking).
    const transport = new URLSearchParams(location.search).get('gen') === 'sync' ? null : createGenWorker();
    this.workerSource = transport ? new WorkerSource(this.gen, transport) : null;
    this.source = this.workerSource ?? this.gen;

    const storage = openStorage();
    this.persistent = storage.persistent;
    this.profileStore = new SlotStore(
      storage.store,
      'stellar-run.profile',
      PROFILE_VERSION,
      sanitizeProfile,
      migrate,
      defaultProfile,
    );
    this.settingsStore = new SlotStore(
      storage.store,
      'stellar-run.settings',
      SETTINGS_VERSION,
      sanitizeSettings,
      (r) => r,
      defaultSettings,
    );
    this.profile = this.profileStore.load().value;
    this.settings = this.settingsStore.load().value;
    this.local = new LocalLeaderboard(() => this.profile);
    this.gen.director.restore(this.profile.director);
    ensureMissions(this.profile, dayKey(Date.now()));

    const renderer = createRenderer({ canvas, antialias: false, pixelRatioCap: 2 });
    this.input = new InputRouter(canvas, { ...this.settings.controls });
    this.hud = new Hud();
    hudRoot.append(this.hud.root);
    this.hud.setVisible(false);
    this.fpsEl = h('div', { class: 'fps hidden', 'aria-hidden': 'true' });
    hudRoot.append(this.fpsEl);

    this.ui = new Ui(uiRoot, {
      play: () => this.play(),
      resume: () => this.game.resume(),
      restart: () => {
        this.game.toMenu();
        this.play();
      },
      quit: () => this.toMenu(),
      retry: () => this.game.retry(),
      menu: () => this.toMenu(),
      revive: () => this.game.acceptRevive(),
      declineRevive: () => this.game.declineRevive(),
      open: (name) => this.open(name),
    });
    this.buildMenuNav();

    this.game = new Game(renderer, this.input, this.hud, this.ui, this.source, {
      onRunEnd: (sim) => this.onRunEnd(sim),
      reviveOffer: (sim) => {
        const cost = reviveCost(sim.s, sim.stats.reviveDiscount);
        return { cost, affordable: this.profile.shards >= cost };
      },
      payRevive: (sim) => {
        const cost = reviveCost(sim.s, sim.stats.reviveDiscount);
        if (this.profile.shards < cost) return false;
        this.profile.shards -= cost;
        this.save();
        return true;
      },
      nextRun: () => {
        const shipIndex = SHIP_INDEX[this.profile.selectedShip] ?? 0;
        const paint = COSMETICS.find((c) => c.id === this.profile.paint)?.colors[0];
        const trail = COSMETICS.find((c) => c.id === this.profile.trail)?.colors[0];
        return { shipIndex, upgrades: this.profile.upgrades, seed: randomSeed(), paint, engine: trail };
      },
      onFlowChange: (state) => this.onFlow(state),
    });
    hudRoot.append(this.game.popups.root);
    this.game.feedback.haptics = this.haptics;
    this.game.feedback.audio = this.audio;
    // Web Audio may only start inside a user gesture (iOS); unlock() is idempotent and cheap.
    const unlock = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });
    uiRoot.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b) this.audio.play(b.classList.contains('btn-back') ? 'uiBack' : 'uiClick');
    });
    this.game.onFrame = (ms) => this.onFrame(ms);

    this.input.onPause = () => {
      if (this.game.flow.state === 'running') this.game.pause();
      else if (this.game.flow.state === 'paused') this.game.resume();
    };
    this.hud.pauseBtn.addEventListener('click', () => this.game.pause());
    this.hud.abilityBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.input.requestAbility();
    });

    const resize = (): void => {
      const r = app.getBoundingClientRect();
      this.game.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
    };
    new ResizeObserver(resize).observe(app);
    window.visualViewport?.addEventListener('resize', resize);
    resize();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.game.flow.state === 'running') this.game.pause();
        this.audio.suspend();
        this.save();
      } else {
        this.audio.resume();
      }
    });
    window.addEventListener('pagehide', () => this.save());
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => this.applySettings());

    this.applySettings();
    this.game.warmup();
    this.ui.setBest(this.profile.best.score);
    this.ui.show('menu');
    if (!this.settings.privacy.noticeSeen) this.showNotice();
    this.game.start();
    document.getElementById('boot')?.classList.add('done');
  }

  /** Read-only test/bench hooks (no gameplay effect). */
  debugApi(): unknown {
    const g = this.game;
    return {
      game: g,
      app: this,
      state: () => ({
        flow: g.flow.state,
        s: g.sim.s,
        x: g.sim.x,
        y: g.sim.y,
        alive: g.sim.alive,
        score: g.sim.score,
      }),
      kill: () => g.sim.debugKill(),
      genHash: (seed: number, n: number) => generationHash(seed, n),
      workerStats: () => (this.workerSource ? { ...this.workerSource.stats } : null),
      genHashViaWorker: (seed: number, n: number) => generationHashViaWorker(seed, n),
      benchStart: (o: BenchOptions) => benchStart(g, o),
      benchMeasure: (seconds: number) => benchMeasure(seconds),
    };
  }

  private save(): void {
    this.profile.director = this.gen.director.snapshot();
    this.profileStore.save(this.profile);
  }

  private saveSettings(): void {
    this.settingsStore.save(this.settings);
  }

  private play(): void {
    if (this.settings.controls.steering === 'tilt') this.input.recalibrateTilt();
    this.game.newRun();
  }

  private toMenu(): void {
    this.game.toMenu();
    ensureMissions(this.profile, dayKey(Date.now()));
    this.buildMenuNav();
    this.ui.setBest(this.profile.best.score);
  }

  private onFlow(state: string): void {
    if (state === 'running') void this.acquireWakeLock();
    else this.releaseWakeLock();
  }

  private async acquireWakeLock(): Promise<void> {
    const wl = (
      navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }
    ).wakeLock;
    if (!wl || this.wakeLock) return;
    try {
      this.wakeLock = await wl.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  private releaseWakeLock(): void {
    const w = this.wakeLock;
    this.wakeLock = null;
    void w?.release().catch(() => {});
  }

  private onRunEnd(sim: RunSim): import('./ui/ui.ts').ResultsData {
    const p = this.profile;
    const earned = runEarnings(sim);
    p.shards += earned;
    const st = p.stats;
    st.runs++;
    st.distance += Math.floor(sim.s);
    st.nearMisses += sim.nearMisses;
    st.perfects += sim.perfects;
    st.shards += sim.shards;
    st.abilityUses += sim.abilityUses;
    st.boosts += sim.boosts;
    if (!sim.alive) st.deaths++;
    const newBest = sim.score > p.best.score;
    if (newBest) p.best.score = sim.score;
    if (sim.s > p.best.distance) p.best.distance = sim.s;
    ensureMissions(p, dayKey(Date.now()));
    const done = applyRun(p, sim);
    const today = dayKey(Date.now());
    if (sim.score > 0) {
      const entry = {
        score: Math.floor(sim.score),
        distance: Math.floor(sim.s),
        ship: SHIPS[sim.stats.shipIndex]!.id,
        date: today,
      };
      void this.local.submit(entry);
      void this.online.submit(entry);
    }
    this.save();
    this.ui.setBest(p.best.score);
    return {
      score: sim.score,
      distance: sim.s,
      nearMisses: sim.nearMisses,
      perfects: sim.perfects,
      maxCombo: sim.maxCombo,
      shards: sim.shards,
      earned,
      best: p.best.score,
      newBest,
      missionsCompleted: done,
    };
  }

  private buildMenuNav(): void {
    const nav = this.ui.menuExtra;
    nav.replaceChildren();
    const claimable = this.profile.missions.list.filter((m) => !m.claimed && m.progress >= m.target).length;
    const item = (name: string, label: string, badge = 0): HTMLElement =>
      h(
        'button',
        { class: 'btn nav-btn', type: 'button', onclick: () => this.open(name) },
        label,
        badge > 0 ? h('span', { class: 'badge' }, String(badge)) : null,
      );
    nav.append(
      h(
        'div',
        { class: 'menu-balance' },
        `◆ ${Math.floor(this.profile.shards).toLocaleString('en-US')} shards`,
      ),
      item('hangar', 'Hangar'),
      item('upgrades', 'Upgrades'),
      item('missions', 'Missions', claimable),
      item('leaderboard', 'Leaderboard'),
      item('shop', 'Paint shop'),
      item('settings', 'Settings'),
    );
  }

  private readonly meta: MetaActions = {
    back: () => {
      if (this.screenBack === 'pause') this.ui.show('pause');
      else {
        this.buildMenuNav();
        this.ui.show('menu');
      }
    },
    buyShip: (id) => this.purchase(() => buyShip(this.profile, id).ok, 'hangar'),
    selectShip: (id) => {
      if (this.profile.ownedShips.includes(id)) this.profile.selectedShip = id;
      this.save();
      this.open('hangar');
    },
    buyUpgrade: (id) => this.purchase(() => buyUpgrade(this.profile, id).ok, 'upgrades'),
    claimMission: (id) => this.purchase(() => claimMission(this.profile, id) > 0, 'missions'),
    buyCosmetic: (id) =>
      this.purchase(() => buyCosmetic(this.profile, id).ok && equipCosmetic(this.profile, id), 'shop'),
    equipCosmetic: (id) => this.purchase(() => equipCosmetic(this.profile, id), 'shop'),
    leaderboard: (which) => (which === 'local' ? this.local.top(10) : this.online.top(10)),
    changeSettings: (mutate) => {
      mutate(this.settings);
      this.settings = sanitizeSettings(this.settings);
      this.saveSettings();
      this.applySettings();
      this.open('settings');
    },
    requestTilt: () => this.input.requestTiltPermission(),
    calibrateTilt: () => this.input.recalibrateTilt(),
    exportSave: () => JSON.stringify({ profile: this.profile, settings: this.settings }, null, 2),
    deleteData: () => {
      this.profileStore.wipe();
      this.settingsStore.wipe();
      this.profile = defaultProfile();
      this.settings = defaultSettings();
      this.settings.privacy.noticeSeen = true;
      this.gen.director.restore(null);
      ensureMissions(this.profile, dayKey(Date.now()));
      this.applySettings();
      this.ui.setBest(0);
      this.buildMenuNav();
      this.ui.show('menu');
    },
    resetSettings: () => {
      const seen = this.settings.privacy.noticeSeen;
      this.settings = defaultSettings();
      this.settings.privacy.noticeSeen = seen;
      this.saveSettings();
      this.applySettings();
      this.open('settings');
    },
  };

  private purchase(fn: () => boolean, screen: string): void {
    if (fn()) {
      this.save();
      this.haptics.pulse('ui', performance.now());
    }
    this.open(screen);
  }

  private open(name: string): void {
    const fromPause = this.game?.flow.state === 'paused';
    this.screenBack = fromPause ? 'pause' : 'menu';
    let el: HTMLElement;
    switch (name) {
      case 'hangar':
        el = hangarScreen(this.profile, this.meta);
        break;
      case 'upgrades':
        el = upgradesScreen(this.profile, this.meta);
        break;
      case 'missions': {
        ensureMissions(this.profile, dayKey(Date.now()));
        const now = Date.now();
        const next = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
        el = missionsScreen(this.profile, this.meta, next - now);
        break;
      }
      case 'leaderboard':
        el = leaderboardScreen(this.meta);
        break;
      case 'shop':
        el = shopScreen(this.profile, this.meta);
        break;
      case 'settings':
        el = settingsScreen(this.settings, this.meta, {
          persistent: this.persistent,
          hapticsAvailable: this.haptics.available,
          version: VERSION,
        });
        break;
      default:
        return;
    }
    this.ui.replace(name, el);
    this.ui.show(name);
  }

  private showNotice(): void {
    const el = noticeScreen(() => {
      this.settings.privacy.noticeSeen = true;
      this.saveSettings();
      this.ui.show('menu');
    });
    this.ui.replace('notice', el);
    this.ui.show('notice');
  }

  /** Pushes settings into every subsystem. */
  applySettings(): void {
    const s = this.settings;
    this.input.settings = { ...s.controls, keys: s.controls.keys };
    this.hud.setLeftHanded(s.controls.leftHanded);
    this.haptics.level = s.haptics;
    const vol = s.audio.muted ? 0 : s.audio.master;
    this.audio.setVolumes(vol, s.audio.music, s.audio.sfx);
    const reduced =
      s.a11y.reducedMotion === 'on' ||
      (s.a11y.reducedMotion === 'auto' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const root = document.documentElement;
    root.classList.toggle('reduced-motion', reduced);
    root.classList.toggle('high-contrast', s.a11y.palette === 'highContrast');
    root.style.setProperty('--ui-scale', s.a11y.textScale.toFixed(2));
    const pal = PALETTES[s.a11y.palette];
    SHARED.uRimColor.value.setHex(pal.hazardRim);
    const mats = this.game.world.mats;
    mats.shard.uniforms.uBody.value.setHex(pal.pickup);
    mats.shard.uniforms.uGlowColor.value.setHex(pal.pickup);
    for (const m of mats.byArch) {
      if (
        m.uniforms.uGlowColor.value.getHex() === PALETTES.standard.drone ||
        m.uniforms.uGlowColor.value.getHex() === PALETTES.highContrast.drone
      ) {
        m.uniforms.uGlowColor.value.setHex(pal.drone);
      }
    }
    this.game.applySettings({
      reducedMotion: reduced,
      shakeScale: s.a11y.shake,
      flashes: s.a11y.flashes,
      popups: s.a11y.popups,
      quality: s.graphics.quality,
      fps30: s.graphics.fps30,
    });
    const tier =
      s.graphics.quality === 'auto'
        ? this.game.tier === 'high' && this.game.frameCount === 0
          ? detectTier()
          : this.game.tier
        : s.graphics.quality;
    this.game.applyQuality(tier);
    this.fpsEl.classList.toggle('hidden', !s.graphics.showFps);
  }

  private onFrame(ms: number): void {
    if (!this.settings.graphics.showFps) return;
    this.fpsAcc += ms;
    this.fpsFrames++;
    if (this.fpsAcc >= 500) {
      const info = this.game.renderer.info.render;
      this.fpsEl.textContent = `${Math.round((this.fpsFrames * 1000) / this.fpsAcc)} fps · ${info.calls} calls · ${this.game.tier}`;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }
}
