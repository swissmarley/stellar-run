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
import { Feedback } from './feedback.ts';
import type { Hud } from './hud/hud.ts';
import { Popups } from './hud/popups.ts';
import type { InputRouter } from './input/input-router.ts';
import { CameraRig } from './render/camera-rig.ts';
import { Rails } from './render/environment.ts';
import { SHARED } from './render/materials.ts';
import { Particles } from './render/particles.ts';
import { PostFX } from './render/post.ts';
import { AutoQuality, lowerTier, QUALITY, type QualityTier } from './render/quality.ts';
import { ShipView } from './render/ship-view.ts';
import { bakeNoiseTexture, Sky } from './render/sky.ts';
import { Dust, SpeedLines } from './render/speed-fx.ts';
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
  onQualityChange?(tier: QualityTier): void;
}

export interface GameSettings {
  reducedMotion: boolean;
  shakeScale: number;
  flashes: boolean;
  popups: boolean;
  quality: 'auto' | QualityTier;
  /** Battery saver: render every other frame (sim still steps at 120 Hz). */
  fps30: boolean;
}

const tmpSize = new THREE.Vector2();

/**
 * Owns the fixed-timestep loop: samples input per tick, advances the deterministic RunSim at 120 Hz,
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
  readonly sky = new Sky(bakeNoiseTexture());
  readonly speedLines = new SpeedLines();
  readonly dust = new Dust();
  readonly particles = new Particles(1024);
  readonly post = new PostFX();
  readonly popups = new Popups();
  readonly feedback: Feedback;
  readonly autoQuality = new AutoQuality();
  tier: QualityTier = 'high';
  settings: GameSettings = {
    reducedMotion: false,
    shakeScale: 1,
    flashes: true,
    popups: true,
    quality: 'auto',
    fps30: false,
  };
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
  private skipFrame = false;
  private width = 1;
  private height = 1;
  /** Frame-time samples (ms) in a preallocated ring, for the perf overlay and the bench. */
  readonly frameTimes = new Float64Array(240);
  frameCount = 0;
  ticksThisFrame = 0;
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

  private readonly targetFog = new THREE.Color();
  private readonly targetLight = new THREE.Color();
  private readonly targetAmbient = new THREE.Color();
  private readonly targetRail = new THREE.Color();
  private readonly targetRock = new THREE.Color();
  private readonly targetA = new THREE.Color();
  private readonly targetB = new THREE.Color();
  private readonly targetC = new THREE.Color();
  private readonly targetStars = new THREE.Color();
  private readonly gradeLift = new THREE.Vector3();
  private readonly gradeGamma = new THREE.Vector3(1, 1, 1);
  private readonly gradeGain = new THREE.Vector3(1, 1, 1);
  private gradeSat = 1;
  private gradeContrast = 1;

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
    this.scene.add(
      this.sky.mesh,
      this.world.root,
      this.ship.root,
      this.rails.root,
      this.speedLines.mesh,
      this.dust.mesh,
      this.particles.points,
    );
    this.feedback = new Feedback(this.sim, this.rig, this.particles, this.popups, this.post);
    this.on((c, d, o) => this.feedback.handle(c, d, o));
    this.input.bind(this.sim);
    this.setBiome(0, true);
  }

  on(fn: SimEventListener): void {
    this.listeners.push(fn);
  }

  /**
   * Compiles every shader program up front (behind the boot screen) so the first obstacles of a run never
   * cause a compile hitch. Hidden instanced meshes are made visible just for the compile pass.
   */
  warmup(): void {
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    this.renderer.compile(this.scene, this.rig.camera);
    for (const o of hidden) o.visible = false;
  }

  /** Applies a quality tier (pixel ratio, post-processing, particle/dust budgets). */
  applyQuality(tier: QualityTier): void {
    this.tier = tier;
    const q = QUALITY[tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap));
    this.post.configure(q.post);
    this.dust.setCount(q.dust);
    this.sky.uniforms.uDetail.value = q.skyDetail ? 1 : 0;
    this.resize(this.width, this.height);
    this.autoQuality.reset();
    this.hooks.onQualityChange?.(tier);
  }

  applySettings(s: GameSettings): void {
    this.settings = { ...s };
    this.rig.reducedMotion = s.reducedMotion;
    this.rig.shakeScale = s.shakeScale;
    this.feedback.settings = { reducedMotion: s.reducedMotion, flashes: s.flashes, popups: s.popups };
    this.autoQuality.enabled = s.quality === 'auto';
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.getDrawingBufferSize(tmpSize);
    this.post.setSize(tmpSize.x, tmpSize.y);
    this.rig.setAspect(w / Math.max(1, h));
    this.feedback.setViewport(w, h);
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
    this.particles.clear();
    this.popups.clear();
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
    const p = b.palette;
    this.targetFog.setHex(p.fog);
    this.targetLight.setHex(p.light);
    this.targetAmbient.setHex(p.ambient);
    this.targetRail.setHex(p.rail);
    this.targetRock.setHex(p.rock);
    this.targetA.setHex(p.nebulaA);
    this.targetB.setHex(p.nebulaB);
    this.targetC.setHex(p.nebulaC);
    this.targetStars.setHex(p.stars);
    const g = b.grading;
    this.gradeLift.set(g.lift[0], g.lift[1], g.lift[2]);
    this.gradeGamma.set(g.gamma[0], g.gamma[1], g.gamma[2]);
    this.gradeGain.set(g.gain[0], g.gain[1], g.gain[2]);
    this.gradeSat = g.saturation;
    this.gradeContrast = g.contrast;
    if (instant) this.blendBiome(1);
  }

  /** Eases every biome-dependent colour toward its target (k = blend factor this frame). */
  private blendBiome(k: number): void {
    SHARED.uFogColor.value.lerp(this.targetFog, k);
    SHARED.uLightColor.value.lerp(this.targetLight, k);
    SHARED.uAmbient.value.lerp(this.targetAmbient, k);
    this.rails.material.uniforms.uColor.value.lerp(this.targetRail, k);
    const su = this.sky.uniforms;
    su.uFog.value.lerp(this.targetFog, k);
    su.uColA.value.lerp(this.targetA, k);
    su.uColB.value.lerp(this.targetB, k);
    su.uColC.value.lerp(this.targetC, k);
    su.uStars.value.lerp(this.targetStars, k);
    const mats = this.world.mats.byArch;
    mats[0]!.uniforms.uBody.value.lerp(this.targetRock, k);
    mats[1]!.uniforms.uBody.value.lerp(this.targetRock, k);
    const gr = this.post.grading;
    gr.uLift.value.lerp(this.gradeLift, k);
    gr.uGamma.value.lerp(this.gradeGamma, k);
    gr.uGain.value.lerp(this.gradeGain, k);
    gr.uSat.value += (this.gradeSat - gr.uSat.value) * k;
    gr.uContrast.value += (this.gradeContrast - gr.uContrast.value) * k;
  }

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

    if (flow.state === 'running' && this.autoQuality.push(dtWall * 1000) && this.tier !== 'low') {
      this.applyQuality(lowerTier(this.tier));
    }

    const presentScale =
      flow.state === 'hitstop' || flow.state === 'paused'
        ? 0
        : flow.state === 'dying'
          ? TUNING.DEATH_SLOWMO
          : this.timeScale;
    const pdt = dtWall * presentScale;
    this.presentT += pdt;
    // 30 fps mode: the sim keeps its 120 Hz cadence, only presentation skips every other frame.
    this.skipFrame = this.settings.fps30 ? !this.skipFrame : false;
    if (!this.skipFrame) {
      this.render(pdt, dtWall);
      this.hud.update(sim);
    }
    this.onFrame?.(dtWall * 1000);
  }

  private render(pdt: number, dtWall: number): void {
    const sim = this.sim;
    const a = this.alpha;
    const s = sim.prevS + (sim.s - sim.prevS) * a;
    const x = sim.prevX + (sim.x - sim.prevX) * a;
    const y = sim.prevY + (sim.y - sim.prevY) * a;
    const lat = sim.stats.lateralSpeed || 1;
    this.blendBiome(1 - Math.exp(-dtWall * 1.5));
    SHARED.uTime.value = this.presentT;

    const cruise = sim.current.cruise;
    const speed01 = Math.min(
      1,
      Math.max(0, (cruise - TUNING.SPEED_MIN) / (TUNING.SPEED_MAX - TUNING.SPEED_MIN)),
    );
    const boost01 = sim.boosting && sim.alive ? 1 : 0;
    const reduced = this.settings.reducedMotion;
    this.world.update(sim, s);
    this.rails.update(s);
    this.ship.update(x, y, sim.vx / lat, sim.vy / lat, boost01, pdt, sim.intangible, this.presentT);
    this.rig.update(x, y, speed01, boost01, this.ship.bank, pdt, this.presentT);
    this.sky.follow(this.rig.camera, x, y, this.presentT);
    this.speedLines.update(s, speed01, boost01, reduced);
    this.dust.update(s, speed01, boost01, reduced);
    this.renderer.getDrawingBufferSize(tmpSize);
    const fovRad = (this.rig.camera.fov * Math.PI) / 180;
    this.particles.setTime(this.presentT, s, tmpSize.y / (2 * Math.tan(fovRad / 2)));
    const warp = this.timeScale < 1 ? (1 - this.timeScale) / (1 - TUNING.FOCUS_TIME_SCALE) : 0;
    this.feedback.update(dtWall, s, this.flow.state === 'running', warp);
    this.renderer.info.reset();
    this.post.render(this.renderer, this.scene, this.rig.camera);
  }
}
