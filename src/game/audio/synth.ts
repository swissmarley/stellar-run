import type { DrumLaneDef, MusicLayerId } from '../../data/audio.ts';
import { AUDIO_CUES, AUDIO_RENDER_RATE, MUSIC } from '../../data/audio.ts';

/** ADSR shape in seconds; `sustain` is a fraction of the peak, held for `hold` seconds. */
export interface Envelope {
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly hold: number;
  readonly release: number;
}

/** A one-shot cue built on an (offline) context into `out`, starting at t = 0. */
export interface SfxRecipe {
  /** Rendered length (s); every node is silent and stopped by then. */
  readonly duration: number;
  readonly build: (ctx: BaseAudioContext, out: AudioNode) => void;
}

/** A music stem: exactly one loop long, plus a tail that is folded back onto the loop start. */
export interface StemRecipe {
  /** Unpitched stems are rendered once and shared by every biome. */
  readonly pitched: boolean;
  /** Seconds rendered past the loop end (releases, echoes). */
  readonly tail: number;
  readonly build: (ctx: BaseAudioContext, out: AudioNode, root: number) => void;
}

const ENV_FLOOR = 1e-4;
const PEAK = 0.89;
/** Fallback rates if a browser rejects AUDIO_RENDER_RATE for offline rendering. */
const RATES = [AUDIO_RENDER_RATE, 44100, 48000];

// ---- Pure helpers (no Web Audio needed) ----

/** MIDI note to frequency (69 = A4 = 440 Hz). */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Playback-rate factor for a pitch shift in semitones. */
export function semitonesToRate(semitones: number): number {
  return 2 ** (semitones / 12);
}

/** Envelope shorthand. */
export function env(attack: number, decay: number, sustain: number, hold: number, release: number): Envelope {
  return { attack, decay, sustain, hold, release };
}

export function envLength(e: Envelope): number {
  return e.attack + e.decay + e.hold + e.release;
}

/** Breakpoints as a flat [t, v, ...] list from t0: 0 → peak → sustain·peak (held) → 0. */
export function envelopeBreakpoints(e: Envelope, t0: number, peak: number): number[] {
  const ta = t0 + e.attack;
  const td = ta + e.decay;
  const th = td + e.hold;
  const s = peak * e.sustain;
  return [t0, 0, ta, peak, td, s, th, s, th + e.release, 0];
}

/** Seconds per grid step (a 16th note). */
export function stepSeconds(): number {
  return 60 / MUSIC.bpm / 4;
}

export function stepsPerBar(): number {
  return MUSIC.beatsPerBar * 4;
}

export function loopSeconds(): number {
  return MUSIC.bars * stepsPerBar() * stepSeconds();
}

/** Loop length in frames; every recipe stem has exactly this length, so layers never drift. */
export function loopFrames(rate: number = AUDIO_RENDER_RATE): number {
  return Math.round(loopSeconds() * rate);
}

/** Chord (semitones from the root) sounding in `bar`; the progression is spread evenly over the loop. */
export function chordForBar(bar: number): readonly number[] {
  const p = MUSIC.progression;
  return p[Math.floor((bar * p.length) / MUSIC.bars) % p.length]!;
}

/** Step character of a grid cycled across bars. */
export function gridAt(grid: string, bar: number, step: number): string {
  return grid[(bar * stepsPerBar() + step) % grid.length]!;
}

/** Velocity of a drum step: '1'..'9' → 1/9..1, anything else → 0. */
export function stepVelocity(ch: string): number {
  const d = ch.charCodeAt(0) - 48;
  return d >= 1 && d <= 9 ? d / 9 : 0;
}

/** Adds everything past `loop` frames onto the start (wrapping tails) in place; returns the loop view. */
export function foldLoopTail(data: Float32Array, loop: number): Float32Array {
  for (let i = loop; i < data.length; i++) data[(i - loop) % loop]! += data[i]!;
  return data.subarray(0, loop);
}

/** Scales `data` in place to an absolute peak of `peak` (silence is left alone). Returns the factor. */
export function normalizePeak(data: Float32Array, peak: number): number {
  let m = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]!);
    if (a > m) m = a;
  }
  if (m < 1e-6) return 1;
  const k = peak / m;
  for (let i = 0; i < data.length; i++) data[i]! *= k;
  return k;
}

/** Linear fade over the last `frames` frames (guards against clicks at the buffer end). */
export function fadeTail(data: Float32Array, frames: number): void {
  const n = Math.min(frames, data.length);
  for (let i = 0; i < n; i++) data[data.length - 1 - i]! *= i / n;
}

// ---- Graph helpers (only called while building on a context) ----

const NOISE = new WeakMap<BaseAudioContext, AudioBuffer>();
let noiseSeq = 0;

function applyEnvelope(p: AudioParam, pts: readonly number[]): void {
  p.setValueAtTime(0, pts[0]!);
  p.linearRampToValueAtTime(pts[3]!, pts[2]!);
  for (let i = 4; i < pts.length; i += 2)
    p.exponentialRampToValueAtTime(Math.max(pts[i + 1]!, ENV_FLOOR), pts[i]!);
  p.setValueAtTime(0, pts[pts.length - 2]!);
}

function gain(ctx: BaseAudioContext, dest: AudioNode, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  g.connect(dest);
  return g;
}

function amp(ctx: BaseAudioContext, dest: AudioNode, e: Envelope, t0: number, peak: number): GainNode {
  const g = gain(ctx, dest, 0);
  applyEnvelope(g.gain, envelopeBreakpoints(e, t0, peak));
  return g;
}

function filter(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q: number,
  dest: AudioNode,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.connect(dest);
  return f;
}

function osc(
  ctx: BaseAudioContext,
  type: OscillatorType,
  f0: number,
  t0: number,
  dur: number,
  dest: AudioNode,
  f1 = f0,
  glide = 0,
  detune = 0,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (glide > 0 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + glide);
  o.detune.value = detune;
  o.connect(dest);
  o.start(t0);
  o.stop(t0 + dur);
  return o;
}

function lfo(
  ctx: BaseAudioContext,
  rate: number,
  depth: number,
  target: AudioParam,
  t0: number,
  dur: number,
): void {
  const o = ctx.createOscillator();
  o.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g);
  g.connect(target);
  o.start(t0);
  o.stop(t0 + dur);
}

function noise(ctx: BaseAudioContext, t0: number, dur: number, dest: AudioNode): void {
  let buf = NOISE.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 0x2f6b9a35;
    for (let i = 0; i < d.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[i] = (s >>> 0) / 2147483648 - 1;
    }
    NOISE.set(ctx, buf);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(dest);
  src.start(t0, (noiseSeq++ * 0.381966) % 0.9);
  src.stop(t0 + dur);
}

function sweep(p: AudioParam, from: number, to: number, t0: number, dur: number): void {
  p.setValueAtTime(from, t0);
  p.exponentialRampToValueAtTime(to, t0 + dur);
}

function drive(ctx: BaseAudioContext, amount: number, dest: AudioNode): WaveShaperNode {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(amount * ((i / (n - 1)) * 2 - 1)) / norm;
  const w = ctx.createWaveShaper();
  w.curve = curve;
  w.oversample = '2x';
  w.connect(dest);
  return w;
}

/** Doppler-ish pass-by: band-passed noise with a falling centre, an air hiss and a falling zip. */
function passBy(ctx: BaseAudioContext, out: AudioNode, level: number): void {
  const body = env(0.03, 0.06, 0.55, 0.02, 0.2);
  const bp = filter(ctx, 'bandpass', 2600, 1.4, amp(ctx, out, body, 0, level));
  sweep(bp.frequency, 2600, 650, 0.02, 0.26);
  noise(ctx, 0, envLength(body) + 0.005, bp);
  const low = env(0.03, 0.12, 0, 0, 0.04);
  noise(ctx, 0, envLength(low) + 0.005, filter(ctx, 'lowpass', 500, 0.7, amp(ctx, out, low, 0, level * 0.4)));
  const air = env(0.02, 0.08, 0, 0, 0.01);
  noise(
    ctx,
    0,
    envLength(air) + 0.005,
    filter(ctx, 'highpass', 5200, 0.7, amp(ctx, out, air, 0, level * 0.35)),
  );
  const zip = env(0.015, 0.17, 0, 0, 0.02);
  osc(ctx, 'sine', 1500, 0.02, envLength(zip) + 0.005, amp(ctx, out, zip, 0.02, level * 0.16), 420, 0.2);
}

function click(ctx: BaseAudioContext, out: AudioNode, level: number): void {
  const e = env(0.0005, 0.004, 0, 0, 0.002);
  noise(ctx, 0, 0.008, filter(ctx, 'highpass', 4000, 0.7, amp(ctx, out, e, 0, level)));
}

/** Procedural SFX recipes, keyed by CueDef.recipe. */
export const SFX_RECIPES: Readonly<Record<string, SfxRecipe>> = Object.freeze({
  /** uiClick: tiny bright tick. */
  tick: {
    duration: 0.04,
    build: (ctx, out) => {
      const e = env(0.0008, 0.022, 0, 0, 0.004);
      osc(ctx, 'sine', 2300, 0, 0.03, amp(ctx, out, e, 0, 0.6), 1900, 0.02);
      click(ctx, out, 0.3);
    },
  },
  /** uiBack: lower, falling tick. */
  tickDown: {
    duration: 0.06,
    build: (ctx, out) => {
      const e = env(0.001, 0.045, 0, 0, 0.006);
      osc(ctx, 'triangle', 1250, 0, 0.055, amp(ctx, out, e, 0, 0.7), 700, 0.04);
      click(ctx, out, 0.25);
    },
  },
  /** nearMiss: short pass-by whoosh (panned to the obstacle side by the engine). */
  passBy: { duration: 0.33, build: (ctx, out) => passBy(ctx, out, 1) },
  /** perfect: pass-by plus a bright detuned shimmer. */
  passByShimmer: {
    duration: 0.6,
    build: (ctx, out) => {
      passBy(ctx, out, 0.8);
      const notes = [88, 95, 100];
      for (let i = 0; i < notes.length; i++) {
        const t = 0.03 + i * 0.035;
        const f = midiToHz(notes[i]!);
        const e = env(0.004, 0.42, 0, 0, 0.05);
        const g = amp(ctx, out, e, t, 0.22);
        osc(ctx, 'sine', f, t, envLength(e) + 0.005, g, f, 0, -6);
        osc(ctx, 'sine', f, t, envLength(e) + 0.005, g, f, 0, 7);
      }
    },
  },
  /** shard: two-note glassy chime (inharmonic partials). */
  glassChime: {
    duration: 0.42,
    build: (ctx, out) => {
      const notes = [84, 91];
      for (let i = 0; i < notes.length; i++) {
        const t = i * 0.065;
        const f = midiToHz(notes[i]!);
        const e = env(0.002, 0.3, 0, 0, 0.04);
        osc(ctx, 'sine', f, t, envLength(e) + 0.003, amp(ctx, out, e, t, 0.5));
        const e2 = env(0.001, 0.11, 0, 0, 0.02);
        osc(ctx, 'sine', f * 2.76, t, envLength(e2) + 0.003, amp(ctx, out, e2, t, 0.22));
        const e3 = env(0.001, 0.05, 0, 0, 0.01);
        osc(ctx, 'sine', f * 5.4, t, envLength(e3) + 0.003, amp(ctx, out, e3, t, 0.08));
      }
    },
  },
  /** boost: rising filtered noise whoosh, engine lift and a low thump. */
  boostWhoosh: {
    duration: 0.85,
    build: (ctx, out) => {
      const w = env(0.3, 0.42, 0, 0, 0.08);
      const bp = filter(ctx, 'bandpass', 380, 1.1, amp(ctx, out, w, 0, 0.6));
      sweep(bp.frequency, 380, 3600, 0, 0.7);
      noise(ctx, 0, envLength(w) + 0.005, bp);
      const lift = env(0.2, 0.5, 0, 0, 0.08);
      const lp = filter(ctx, 'lowpass', 1400, 0.8, amp(ctx, out, lift, 0.02, 0.16));
      osc(ctx, 'sawtooth', 110, 0.02, envLength(lift) + 0.005, lp, 330, 0.6);
      const th = env(0.003, 0.28, 0, 0, 0.02);
      const g = amp(ctx, out, th, 0, 1);
      osc(ctx, 'sine', 120, 0, envLength(th) + 0.005, g, 42, 0.16);
      osc(ctx, 'triangle', 240, 0, envLength(th) + 0.005, gain(ctx, g, 0.3), 84, 0.16);
    },
  },
  /** death: overdriven noise explosion through a closing low-pass, crackle and a sub drop. */
  explosion: {
    duration: 1.25,
    build: (ctx, out) => {
      const e = env(0.004, 1.1, 0, 0, 0.1);
      const lp = filter(ctx, 'lowpass', 7000, 0.9, amp(ctx, out, e, 0, 0.9));
      sweep(lp.frequency, 7000, 180, 0.01, 1.1);
      noise(ctx, 0, envLength(e) + 0.005, drive(ctx, 3, lp));
      const c = env(0.002, 0.22, 0, 0, 0.03);
      noise(ctx, 0, envLength(c) + 0.005, filter(ctx, 'bandpass', 1400, 0.7, amp(ctx, out, c, 0, 0.5)));
      const s = env(0.01, 1.05, 0, 0, 0.1);
      osc(ctx, 'sine', 150, 0, envLength(s) + 0.005, amp(ctx, out, s, 0, 0.9), 28, 0.95);
      osc(ctx, 'triangle', 300, 0, envLength(s) + 0.005, amp(ctx, out, s, 0, 0.25), 56, 0.95);
    },
  },
  /** abilityPhase: shimmering detuned sweep with tremolo. */
  phaseSweep: {
    duration: 0.96,
    build: (ctx, out) => {
      const e = env(0.08, 0.25, 0.7, 0.3, 0.3);
      const trem = gain(ctx, amp(ctx, out, e, 0, 0.35), 0.7);
      lfo(ctx, 13, 0.3, trem.gain, 0, 0.95);
      const bp = filter(ctx, 'bandpass', 600, 2.5, trem);
      sweep(bp.frequency, 600, 2800, 0, 0.85);
      const detunes = [-25, -9, 9, 25];
      for (let i = 0; i < detunes.length; i++) osc(ctx, 'triangle', 280, 0, 0.94, bp, 1250, 0.85, detunes[i]);
      osc(ctx, 'sine', 560, 0, 0.94, bp, 2500, 0.85, 5);
    },
  },
  /** abilityOverdrive: aggressive rising saw sweep through a resonant, driven low-pass. */
  sawRise: {
    duration: 0.9,
    build: (ctx, out) => {
      const e = env(0.02, 0.2, 0.75, 0.45, 0.2);
      const lp = filter(ctx, 'lowpass', 500, 7, amp(ctx, out, e, 0, 0.42));
      sweep(lp.frequency, 500, 6500, 0, 0.7);
      const sh = drive(ctx, 4, lp);
      osc(ctx, 'sawtooth', 70, 0, 0.88, sh, 560, 0.7);
      osc(ctx, 'sawtooth', 70, 0, 0.88, sh, 560, 0.7, 12);
      osc(ctx, 'square', 35, 0, 0.88, gain(ctx, sh, 0.5), 280, 0.7);
    },
  },
  /** abilityPulse: deep boom, thud and a slow metallic ring. */
  boomRing: {
    duration: 1.22,
    build: (ctx, out) => {
      const b = env(0.003, 0.8, 0, 0, 0.1);
      const g = amp(ctx, out, b, 0, 1);
      osc(ctx, 'sine', 95, 0, envLength(b) + 0.005, g, 34, 0.45);
      osc(ctx, 'triangle', 190, 0, envLength(b) + 0.005, gain(ctx, g, 0.3), 68, 0.45);
      const n = env(0.002, 0.18, 0, 0, 0.02);
      noise(ctx, 0, envLength(n) + 0.005, filter(ctx, 'lowpass', 500, 0.8, amp(ctx, out, n, 0, 0.5)));
      const r = env(0.01, 1.05, 0, 0, 0.1);
      const d = envLength(r) + 0.005;
      const ring = osc(ctx, 'sine', 587, 0.02, d, amp(ctx, out, r, 0.02, 0.22));
      lfo(ctx, 5, 6, ring.frequency, 0.02, d);
      osc(ctx, 'sine', 587 * 2.02, 0.02, d, amp(ctx, out, r, 0.02, 0.08));
    },
  },
  /** abilityMagnet: warbling sines gliding up. */
  warble: {
    duration: 0.94,
    build: (ctx, out) => {
      const e = env(0.06, 0.2, 0.8, 0.4, 0.25);
      const a = osc(ctx, 'sine', 480, 0, 0.92, amp(ctx, out, e, 0, 0.4), 600, 0.9);
      lfo(ctx, 9, 40, a.frequency, 0, 0.92);
      const b = osc(ctx, 'sine', 720, 0, 0.92, amp(ctx, out, e, 0, 0.15), 900, 0.9);
      lfo(ctx, 6.5, 55, b.frequency, 0, 0.92);
    },
  },
  /** abilityReady: soft ping. */
  ping: {
    duration: 0.42,
    build: (ctx, out) => {
      const f = midiToHz(88);
      const e = env(0.003, 0.36, 0, 0, 0.04);
      osc(ctx, 'sine', f, 0, envLength(e) + 0.005, amp(ctx, out, e, 0, 0.45));
      const e2 = env(0.003, 0.18, 0, 0, 0.03);
      osc(ctx, 'sine', f * 2, 0, envLength(e2) + 0.005, amp(ctx, out, e2, 0, 0.1));
      const e3 = env(0.01, 0.28, 0, 0, 0.05);
      osc(ctx, 'triangle', midiToHz(83), 0.05, envLength(e3) + 0.005, amp(ctx, out, e3, 0.05, 0.2));
    },
  },
  /** revive: rising major arpeggio over a noise swell. */
  majorArp: {
    duration: 1.05,
    build: (ctx, out) => {
      const notes = [72, 76, 79, 84];
      for (let i = 0; i < notes.length; i++) {
        const t = i * 0.085;
        const f = midiToHz(notes[i]!);
        const e = i === notes.length - 1 ? env(0.004, 0.7, 0, 0, 0.06) : env(0.004, 0.3, 0, 0, 0.05);
        osc(ctx, 'triangle', f, t, envLength(e) + 0.005, amp(ctx, out, e, t, 0.32));
        osc(ctx, 'sine', f * 2, t, envLength(e) + 0.005, amp(ctx, out, e, t, 0.08));
      }
      const s = env(0.3, 0.2, 0, 0, 0.05);
      const bp = filter(ctx, 'bandpass', 400, 1, amp(ctx, out, s, 0, 0.12));
      sweep(bp.frequency, 400, 3000, 0, 0.5);
      noise(ctx, 0, envLength(s) + 0.005, bp);
    },
  },
  /** milestone: short brassy fanfare. */
  fanfare: {
    duration: 1.13,
    build: (ctx, out) => {
      const notes = [67, 72, 76, 79];
      const times = [0, 0.09, 0.18, 0.3];
      for (let i = 0; i < notes.length; i++) {
        const last = i === notes.length - 1;
        const t = times[i]!;
        const f = midiToHz(notes[i]!);
        const e = last ? env(0.01, 0.15, 0.7, 0.4, 0.25) : env(0.005, 0.08, 0.5, 0, 0.05);
        const d = envLength(e) + 0.005;
        const lp = filter(ctx, 'lowpass', 2800, 0.7, amp(ctx, out, e, t, 0.22));
        osc(ctx, 'square', f, t, d, lp);
        osc(ctx, 'sawtooth', f, t, d, lp, f, 0, 8);
        if (last) osc(ctx, 'triangle', f / 2, t, d, amp(ctx, out, e, t, 0.2));
      }
    },
  },
  /** combo: pitched blip (the engine transposes it with intensity). */
  blip: {
    duration: 0.13,
    build: (ctx, out) => {
      const f = midiToHz(79);
      const e = env(0.002, 0.09, 0, 0, 0.02);
      const lp = filter(ctx, 'lowpass', 4200, 1, amp(ctx, out, e, 0, 0.5));
      osc(ctx, 'square', f * 0.97, 0, envLength(e) + 0.003, lp, f, 0.012);
      osc(ctx, 'sine', f * 2, 0, envLength(e) + 0.003, amp(ctx, out, e, 0, 0.15));
    },
  },
  /** biome: airy transition swell with an open-fifth pad. */
  airSwell: {
    duration: 2.25,
    build: (ctx, out) => {
      const e = env(1, 0.3, 0.6, 0.2, 0.7);
      const bp = filter(ctx, 'bandpass', 300, 0.8, amp(ctx, out, e, 0, 0.5));
      sweep(bp.frequency, 300, 4200, 0, 1.4);
      noise(ctx, 0, envLength(e) + 0.005, bp);
      const p = env(1.1, 0.4, 0.5, 0.1, 0.55);
      const pad = [220, 330, 440];
      for (let i = 0; i < pad.length; i++)
        osc(ctx, 'sine', pad[i]!, 0.05, envLength(p) + 0.005, amp(ctx, out, p, 0.05, 0.1));
      const a = env(1.2, 0.2, 0, 0, 0.6);
      noise(ctx, 0, envLength(a) + 0.005, filter(ctx, 'highpass', 6000, 0.7, amp(ctx, out, a, 0, 0.15)));
    },
  },
});

// ---- Music stems ----

function laneVelocity(lane: DrumLaneDef, last: boolean, step: number): number {
  const g = last ? lane.fill : lane.grid;
  return stepVelocity(g[step % g.length]!);
}

function kick(ctx: BaseAudioContext, out: AudioNode, t: number, v: number): void {
  const e = env(0.002, 0.26, 0, 0, 0.03);
  const g = amp(ctx, out, e, t, 0.95 * v);
  osc(ctx, 'sine', 150, t, envLength(e) + 0.005, g, 48, 0.08);
  osc(ctx, 'triangle', 300, t, 0.1, amp(ctx, out, env(0.001, 0.07, 0, 0, 0.01), t, 0.25 * v), 96, 0.08);
  const c = env(0.0005, 0.004, 0, 0, 0.002);
  noise(ctx, t, 0.008, filter(ctx, 'highpass', 3000, 0.7, amp(ctx, out, c, t, 0.3 * v)));
}

function snare(ctx: BaseAudioContext, out: AudioNode, t: number, v: number): void {
  const n = env(0.001, 0.15, 0, 0, 0.02);
  noise(ctx, t, envLength(n) + 0.005, filter(ctx, 'bandpass', 1800, 0.8, amp(ctx, out, n, t, 0.55 * v)));
  const b = env(0.001, 0.07, 0, 0, 0.01);
  osc(ctx, 'triangle', 190, t, envLength(b) + 0.005, amp(ctx, out, b, t, 0.35 * v), 150, 0.06);
  const h = env(0.001, 0.09, 0, 0, 0.01);
  noise(ctx, t, envLength(h) + 0.005, filter(ctx, 'highpass', 5000, 0.7, amp(ctx, out, h, t, 0.22 * v)));
}

function hat(ctx: BaseAudioContext, out: AudioNode, t: number, v: number, open: boolean): void {
  const e = env(0.001, open ? 0.2 : 0.035, 0, 0, 0.01);
  noise(ctx, t, envLength(e) + 0.005, filter(ctx, 'highpass', 7500, 0.7, amp(ctx, out, e, t, 0.3 * v)));
}

/** Procedural music stems, keyed by layer id. Pitched stems take the biome root (MIDI). */
export const STEM_RECIPES: Readonly<Record<MusicLayerId, StemRecipe>> = Object.freeze({
  /** Warm detuned-saw chords, one per progression slot, with long overlapping releases. */
  pad: {
    pitched: true,
    tail: 1.3,
    build: (ctx, out, root) => {
      const total = loopSeconds() + 1.3;
      const lp = filter(ctx, 'lowpass', 1500, 0.6, out);
      // Whole cycles per loop so the filter motion wraps seamlessly.
      lfo(ctx, 2 / loopSeconds(), 350, lp.frequency, 0, total);
      const n = MUSIC.progression.length;
      const span = loopSeconds() / n;
      for (let c = 0; c < n; c++) {
        const t = c * span;
        const tones = MUSIC.progression[c]!;
        const e = env(0.6, 0.6, 0.75, Math.max(0, span - 1.2), 1.1);
        const d = envLength(e) + 0.01;
        for (let i = 0; i < tones.length; i++) {
          const f = midiToHz(root + 12 + tones[i]!);
          const g = amp(ctx, lp, e, t, 0.14);
          osc(ctx, 'sawtooth', f, t, d, g, f, 0, -8);
          osc(ctx, 'sawtooth', f, t, d, g, f, 0, 8);
        }
        osc(ctx, 'sine', midiToHz(root + tones[0]!), t, d, amp(ctx, lp, e, t, 0.12));
      }
    },
  },
  /** Plucky filtered-saw eighths on the chord root, with octave and fifth jumps. */
  bass: {
    pitched: true,
    tail: 0.3,
    build: (ctx, out, root) => {
      const step = stepSeconds();
      const spb = stepsPerBar();
      const grid = MUSIC.bass;
      for (let bar = 0; bar < MUSIC.bars; bar++) {
        const chord = chordForBar(bar);
        for (let s = 0; s < spb; s++) {
          const ch = gridAt(grid, bar, s);
          if (ch === '.') continue;
          const lower = ch.toLowerCase();
          const accent = ch !== lower;
          const semis = chord[0]! + (lower === 'o' ? 12 : lower === 'f' ? 7 : 0);
          let gap = 1;
          while (gap < 2 && s + gap < spb && gridAt(grid, bar, s + gap) === '.') gap++;
          const t = (bar * spb + s) * step;
          const f = midiToHz(root + semis);
          const e = env(0.004, 0.1, 0.6, Math.max(0, gap * step * 0.92 - 0.104), 0.05);
          const d = envLength(e) + 0.005;
          const lp = filter(ctx, 'lowpass', 280, 3.5, amp(ctx, out, e, t, accent ? 0.5 : 0.36));
          lp.frequency.setValueAtTime(280, t);
          lp.frequency.exponentialRampToValueAtTime(accent ? 2000 : 1300, t + 0.012);
          lp.frequency.exponentialRampToValueAtTime(300, t + 0.2);
          osc(ctx, 'sawtooth', f, t, d, lp);
          osc(ctx, 'sawtooth', f, t, d, lp, f, 0, 7);
          osc(ctx, 'square', f / 2, t, d, gain(ctx, lp, 0.5));
        }
      }
    },
  },
  /** Kick, snare, closed and open hats from step grids; unpitched, so shared by all biomes. */
  drums: {
    pitched: false,
    tail: 0.4,
    build: (ctx, out) => {
      const step = stepSeconds();
      const spb = stepsPerBar();
      const k = MUSIC.drums;
      for (let bar = 0; bar < MUSIC.bars; bar++) {
        const last = bar === MUSIC.bars - 1;
        for (let s = 0; s < spb; s++) {
          const t = (bar * spb + s) * step;
          const vk = laneVelocity(k.kick, last, s);
          if (vk > 0) kick(ctx, out, t, vk);
          const vs = laneVelocity(k.snare, last, s);
          if (vs > 0) snare(ctx, out, t, vs);
          const vh = laneVelocity(k.hat, last, s);
          if (vh > 0) hat(ctx, out, t, vh, false);
          const vo = laneVelocity(k.open, last, s);
          if (vo > 0) hat(ctx, out, t, vo, true);
        }
      }
    },
  },
  /** Sixteenth-note square arpeggio over the chord, with a dotted-eighth echo. */
  lead: {
    pitched: true,
    tail: 2.4,
    build: (ctx, out, root) => {
      const step = stepSeconds();
      const spb = stepsPerBar();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = step * 3;
      delay.connect(gain(ctx, delay, 0.35));
      delay.connect(gain(ctx, out, 0.3));
      const tone = filter(ctx, 'lowpass', 2600, 1.2, gain(ctx, out, 1));
      tone.connect(delay);
      for (let bar = 0; bar < MUSIC.bars; bar++) {
        const chord = chordForBar(bar);
        for (let s = 0; s < spb; s++) {
          const ch = gridAt(MUSIC.arp, bar, s);
          if (ch === '.') continue;
          const idx = ch.charCodeAt(0) - 48;
          const semis = idx < chord.length ? chord[idx]! : chord[0]! + 12;
          const t = (bar * spb + s) * step;
          const f = midiToHz(root + 24 + semis);
          const e = env(0.003, 0.09, 0.3, 0.02, 0.06);
          const d = envLength(e) + 0.005;
          const g = amp(ctx, tone, e, t, s % 4 === 0 ? 0.3 : 0.22);
          osc(ctx, 'square', f, t, d, g);
          osc(ctx, 'triangle', f * 2, t, d, gain(ctx, g, 0.3));
        }
      }
    },
  },
});

/** Bytes of rendered buffers held at once: every SFX, shared stems, and `cacheBiomes` sets of pitched stems. */
export function estimateBufferBytes(): number {
  let frames = 0;
  for (let i = 0; i < AUDIO_CUES.length; i++) {
    frames += Math.ceil(SFX_RECIPES[AUDIO_CUES[i]!.recipe]!.duration * AUDIO_RENDER_RATE);
  }
  for (let i = 0; i < MUSIC.layers.length; i++) {
    frames += loopFrames() * (STEM_RECIPES[MUSIC.layers[i]!.id].pitched ? MUSIC.cacheBiomes : 1);
  }
  return frames * 4;
}

// ---- Rendering (browser only) ----

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offline(frames: (rate: number) => number): OfflineAudioContext {
  const g = globalThis as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext is unavailable');
  let err: unknown;
  for (let i = 0; i < RATES.length; i++) {
    try {
      return new Ctor(1, frames(RATES[i]!), RATES[i]!);
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

const NODE_FACTORIES = [
  'createOscillator',
  'createGain',
  'createBiquadFilter',
  'createBufferSource',
  'createWaveShaper',
  'createStereoPanner',
  'createDelay',
  'createConvolver',
  'createDynamicsCompressor',
  'createConstantSource',
  'createChannelMerger',
  'createChannelSplitter',
] as const;

/**
 * Keeps a JS reference to every node created on `ctx` until rendering finishes. WebKit can crash on its offline
 * audio thread (AudioSummingJunction::updateRenderingState, pure virtual call) when the JS wrappers of nodes
 * in a rendering graph are garbage-collected mid-render; holding them avoids that.
 */
function retainNodes(ctx: OfflineAudioContext): AudioNode[] {
  const keep: AudioNode[] = [];
  const c = ctx as unknown as Record<string, (...a: unknown[]) => AudioNode>;
  for (const name of NODE_FACTORIES) {
    const fn = c[name];
    if (typeof fn !== 'function') continue;
    c[name] = (...args: unknown[]) => {
      const n = fn.apply(ctx, args);
      keep.push(n);
      return n;
    };
  }
  return keep;
}

/** Renders an SFX recipe to a peak-normalised mono buffer. */
export async function renderSfx(name: string): Promise<AudioBuffer> {
  const r = SFX_RECIPES[name];
  if (!r) throw new Error(`Unknown SFX recipe: ${name}`);
  const ctx = offline((rate) => Math.ceil(r.duration * rate));
  const keep = retainNodes(ctx);
  r.build(ctx, ctx.destination);
  const buf = await ctx.startRendering();
  keep.length = 0;
  const data = buf.getChannelData(0);
  normalizePeak(data, PEAK);
  fadeTail(data, Math.round(0.003 * buf.sampleRate));
  return buf;
}

/** Renders one seamless, peak-normalised music stem at `root` (MIDI; ignored by unpitched stems). */
export async function renderStem(id: MusicLayerId, root: number): Promise<AudioBuffer> {
  const r = STEM_RECIPES[id];
  const ctx = offline((rate) => loopFrames(rate) + Math.ceil(r.tail * rate));
  const loop = loopFrames(ctx.sampleRate);
  const keep = retainNodes(ctx);
  r.build(ctx, ctx.destination, root);
  const full = await ctx.startRendering();
  keep.length = 0;
  const data = foldLoopTail(full.getChannelData(0), loop);
  normalizePeak(data, PEAK);
  const out = ctx.createBuffer(1, loop, ctx.sampleRate);
  out.getChannelData(0).set(data);
  return out;
}
