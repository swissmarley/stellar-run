import { AUDIO_CUES, type CueId, MUSIC } from '../../data/audio.ts';
import { BIOMES } from '../../data/biomes.ts';
import { renderSfx, renderStem, STEM_RECIPES, semitonesToRate } from './synth.ts';

const LAYERS = MUSIC.layers.length;
const BIOME_COUNT = BIOMES.length;
/** Param events and source starts are scheduled this far ahead (s), so every source sees them in order. */
const LOOKAHEAD = 0.03;
/** Time constant (s) of the music pitch glide under time warp. */
const RATE_TAU = 0.12;
/** Fade (s) applied to a voice that is stolen while still sounding. */
const STEAL_FADE = 0.006;
/** Headroom before the limiter. */
const MASTER_HEADROOM = 0.8;
/** SFX bus low-pass cutoff (Hz) with no time warp (rendered buffers top out at 16 kHz). */
const SFX_LP_MAX = 15000;
/** Render jobs below this are SFX (cue index); above, STEM_JOB + biome * LAYERS + layer. */
const STEM_JOB = 1000;

function noop(): void {}

/** Index of each cue in AUDIO_CUES. */
export const CUE_INDEX: Readonly<Record<CueId, number>> = buildCueIndex();

function buildCueIndex(): Readonly<Record<CueId, number>> {
  const r: Partial<Record<CueId, number>> = {};
  for (let i = 0; i < AUDIO_CUES.length; i++) r[AUDIO_CUES[i]!.id] = i;
  return Object.freeze(r as Record<CueId, number>);
}

/** Clamps to [0, 1]; NaN maps to 0. */
export function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

function ramp(x: number, edge: number, width: number): number {
  const u = (x - edge) / width;
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

/**
 * Adaptive mix: final linear gain of each MUSIC.layers entry (in [0, layer.gain]). Pad is always on, bass and
 * drums follow speed (drums also while boosting, ducked under focus), the lead follows danger. `bias` (the
 * biome's music.bias) brings layers in earlier. Not running → the menu mix (pad only). Allocation-free with `out`.
 */
export function targetLayerGains(
  speed01: number,
  danger01: number,
  boosting: boolean,
  focus: boolean,
  running: boolean,
  bias = 0,
  out: Float32Array = new Float32Array(MUSIC.layers.length),
): Float32Array {
  const s = clamp01(speed01) + bias;
  const d = clamp01(danger01) + bias;
  for (let i = 0; i < MUSIC.layers.length; i++) {
    const layer = MUSIC.layers[i]!;
    let v = 0;
    if (!running) {
      v = layer.id === 'pad' ? MUSIC.menuPad : 0;
    } else if (layer.id === 'pad') {
      v = 1;
    } else if (layer.id === 'bass') {
      v = ramp(s, MUSIC.bassSpeed, MUSIC.ramp);
    } else if (layer.id === 'drums') {
      v = boosting ? 1 : ramp(s, MUSIC.drumsSpeed, MUSIC.ramp);
      if (focus) v *= 1 - MUSIC.focusDrumDuck;
    } else {
      v = ramp(d, MUSIC.leadDanger, MUSIC.ramp);
    }
    out[i] = v * layer.gain;
  }
  return out;
}

/** Semitones for intensity in [0, 1] across `range`, snapped to the nearest minor-pentatonic degree. */
export function pentatonicSemitones(intensity01: number, range: number): number {
  const target = clamp01(intensity01) * range;
  let best = 0;
  for (let s = 1; s <= range; s++) {
    const m = s % 12;
    if (m !== 0 && m !== 3 && m !== 5 && m !== 7 && m !== 10) continue;
    if (Math.abs(s - target) < Math.abs(best - target)) best = s;
  }
  return best;
}

/** Value of a setTargetAtTime curve `dt` seconds after it started at `v0`. */
export function rateAt(v0: number, target: number, tau: number, dt: number): number {
  return dt <= 0 ? v0 : target + (v0 - target) * Math.exp(-dt / tau);
}

/** Integral of that curve over [0, dt]: buffer-seconds a source advances while its playback rate glides. */
export function rateIntegral(v0: number, target: number, tau: number, dt: number): number {
  if (dt <= 0) return 0;
  return target * dt + (v0 - target) * tau * (1 - Math.exp(-dt / tau));
}

/** First free voice in [base, base + count), else the one that ends soonest (to be stolen). */
export function pickVoice(ends: Float64Array, base: number, count: number, now: number): number {
  let best = base;
  for (let k = base; k < base + count; k++) {
    if (ends[k]! <= now) return k;
    if (ends[k]! < ends[best]!) best = k;
  }
  return best;
}

/** Perceptual volume curve for 0..1 sliders. */
export function volumeCurve(v: number): number {
  const c = clamp01(v);
  return c * c;
}

interface Graph {
  readonly master: GainNode;
  readonly musicBus: GainNode;
  readonly musicLp: BiquadFilterNode;
  readonly sfxBus: GainNode;
  readonly sfxLp: BiquadFilterNode;
  /** Crossfade gain of each music slot. */
  readonly slotOut: readonly GainNode[];
  /** Adaptive layer gains, [slot * LAYERS + layer]. */
  readonly mix: readonly GainNode[];
  readonly voiceGain: readonly GainNode[];
  readonly voicePan: readonly (PannerNode | null)[];
}

function newContext(): AudioContext | null {
  const w = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  try {
    if (w.AudioContext) return new w.AudioContext({ latencyHint: 'interactive' });
    if (w.webkitAudioContext) return new w.webkitAudioContext();
  } catch {
    return null;
  }
  return null;
}

function place(p: PannerNode, x: number, y: number, z: number, t: number): void {
  if (p.positionX) {
    p.positionX.setValueAtTime(x, t);
    p.positionY.setValueAtTime(y, t);
    p.positionZ.setValueAtTime(z, t);
  } else {
    p.setPosition(x, y, z);
  }
}

/**
 * Web Audio engine: pooled SFX voices (optionally spatial) and adaptive music made of 4 looping stems that
 * always start together and are mixed by gain. Buffers are synthesised after unlock(): SFX first, then the
 * stems of the current biome, then the next biome is prefetched. Pitched stems are rendered per biome root
 * (no tempo change); the drums are shared. A biome change crossfades to the new stems in phase with the old
 * ones: both slots follow one "music clock" that integrates the time-warp playback-rate curve analytically.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  private userSuspended = false;
  private primed = false;
  private vMaster = 1;
  private vMusic = 1;
  private vSfx = 1;
  private speed = 0;
  private running = false;
  private biome = 0;
  private warp = 0;
  private readonly targets = new Float32Array(LAYERS);
  private readonly sent = new Float32Array(LAYERS).fill(-1);
  private sentCutoff = -1;
  private sentQ = -1;
  private sentSfxCutoff = -1;
  // Music clock: current setTargetAtTime segment of the shared playback rate.
  private segT = 0;
  private segV = 1;
  private segTarget = 1;
  private segClock = 0;
  // Two music slots for crossfades; slotStart is the music-clock time of loop position 0.
  private cur = 0;
  /** Context time after which the faded-out slot's sources are released (0 = nothing pending). */
  private releaseAt = 0;
  private readonly slotActive = [false, false];
  private readonly slotBiome = new Int32Array(2);
  private readonly slotStart = new Float64Array(2);
  private readonly slotSrc: (AudioBufferSourceNode | null)[] = new Array(2 * LAYERS).fill(null);
  // Rendered buffers and the render queue.
  private readonly sfx: (AudioBuffer | null)[] = new Array(AUDIO_CUES.length).fill(null);
  private sfxDone = 0;
  private readonly stems: (AudioBuffer | null)[] = new Array(BIOME_COUNT * LAYERS).fill(null);
  private readonly shared: (AudioBuffer | null)[] = new Array(LAYERS).fill(null);
  private readonly urlFailed: boolean[] = new Array(LAYERS).fill(false);
  private readonly queue: number[] = [];
  private pumping = false;
  // SFX voices: cue i owns voices [cueVoice[i], cueVoice[i] + voices).
  private readonly cueVoice = new Int32Array(AUDIO_CUES.length);
  private readonly voiceEnd: Float64Array;
  private readonly voiceSrc: (AudioBufferSourceNode | null)[];
  private readonly lastPlay = new Float64Array(AUDIO_CUES.length).fill(-1e9);

  constructor() {
    let n = 0;
    for (let i = 0; i < AUDIO_CUES.length; i++) {
      this.cueVoice[i] = n;
      n += AUDIO_CUES[i]!.voices;
    }
    this.voiceEnd = new Float64Array(n);
    this.voiceSrc = new Array(n).fill(null);
  }

  /** True once every SFX buffer is rendered (music may still be rendering). */
  get ready(): boolean {
    return this.sfxDone >= AUDIO_CUES.length;
  }

  /** Call from a user gesture. Creates/resumes the context and starts rendering buffers (async, progressive). */
  unlock(): void {
    if (!this.ctx && !this.create()) return;
    const ctx = this.ctx!;
    if (this.userSuspended) return;
    if (ctx.state !== 'running') ctx.resume().catch(noop);
    if (!this.primed || ctx.state !== 'running') {
      // iOS: starting a silent buffer inside the gesture fully opens the output.
      this.primed = true;
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);
    }
  }

  /** 0..1 each, perceptual curve, smoothed. */
  setVolumes(master: number, music: number, sfx: number): void {
    this.vMaster = clamp01(master);
    this.vMusic = clamp01(music);
    this.vSfx = clamp01(sfx);
    this.applyVolumes(0.05);
  }

  /** Every frame, allocation-free. speed01, danger01 in [0,1]. running=false fades music to the menu mix. */
  setMusicState(
    speed01: number,
    danger01: number,
    boosting: boolean,
    focus: boolean,
    running: boolean,
  ): void {
    this.speed = clamp01(speed01);
    this.running = running;
    const g = this.g;
    if (!g) return;
    const bias = BIOMES[this.biome]!.music.bias;
    targetLayerGains(speed01, danger01, boosting, focus, running, bias, this.targets);
    const now = this.ctx!.currentTime;
    if (this.releaseAt > 0 && now >= this.releaseAt) this.releaseIdleSlot();
    for (let l = 0; l < LAYERS; l++) {
      const t = this.targets[l]!;
      const prev = this.sent[l]!;
      if (Math.abs(t - prev) < 0.01 && (t !== 0 || prev === 0)) continue;
      const tau = t > prev ? MUSIC.fadeIn : MUSIC.fadeOut;
      g.mix[l]!.gain.setTargetAtTime(t, now, tau);
      g.mix[LAYERS + l]!.gain.setTargetAtTime(t, now, tau);
      this.sent[l] = t;
    }
    this.updateFilters(0.25);
  }

  /** Biome index 0..3: re-keys the music to the biome root (crossfade when rendered) and sets its low-pass. */
  setBiome(index: number): void {
    if (!Number.isFinite(index)) return;
    const b = ((Math.floor(index) % BIOME_COUNT) + BIOME_COUNT) % BIOME_COUNT;
    if (b === this.biome) return;
    this.biome = b;
    if (!this.g) return;
    this.updateFilters(0.6);
    this.requestBiome(b, true);
    this.requestBiome((b + 1) % BIOME_COUNT, false);
    const s = this.cur;
    if (this.slotActive[s] && this.slotBiome[s] !== b && this.biomeReady(b)) this.startSlot(b);
    this.pump();
  }

  /**
   * One-shot cue. x/y/z = position relative to the listener in metres (listener at origin looking down -Z,
   * +X right, +Y up); omit for non-spatial. intensity 0..1 scales gain (and pitch, for intensityPitch cues).
   */
  play(cue: CueId, x?: number, y?: number, z?: number, intensity = 1): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g || ctx.state !== 'running') return;
    const i = CUE_INDEX[cue];
    const buf = this.sfx[i];
    if (!buf) return;
    const def = AUDIO_CUES[i]!;
    const now = ctx.currentTime;
    if (now - this.lastPlay[i]! < def.cooldownMs * 0.001) return;
    this.lastPlay[i] = now;

    const k = pickVoice(this.voiceEnd, this.cueVoice[i]!, def.voices, now);
    const vg = g.voiceGain[k]!.gain;
    let when = now;
    const old = this.voiceSrc[k];
    if (old) {
      if (this.voiceEnd[k]! > now) {
        when = now + STEAL_FADE;
        vg.cancelScheduledValues(now);
        vg.setValueAtTime(vg.value, now);
        vg.linearRampToValueAtTime(0, when);
        try {
          old.stop(when);
        } catch {
          old.disconnect();
        }
      } else {
        old.disconnect();
      }
    }

    const level = clamp01(intensity);
    let amp = def.gain * level;
    let semis = (Math.random() * 2 - 1) * def.pitchVariance + MUSIC.sfxFocusPitch * this.warp;
    if (def.intensityPitch !== undefined) {
      semis += pentatonicSemitones(level, def.intensityPitch);
      amp = def.gain * (0.5 + 0.5 * level);
    }
    const rate = semitonesToRate(semis);
    vg.setValueAtTime(amp, when);
    const pan = g.voicePan[k];
    if (pan) {
      if (x === undefined) place(pan, 0, 0, -1, when);
      else place(pan, x, y ?? 0, z ?? 0, when);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(g.voiceGain[k]!);
    src.start(when);
    this.voiceSrc[k] = src;
    this.voiceEnd[k] = when + buf.duration / rate;
  }

  /** Suspends the context (battery). unlock() will not resume it until resume() is called. */
  suspend(): void {
    this.userSuspended = true;
    const ctx = this.ctx;
    if (ctx && ctx.state === 'running') ctx.suspend().catch(noop);
  }

  resume(): void {
    this.userSuspended = false;
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(noop);
  }

  /** Focus slow-mo: pitch/LPF dip on the music and SFX bus (0 = normal, 1 = full slow-mo). Allocation-free, per frame. */
  setTimeWarp(amount01: number): void {
    const a = clamp01(amount01);
    if (a === this.warp || (a !== 0 && a !== 1 && Math.abs(a - this.warp) < 0.02)) return;
    this.warp = a;
    const ctx = this.ctx;
    if (!ctx || !this.g) return;
    const te = ctx.currentTime + LOOKAHEAD;
    const target = semitonesToRate(MUSIC.focusPitch * a);
    // Close the current rate segment at te and open a new one; the clock stays continuous.
    this.segClock = this.clockAt(te);
    this.segV = this.rateAtTime(te);
    this.segT = te;
    this.segTarget = target;
    for (let i = 0; i < this.slotSrc.length; i++)
      this.slotSrc[i]?.playbackRate.setTargetAtTime(target, te, RATE_TAU);
    this.updateFilters(0.06);
  }

  private create(): boolean {
    const ctx = newContext();
    if (!ctx) return false;
    this.ctx = ctx;
    this.g = this.buildGraph(ctx);
    const r = semitonesToRate(MUSIC.focusPitch * this.warp);
    this.segT = 0;
    this.segV = r;
    this.segTarget = r;
    this.segClock = 0;
    this.applyVolumes(0.01);
    this.setMusicState(this.speed, 0, false, false, this.running);
    for (let i = 0; i < AUDIO_CUES.length; i++) this.queue.push(i);
    this.requestBiome(this.biome, false);
    this.requestBiome((this.biome + 1) % BIOME_COUNT, false);
    this.pump();
    return true;
  }

  private buildGraph(ctx: AudioContext): Graph {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    const master = ctx.createGain();
    master.connect(comp);

    const musicBus = ctx.createGain();
    musicBus.connect(master);
    const musicLp = ctx.createBiquadFilter();
    musicLp.type = 'lowpass';
    musicLp.connect(musicBus);
    const slotOut: GainNode[] = [];
    const mix: GainNode[] = [];
    for (let s = 0; s < 2; s++) {
      const o = ctx.createGain();
      o.gain.value = 0;
      o.connect(musicLp);
      slotOut.push(o);
      for (let l = 0; l < LAYERS; l++) {
        const m = ctx.createGain();
        m.gain.value = 0;
        m.connect(o);
        mix.push(m);
      }
    }

    const sfxBus = ctx.createGain();
    sfxBus.connect(master);
    const sfxLp = ctx.createBiquadFilter();
    sfxLp.type = 'lowpass';
    sfxLp.frequency.value = SFX_LP_MAX;
    sfxLp.connect(sfxBus);
    const voiceGain: GainNode[] = [];
    const voicePan: (PannerNode | null)[] = [];
    for (let i = 0; i < AUDIO_CUES.length; i++) {
      const def = AUDIO_CUES[i]!;
      for (let v = 0; v < def.voices; v++) {
        const vg = ctx.createGain();
        vg.gain.value = 0;
        let pan: PannerNode | null = null;
        if (def.spatial) {
          pan = ctx.createPanner();
          pan.panningModel = 'equalpower';
          pan.distanceModel = 'inverse';
          pan.refDistance = 1.5;
          pan.maxDistance = 60;
          pan.rolloffFactor = 0.8;
          vg.connect(pan);
          pan.connect(sfxLp);
        } else {
          vg.connect(sfxLp);
        }
        voiceGain.push(vg);
        voicePan.push(pan);
      }
    }
    return { master, musicBus, musicLp, sfxBus, sfxLp, slotOut, mix, voiceGain, voicePan };
  }

  private applyVolumes(tau: number): void {
    const g = this.g;
    if (!g) return;
    const now = this.ctx!.currentTime;
    g.master.gain.setTargetAtTime(volumeCurve(this.vMaster) * MASTER_HEADROOM, now, tau);
    g.musicBus.gain.setTargetAtTime(volumeCurve(this.vMusic), now, tau);
    g.sfxBus.gain.setTargetAtTime(volumeCurve(this.vSfx), now, tau);
  }

  /** Music low-pass (biome cutoff, opened by speed, darker in the menu, dipped by warp) and SFX low-pass. */
  private updateFilters(tau: number): void {
    const g = this.g;
    if (!g) return;
    const now = this.ctx!.currentTime;
    const w = this.warp;
    const open = this.running ? 1 - MUSIC.speedOpen * (1 - this.speed) : MUSIC.menuCutoff;
    const base = BIOMES[this.biome]!.music.cutoff * open;
    const cutoff = base * (MUSIC.focusCutoff / base) ** w;
    if (Math.abs(cutoff - this.sentCutoff) > cutoff * 0.01) {
      g.musicLp.frequency.setTargetAtTime(cutoff, now, tau);
      this.sentCutoff = cutoff;
    }
    const q = Math.SQRT1_2 + (MUSIC.focusQ - Math.SQRT1_2) * w;
    if (Math.abs(q - this.sentQ) > 0.01) {
      g.musicLp.Q.setTargetAtTime(q, now, tau);
      this.sentQ = q;
    }
    const sfxCut = SFX_LP_MAX * (MUSIC.sfxFocusCutoff / SFX_LP_MAX) ** w;
    if (Math.abs(sfxCut - this.sentSfxCutoff) > sfxCut * 0.01) {
      g.sfxLp.frequency.setTargetAtTime(sfxCut, now, tau);
      this.sentSfxCutoff = sfxCut;
    }
  }

  private clockAt(t: number): number {
    return this.segClock + rateIntegral(this.segV, this.segTarget, RATE_TAU, t - this.segT);
  }

  private rateAtTime(t: number): number {
    return rateAt(this.segV, this.segTarget, RATE_TAU, t - this.segT);
  }

  // ---- Music slots ----

  /** Starts biome `b` in a slot; if music is playing, crossfades to it in phase with the current loop. */
  private startSlot(b: number): void {
    const ctx = this.ctx!;
    const g = this.g!;
    const now = ctx.currentTime;
    const prev = this.cur;
    const xfade = this.slotActive[prev]!;
    const s = xfade ? 1 - prev : prev;
    this.stopSlot(s, now, true);
    const when = now + LOOKAHEAD + (xfade ? 0.02 : 0);
    const clock = this.clockAt(when);
    this.slotStart[s] = xfade ? this.slotStart[prev]! : clock;
    for (let l = 0; l < LAYERS; l++) {
      const buf = this.stemFor(b, l);
      if (buf) this.startSource(s, l, buf, when, clock);
    }
    const out = g.slotOut[s]!.gain;
    out.cancelScheduledValues(now);
    out.setValueAtTime(0, now);
    out.setTargetAtTime(1, when, xfade ? MUSIC.crossfade : MUSIC.fadeIn * 2);
    if (xfade) {
      const po = g.slotOut[prev]!.gain;
      po.cancelScheduledValues(now);
      po.setValueAtTime(po.value, now);
      po.setTargetAtTime(0, when, MUSIC.crossfade);
      this.stopSlot(prev, when + MUSIC.crossfade * 6, false);
      this.slotActive[prev] = false;
      this.releaseAt = when + MUSIC.crossfade * 6 + 0.1;
    }
    this.slotActive[s] = true;
    this.slotBiome[s] = b;
    this.cur = s;
  }

  /** Stops a slot's sources at `at`; `release` also drops the references (the slot is being reused). */
  private stopSlot(s: number, at: number, release: boolean): void {
    for (let l = 0; l < LAYERS; l++) {
      const i = s * LAYERS + l;
      const src = this.slotSrc[i];
      if (!src) continue;
      try {
        src.stop(at);
      } catch {
        src.disconnect();
      }
      if (release) this.slotSrc[i] = null;
    }
  }

  /** Drops the faded-out slot's stopped sources so their buffers can be collected. */
  private releaseIdleSlot(): void {
    this.releaseAt = 0;
    const s = 1 - this.cur;
    for (let l = 0; l < LAYERS; l++) {
      const src = this.slotSrc[s * LAYERS + l];
      if (!src) continue;
      src.disconnect();
      this.slotSrc[s * LAYERS + l] = null;
    }
  }

  /** Starts a looping stem in slot `s` at `when` (music-clock time `clock`), at the slot's loop phase. */
  private startSource(s: number, l: number, buf: AudioBuffer, when: number, clock: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // Same rate curve as every other music source: anchor at the current segment's value, then glide.
    const ta = ctx.currentTime + LOOKAHEAD;
    const v = this.rateAtTime(ta);
    src.playbackRate.value = v;
    src.playbackRate.setValueAtTime(v, ta);
    src.playbackRate.setTargetAtTime(this.segTarget, ta, RATE_TAU);
    src.connect(this.g!.mix[s * LAYERS + l]!);
    const d = buf.duration;
    const pos = (clock - this.slotStart[s]!) % d;
    src.start(when, pos < 0 ? pos + d : pos);
    this.slotSrc[s * LAYERS + l] = src;
  }

  /** Adds a layer that finished rendering to the playing slot, in phase, with a short fade-in. */
  private joinLayer(s: number, l: number, buf: AudioBuffer): void {
    const now = this.ctx!.currentTime;
    const when = now + LOOKAHEAD;
    const m = this.g!.mix[s * LAYERS + l]!.gain;
    m.cancelScheduledValues(now);
    m.setValueAtTime(0, now);
    m.setTargetAtTime(Math.max(0, this.sent[l]!), when, MUSIC.fadeIn);
    this.startSource(s, l, buf, when, this.clockAt(when));
  }

  // ---- Buffers and the render queue ----

  private isShared(l: number): boolean {
    const layer = MUSIC.layers[l]!;
    return (layer.url !== undefined && !this.urlFailed[l]) || !STEM_RECIPES[layer.id].pitched;
  }

  private stemFor(b: number, l: number): AudioBuffer | null {
    return this.isShared(l) ? this.shared[l]! : this.stems[b * LAYERS + l]!;
  }

  /** Every per-biome stem of `b` is rendered (shared stems join when they are ready). */
  private biomeReady(b: number): boolean {
    for (let l = 0; l < LAYERS; l++) if (!this.isShared(l) && !this.stems[b * LAYERS + l]) return false;
    return true;
  }

  /** Biomes kept in memory: the current one and the next MUSIC.cacheBiomes - 1 in cycle order. */
  private wanted(b: number): boolean {
    return (b - this.biome + BIOME_COUNT) % BIOME_COUNT < MUSIC.cacheBiomes;
  }

  /** Queues the missing stems of biome `b`; `urgent` puts them right after any pending SFX. */
  private requestBiome(b: number, urgent: boolean): void {
    let at = this.queue.length;
    if (urgent) {
      at = 0;
      while (at < this.queue.length && this.queue[at]! < STEM_JOB) at++;
    }
    for (let l = 0; l < LAYERS; l++) {
      const shared = this.isShared(l);
      if ((shared ? this.shared[l] : this.stems[b * LAYERS + l]) !== null) continue;
      const job = STEM_JOB + (shared ? 0 : b) * LAYERS + l;
      const i = this.queue.indexOf(job);
      if (i >= 0) {
        if (!urgent || i < at) continue;
        this.queue.splice(i, 1);
      }
      this.queue.splice(at, 0, job);
      at++;
    }
  }

  private pump(): void {
    if (this.pumping || this.queue.length === 0) return;
    this.pumping = true;
    this.drain().catch(noop);
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        await this.runJob(job);
      } catch (err) {
        console.warn('[audio] render failed', err);
      }
    }
    this.pumping = false;
  }

  private async runJob(job: number): Promise<void> {
    if (job < STEM_JOB) {
      const def = AUDIO_CUES[job]!;
      try {
        this.sfx[job] = (def.url ? await this.load(def.url) : null) ?? (await renderSfx(def.recipe));
      } finally {
        this.sfxDone++;
      }
      return;
    }
    const k = job - STEM_JOB;
    const b = Math.floor(k / LAYERS);
    const l = k % LAYERS;
    const layer = MUSIC.layers[l]!;
    const root = BIOMES[b]!.music.root;
    if (this.isShared(l) && this.shared[l]) return;
    if (layer.url !== undefined && !this.urlFailed[l]) {
      const buf = await this.load(layer.url);
      if (buf) this.shared[l] = buf;
      else {
        // Fall back to the recipe for this layer.
        this.urlFailed[l] = true;
        this.requestBiome(this.biome, true);
      }
    } else if (!STEM_RECIPES[layer.id].pitched) {
      this.shared[l] = await renderStem(layer.id, root);
    } else {
      // Skip stale prefetches and keep at most MUSIC.cacheBiomes biomes of pitched stems in memory.
      if (!this.wanted(b) || this.stems[k]) return;
      for (let x = 0; x < BIOME_COUNT; x++) {
        if (this.wanted(x)) continue;
        for (let y = 0; y < LAYERS; y++) this.stems[x * LAYERS + y] = null;
      }
      this.stems[k] = await renderStem(layer.id, root);
    }
    this.onStemReady();
  }

  /** Starts the music, joins a new layer into the playing loop, or switches to the current biome when complete. */
  private onStemReady(): void {
    const s = this.cur;
    const b = this.biome;
    if (!this.slotActive[s]) {
      for (let l = 0; l < LAYERS; l++) {
        if (this.stemFor(b, l)) {
          this.startSlot(b);
          return;
        }
      }
      return;
    }
    if (this.slotBiome[s] !== b) {
      if (this.biomeReady(b)) this.startSlot(b);
      return;
    }
    for (let l = 0; l < LAYERS; l++) {
      if (this.slotSrc[s * LAYERS + l]) continue;
      const buf = this.stemFor(b, l);
      if (buf) this.joinLayer(s, l, buf);
    }
  }

  /** Same-origin file → decoded buffer, or null (the caller falls back to the recipe). */
  private async load(url: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      const u = new URL(url, document.baseURI);
      if (u.origin !== location.origin) return null;
      const res = await fetch(u.href);
      if (!res.ok) return null;
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }
}
