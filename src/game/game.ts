import * as THREE from 'three';
import type { ChunkSource } from '../core/gen/source.ts';
import { Flow } from '../core/meta/flow.ts';
import { EV, EventRing } from '../core/sim/events.ts';
import { InputFrame } from '../core/sim/input-frame.ts';
import { RunSim } from '../core/sim/run-sim.ts';
import { computeShipStats, ShipStats, type UpgradeLevels } from '../core/sim/ship-stats.ts';
import { BIOMES } from '../data/biomes.ts';
import { DT, TUNING } from '../data/tuning.ts';
import type { ResultsData, Ui } from '../ui/ui.ts';
import type { Hud } from './hud/hud.ts';
import type { InputRouter } from './input/input-router.ts';
import { CameraRig } from './render/camera-rig.ts';
import { Rails, Stars } from './render/environment.ts';
import { SHARED } from './render/materials.ts';
import { ShipView } from './render/ship-view.ts';
import { WorldView } from './render/world-view.ts';

/** Listener for sim events re-emitted by the game (audio, haptics, popups, FX). Payload is read in place. */
export type SimEventListener = (code: number, data: Float64Array, offset: number) => void;

export interface RunSetup {
  shipIndex: number;
  upgrades: UpgradeLevels;
  seed: number;
  paint?: number;
  engine?: number;
}

export interface GameHooks {
  /** Called once per run end with the final sim (before results are shown). Returns results to display. */
  onRunEnd(sim: RunSim): ResultsData;
  /** Revive cost in shards and whether the player can afford it. */
  reviveOffer(sim: RunSim): { cost: number; affordable: boolean };
  /** Pays for a revive; returns false if it failed. */
  payRevive(sim: RunSim): boolean;
  /** Next run's setup (ship, upgrades, seed). */
  nextRun(): RunSetup;
  onFlowChange?(state: string): void;
}

/**
 * Owns the fixed-timestep loop: samples input per tick, advances the deterministic RunSim at 60 Hz,
 * drains sim events, and renders an interpolated frame. Hit-stop, slow-mo and focus only scale wall time.
 */
export class Game {
  readonly sim = new RunSim();
  readonly flow = new Flow();
  readonly scene = new THREE.Scene();
  readonly rig = new CameraRig();
  readonly world = new WorldView();
  readonly ship = new ShipView();
  readonly rails = new Rails();
  readonly stars = new Stars();
  private readonly frame = new InputFrame();
  private readonly stats = new ShipStats();
  private readonly listeners: SimEventListener[] = [];
  private acc = 0;
  private last = -1;
  private timeScale = 1;
  private presentT = 0;
  private alpha = 0;
  private rafId = 0;
  private biome = -1;
  private runEnded = false;
  /** Frame-time samples (ms) in a preallocated ring, for the perf overlay and auto quality. */
  readonly frameTimes = new Float64Array(240);
  frameCount = 0;
  ticksThisFrame = 0;
  paused = false;
  /** Optional per-tick input override (bot / replay). */
  inputOverride: ((sim: RunSim, out: InputFrame) => void) | null = null;
  /** Frame callback after rendering (perf overlay, bench). */
  onFrame: ((dtMs: number) => void) | null = null;

  readonly renderer: THREE.WebGLRenderer;
  readonly input: InputRouter;
  readonly hud: Hud;
  readonly ui: Ui;
  source: ChunkSource;
  readonly hooks: GameHooks;

  constructor(
    renderer: THREE.WebGLRenderer,
    input: InputRouter,
    hud: Hud,
    ui: Ui,
    source: ChunkSource,
    hooks: GameHooks,
  ) {
    this.renderer = renderer;
    this.input = input;
    this.hud = hud;
    this.ui = ui;
    this.source = source;
    this.hooks = hooks;
    this.scene.add(this.world.root, this.ship.root, this.rails.root, this.stars.points);
    this.scene.background = new THREE.Color(0x000000);
    this.input.bind(this.sim);
    this.setBiome(0, true);
  }

  on(fn: SimEventListener): void {
    this.listeners.push(fn);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / Math.max(1, h));
  }

  start(): void {
    const loop = (now: number): void => {
      this.rafId = requestAnimationFrame(loop);
      this.tickFrame(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  /** Begins a new run immediately (no page reload, pools reused). */
  newRun(): void {
    const setup = this.hooks.nextRun();
    computeShipStats(setup.shipIndex, setup.upgrades, this.stats);
    this.sim.reset(setup.seed, this.source, this.stats);
    this.ship.setShip(setup.shipIndex, setup.engine, setup.paint);
    this.ship.setVisible(true);
    this.world.invalidate();
    this.rig.reset();
    this.input.resetForRun();
    this.acc = 0;
    this.runEnded = false;
    this.setBiome(this.sim.current.biome, true);
    this.flow.start();
    this.input.enabled = true;
    this.hud.setVisible(true);
    this.ui.show(null);
    this.notifyFlow();
  }

  pause(): void {
    if (this.flow.pause()) {
      this.input.enabled = false;
      this.ui.show('pause');
      this.notifyFlow();
    }
  }

  resume(): void {
    if (this.flow.resume()) {
      this.input.enabled = true;
      this.input.resetForRun();
      this.last = -1;
      this.ui.show(null);
      this.notifyFlow();
    }
  }

  toMenu(): void {
    if (this.flow.state === 'paused' || this.flow.state === 'results') {
      if (this.flow.state === 'paused') this.finishRun(false);
      this.flow.toMenu();
      this.input.enabled = false;
      this.hud.setVisible(false);
      this.ui.show('menu');
      this.notifyFlow();
    }
  }

  acceptRevive(): void {
    if (this.flow.state !== 'revive') return;
    if (!this.hooks.payRevive(this.sim)) return;
    this.flow.acceptRevive();
    this.input.resetForRun();
    this.input.requestRevive();
    this.input.enabled = true;
    this.ship.setVisible(true);
    this.ui.show(null);
    this.notifyFlow();
  }

  declineRevive(): void {
    if (this.flow.declineRevive()) this.showResults();
  }

  retry(): void {
    if (this.flow.state === 'results' && this.flow.t >= TUNING.RESULTS_INPUT_DELAY) this.newRun();
  }

  private notifyFlow(): void {
    this.hooks.onFlowChange?.(this.flow.state);
  }

  private finishRun(show: boolean): void {
    if (this.runEnded) return;
    this.runEnded = true;
    const r = this.hooks.onRunEnd(this.sim);
    if (show) this.ui.setResults(r);
  }

  private showResults(): void {
    this.finishRun(true);
    this.input.enabled = false;
    this.ui.show('results');
    this.notifyFlow();
  }

  private setBiome(index: number, instant: boolean): void {
    if (index === this.biome) return;
    this.biome = index;
    const b = BIOMES[index]!;
    this.targetFog.setHex(b.palette.fog);
    this.targetLight.setHex(b.palette.light);
    this.targetAmbient.setHex(b.palette.ambient);
    this.targetRail.setHex(b.palette.rail);
    if (instant) {
      SHARED.uFogColor.value.copy(this.targetFog);
      SHARED.uLightColor.value.copy(this.targetLight);
      SHARED.uAmbient.value.copy(this.targetAmbient);
      this.rails.material.uniforms.uColor.value.copy(this.targetRail);
    }
  }

  private readonly targetFog = new THREE.Color();
  private readonly targetLight = new THREE.Color();
  private readonly targetAmbient = new THREE.Color();
  private readonly targetRail = new THREE.Color();

  private drainEvents(): void {
    const ev: EventRing = this.sim.events;
    for (let idx = ev.shift(); idx >= 0; idx = ev.shift()) {
      const code = ev.codes[idx]!;
      const o = idx * EventRing.PAYLOAD;
      const d = ev.data;
      switch (code) {
        case EV.DEATH: {
          const offer = this.hooks.reviveOffer(this.sim);
          this.flow.died(offer.affordable && this.sim.revives === 0);
          this.input.enabled = false;
          this.rig.addTrauma(TUNING.SHAKE_DEATH);
          this.ship.setVisible(false);
          this.notifyFlow();
          break;
        }
        case EV.NEAR_MISS:
          this.rig.addTrauma(TUNING.SHAKE_NEAR_MISS * (d[o + 5] === 1 ? 1.4 : 1));
          break;
        case EV.SHARD:
          this.world.shardTaken(this.sim, d[o + 2]!);
          break;
        case EV.OBSTACLE_DESTROYED:
          this.world.obstacleDestroyed(this.sim, d[o]!, d[o + 1]!);
          break;
        case EV.BIOME_CHANGE:
          this.setBiome(d[o]!, false);
          break;
        default:
          break;
      }
      for (let i = 0; i < this.listeners.length; i++) this.listeners[i]!(code, d, o);
    }
  }

  /** One rendered frame. Public for the bench and tests (deterministic stepping). */
  tickFrame(now: number): void {
    const dtWall = this.last < 0 ? 1 / 60 : Math.min(TUNING.MAX_FRAME_DT, (now - this.last) / 1000);
    this.last = now;
    this.frameTimes[this.frameCount % this.frameTimes.length] = dtWall * 1000;
    this.frameCount++;
    const sim = this.sim;
    const flow = this.flow;
    const prevState = flow.state;
    flow.update(dtWall);
    if (flow.state !== prevState) {
      if (flow.state === 'revive') this.ui.show('revive');
      else if (flow.state === 'results') this.showResults();
      this.notifyFlow();
    }

    // Wall-time scale: focus slow-mo eases in/out; death plays in slow motion.
    const targetScale = sim.focusActive ? TUNING.FOCUS_TIME_SCALE : 1;
    this.timeScale += (targetScale - this.timeScale) * (1 - Math.exp(-dtWall * 14));
    this.ticksThisFrame = 0;
    if (flow.simulating) {
      this.acc += dtWall * this.timeScale;
      while (this.acc >= DT && this.ticksThisFrame < TUNING.MAX_TICKS_PER_FRAME) {
        if (this.inputOverride) this.inputOverride(sim, this.frame);
        else this.input.sample(now, this.frame);
        sim.step(this.frame);
        this.acc -= DT;
        this.ticksThisFrame++;
        this.drainEvents();
        if (!flow.simulating) break;
      }
      if (this.ticksThisFrame >= TUNING.MAX_TICKS_PER_FRAME) this.acc = 0;
      this.alpha = flow.simulating ? this.acc / DT : 1;
    }
    if (flow.state === 'revive') {
      const offer = this.hooks.reviveOffer(sim);
      this.ui.setRevive(offer.cost, 1 - flow.t / TUNING.REVIVE_OFFER_TIME);
    }

    const presentScale =
      flow.state === 'hitstop'
        ? 0
        : flow.state === 'dying'
          ? TUNING.DEATH_SLOWMO
          : flow.state === 'paused'
            ? 0
            : this.timeScale;
    const pdt = dtWall * presentScale;
    this.presentT += pdt;
    this.render(pdt);
    this.hud.update(sim);
    this.onFrame?.(dtWall * 1000);
  }

  private render(pdt: number): void {
    const sim = this.sim;
    const a = this.alpha;
    const s = sim.prevS + (sim.s - sim.prevS) * a;
    const x = sim.prevX + (sim.x - sim.prevX) * a;
    const y = sim.prevY + (sim.y - sim.prevY) * a;
    const lat = sim.stats.lateralSpeed || 1;
    const k = 1 - Math.exp(-pdt * 3);
    SHARED.uFogColor.value.lerp(this.targetFog, k);
    SHARED.uLightColor.value.lerp(this.targetLight, k);
    SHARED.uAmbient.value.lerp(this.targetAmbient, k);
    this.rails.material.uniforms.uColor.value.lerp(this.targetRail, k);
    (this.scene.background as THREE.Color).copy(SHARED.uFogColor.value);
    SHARED.uTime.value = this.presentT;

    const cruise = sim.current.cruise;
    const speed01 = Math.min(
      1,
      Math.max(0, (cruise - TUNING.SPEED_MIN) / (TUNING.SPEED_MAX - TUNING.SPEED_MIN)),
    );
    const boost01 = sim.boosting ? 1 : 0;
    this.world.update(sim, s);
    this.rails.update(s);
    this.ship.update(x, y, sim.vx / lat, sim.vy / lat, boost01, pdt, sim.intangible, this.presentT);
    this.rig.update(x, y, speed01, boost01, this.ship.bank, pdt, this.presentT);
    this.stars.follow(this.rig.camera);
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.rig.camera);
  }
}
