import * as THREE from 'three';
import { COLS, popcountRows, ROWS } from '../core/gen/grid.ts';
import { EV } from '../core/sim/events.ts';
import type { RunSim } from '../core/sim/run-sim.ts';
import { ABILITY_MAGNET, ABILITY_OVERDRIVE, ABILITY_PHASE, ABILITY_PULSE } from '../core/sim/ship-stats.ts';
import { BIOMES } from '../data/biomes.ts';
import type { HapticEvent } from '../data/haptics.ts';
import { TUNING } from '../data/tuning.ts';
import type { Popups } from './hud/popups.ts';
import type { CameraRig } from './render/camera-rig.ts';
import type { Particles } from './render/particles.ts';
import type { PostFX } from './render/post.ts';

/** The subset of the audio engine the feedback layer drives (structural, so audio stays swappable). */
export interface AudioSink {
  play(cue: string, x?: number, y?: number, z?: number, intensity?: number): void;
  setMusicState(speed01: number, danger01: number, boosting: boolean, focus: boolean, running: boolean): void;
  setBiome(index: number): void;
  setTimeWarp(amount01: number): void;
}

export interface HapticSink {
  pulse(e: HapticEvent, now: number): void;
}

export interface FeedbackSettings {
  reducedMotion: boolean;
  flashes: boolean;
  popups: boolean;
}

const ABILITY_CUES = ['abilityPhase', 'abilityOverdrive', 'abilityPulse', 'abilityMagnet'];
const ABILITY_COLORS = [0x9fdcff, 0xe69f00, 0xd55e00, 0xcc79a7];
const NEAR_TEXT: string[] = [];
const tmp = new THREE.Vector3();

/**
 * Turns sim events into juice: particles, pop-ups, camera trauma, flashes, audio cues and haptics. All
 * presentation; nothing here can influence the deterministic sim.
 */
export class Feedback {
  settings: FeedbackSettings = { reducedMotion: false, flashes: true, popups: true };
  audio: AudioSink | null = null;
  haptics: HapticSink | null = null;
  private flash = 0;
  private flashDecay = 4;
  private shipS = 0;
  private width = 1;
  private height = 1;
  danger01 = 0;

  private readonly sim: RunSim;
  private readonly rig: CameraRig;
  private readonly particles: Particles;
  private readonly popups: Popups;
  private readonly post: PostFX;

  constructor(sim: RunSim, rig: CameraRig, particles: Particles, popups: Popups, post: PostFX) {
    this.sim = sim;
    this.rig = rig;
    this.particles = particles;
    this.popups = popups;
    this.post = post;
  }

  setViewport(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  /** Project a track-space point to CSS pixels in the game view. */
  private project(x: number, y: number, s: number): boolean {
    tmp.set(x, y, -(s - this.shipS)).project(this.rig.camera);
    if (tmp.z > 1 || tmp.z < -1) return false;
    tmp.x = (tmp.x * 0.5 + 0.5) * this.width;
    tmp.y = (-tmp.y * 0.5 + 0.5) * this.height;
    return true;
  }

  private doFlash(color: number, amount: number): void {
    if (!this.settings.flashes || this.settings.reducedMotion) return;
    this.post.grading.uFlashColor.value.setHex(color);
    this.flash = Math.max(this.flash, amount);
  }

  private haptic(e: HapticEvent): void {
    this.haptics?.pulse(e, performance.now());
  }

  handle(code: number, d: Float64Array, o: number): void {
    const sim = this.sim;
    const a = this.audio;
    switch (code) {
      case EV.NEAR_MISS: {
        const perfect = d[o + 5] === 1;
        const ox = d[o + 2]!;
        const oy = d[o + 3]!;
        const dx = sim.x - ox;
        const dy = sim.y - oy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        this.particles.burst(
          perfect ? 22 : 12,
          sim.x - (dx / len) * 0.6,
          sim.y - (dy / len) * 0.6,
          sim.s,
          9,
          -12,
          0.45,
          perfect ? 0xf0e442 : 0xffffff,
          0.45,
        );
        a?.play(perfect ? 'perfect' : 'nearMiss', ox - sim.x, oy - sim.y, 0, perfect ? 1 : 0.8);
        this.haptic(perfect ? 'perfect' : 'nearMiss');
        if (this.settings.popups && this.project(ox, oy + 0.6, sim.s + 2)) {
          const pts = Math.round(d[o]!);
          let text = NEAR_TEXT[pts];
          if (text === undefined) {
            text = `+${pts}`;
            NEAR_TEXT[pts] = text;
          }
          if (perfect) text = `PERFECT ${text}`;
          this.popups.show(text, tmp.x, tmp.y, perfect ? 'perfect' : '');
        }
        break;
      }
      case EV.COMBO_UP: {
        const combo = d[o]!;
        if (combo >= 2) a?.play('combo', 0, 0, 0, Math.min(1, combo / 16));
        break;
      }
      case EV.SHARD: {
        this.particles.burst(10, d[o]!, d[o + 1]!, d[o + 2]!, 5, 0, 0.4, 0x56b4e9, 0.35);
        a?.play('shard', d[o]! - sim.x, d[o + 1]! - sim.y, 0, 0.7);
        this.haptic('shard');
        break;
      }
      case EV.BOOST_START:
        this.particles.burst(18, sim.x, sim.y, sim.s - 1.2, 6, -25, 0.5, 0xe69f00, 0.5);
        a?.play('boost');
        this.haptic('boost');
        break;
      case EV.ABILITY: {
        const ab = d[o]!;
        const color = ABILITY_COLORS[ab] ?? 0xffffff;
        if (ab === ABILITY_PULSE) {
          this.particles.burst(80, sim.x, sim.y, sim.s + 4, 30, 20, 0.7, color, 0.6, true);
          this.doFlash(0xffffff, 0.18);
          this.rig.addTrauma(0.35);
        } else if (ab === ABILITY_PHASE) {
          this.particles.burst(40, sim.x, sim.y, sim.s, 4, 0, 0.8, color, 0.5);
        } else if (ab === ABILITY_OVERDRIVE) {
          this.particles.burst(40, sim.x, sim.y, sim.s - 1, 10, -35, 0.6, color, 0.6);
          this.rig.addTrauma(0.2);
        } else if (ab === ABILITY_MAGNET) {
          this.particles.burst(36, sim.x, sim.y, sim.s, 6, 0, 0.9, color, 0.4, true);
        }
        a?.play(ABILITY_CUES[ab] ?? 'abilityPhase');
        this.haptic('ability');
        break;
      }
      case EV.ABILITY_READY:
        a?.play('abilityReady');
        this.haptic('abilityReady');
        break;
      case EV.OBSTACLE_DESTROYED:
        this.particles.burst(14, d[o + 2]!, d[o + 3]!, d[o + 4]!, 8, 0, 0.6, 0xd55e00, 0.6);
        break;
      case EV.DEATH:
        this.particles.burst(140, d[o]!, d[o + 1]!, d[o + 2]!, 14, 6, 1.4, 0xd55e00, 0.8);
        this.particles.burst(60, d[o]!, d[o + 1]!, d[o + 2]!, 9, 4, 1.0, 0xffffff, 0.5);
        this.particles.burst(40, d[o]!, d[o + 1]!, d[o + 2]!, 5, 2, 1.8, 0xe69f00, 0.9);
        this.doFlash(0xd55e00, 0.3);
        a?.play('death');
        this.haptic('death');
        break;
      case EV.REVIVE:
        this.particles.burst(50, d[o]!, d[o + 1]!, d[o + 2]!, 7, 0, 0.9, 0x56b4e9, 0.5, true);
        a?.play('revive');
        break;
      case EV.MILESTONE: {
        const km = Math.round(d[o]! / 1000);
        if (this.settings.popups) this.popups.show(`${km} KM`, this.width / 2, this.height * 0.3, 'big');
        a?.play('milestone');
        this.haptic('milestone');
        break;
      }
      case EV.BIOME_CHANGE: {
        const b = BIOMES[d[o]!];
        if (b && this.settings.popups)
          this.popups.show(b.name.toUpperCase(), this.width / 2, this.height * 0.22, 'big');
        a?.setBiome(d[o]!);
        a?.play('biome');
        break;
      }
      default:
        break;
    }
  }

  /** Per frame (allocation-free): danger estimate for the music, flash decay, music state. */
  update(dt: number, s: number, running: boolean, focusWarp: number): void {
    this.shipS = s;
    const sim = this.sim;
    this.danger01 += (this.estimateDanger() - this.danger01) * (1 - Math.exp(-dt * 3));
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * this.flashDecay);
      this.post.grading.uFlash.value = this.flash;
    }
    const cruise = sim.current.cruise;
    const speed01 = Math.min(
      1,
      Math.max(0, (cruise - TUNING.SPEED_MIN) / (TUNING.SPEED_MAX - TUNING.SPEED_MIN)),
    );
    this.audio?.setMusicState(speed01, this.danger01, sim.boosting, sim.focusActive, running);
    this.audio?.setTimeWarp(focusWarp);
  }

  /** 1 − fraction of free lattice cells over the next ~1 s of slices (from the chunk certificates). */
  private estimateDanger(): number {
    const sim = this.sim;
    let free = 0;
    let total = 0;
    const horizon = sim.s + sim.speed * 1.0;
    for (let k = 0; k <= 1; k++) {
      const c = sim.chunk(sim.chunkIndex + k);
      if (!c || c.sliceCount === 0) continue;
      let k0 = Math.floor((sim.s - c.startS) / c.sliceLen);
      let k1 = Math.floor((horizon - c.startS) / c.sliceLen);
      if (k0 < 0) k0 = 0;
      if (k1 > c.sliceCount - 1) k1 = c.sliceCount - 1;
      for (let q = k0; q <= k1; q++) {
        free += popcountRows(c.free, q * ROWS);
        total += ROWS * COLS;
      }
    }
    if (total === 0) return 0;
    const blocked = 1 - free / total;
    return Math.min(1, blocked * 2.2);
  }
}
