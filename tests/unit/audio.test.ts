import { describe, expect, it } from 'vitest';
import { AUDIO_CUES, AUDIO_RENDER_RATE, type CueId, MUSIC, type MusicLayerId } from '../../src/data/audio.ts';
import { BIOMES } from '../../src/data/biomes.ts';
import {
  AudioEngine,
  CUE_INDEX,
  clamp01,
  pentatonicSemitones,
  pickVoice,
  rateAt,
  rateIntegral,
  targetLayerGains,
  volumeCurve,
} from '../../src/game/audio/audio-engine.ts';
import {
  chordForBar,
  env,
  envelopeBreakpoints,
  estimateBufferBytes,
  foldLoopTail,
  gridAt,
  loopFrames,
  loopSeconds,
  midiToHz,
  normalizePeak,
  SFX_RECIPES,
  STEM_RECIPES,
  semitonesToRate,
  stepsPerBar,
  stepVelocity,
} from '../../src/game/audio/synth.ts';

// Compile-time exhaustive list: adding a CueId without listing it here fails `tsc`.
const ALL_CUES: Record<CueId, true> = {
  boost: true,
  nearMiss: true,
  perfect: true,
  shard: true,
  death: true,
  abilityPhase: true,
  abilityOverdrive: true,
  abilityPulse: true,
  abilityMagnet: true,
  abilityReady: true,
  revive: true,
  uiClick: true,
  uiBack: true,
  milestone: true,
  combo: true,
  biome: true,
};
const ALL_LAYERS: Record<MusicLayerId, true> = { pad: true, bass: true, drums: true, lead: true };

// ---- A minimal recording BaseAudioContext, enough to run recipe builders in Node ----

interface Log {
  times: number[];
  sources: MockSource[];
}

class MockParam {
  value: number;
  private readonly log: Log;
  constructor(log: Log, v = 0) {
    this.log = log;
    this.value = v;
  }
  private at(v: number, t: number): this {
    if (!Number.isFinite(v) || !Number.isFinite(t) || t < 0)
      throw new RangeError(`bad automation ${v} @ ${t}`);
    this.log.times.push(t);
    return this;
  }
  setValueAtTime(v: number, t: number): this {
    return this.at(v, t);
  }
  linearRampToValueAtTime(v: number, t: number): this {
    return this.at(v, t);
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    if (v === 0) throw new RangeError('exponential ramp to 0');
    return this.at(v, t);
  }
  setTargetAtTime(v: number, t: number, tau: number): this {
    if (!(tau > 0)) throw new RangeError('timeConstant must be > 0');
    return this.at(v, t);
  }
}

class MockNode {
  connect<T>(dest: T): T {
    return dest;
  }
  disconnect(): void {
    return;
  }
}

class MockSource extends MockNode {
  readonly frequency: MockParam;
  readonly detune: MockParam;
  readonly playbackRate: MockParam;
  type = 'sine';
  buffer: unknown = null;
  loop = false;
  started = -1;
  stopped = -1;
  private readonly log: Log;
  constructor(log: Log) {
    super();
    this.log = log;
    this.frequency = new MockParam(log, 440);
    this.detune = new MockParam(log);
    this.playbackRate = new MockParam(log, 1);
    log.sources.push(this);
  }
  start(t = 0): void {
    this.started = t;
    this.log.times.push(t);
  }
  stop(t = 0): void {
    this.stopped = t;
    this.log.times.push(t);
  }
}

class MockContext {
  readonly sampleRate = AUDIO_RENDER_RATE;
  readonly currentTime = 0;
  readonly destination = new MockNode();
  readonly log: Log = { times: [], sources: [] };
  createOscillator() {
    return new MockSource(this.log);
  }
  createBufferSource() {
    return new MockSource(this.log);
  }
  createGain() {
    return Object.assign(new MockNode(), { gain: new MockParam(this.log, 1) });
  }
  createBiquadFilter() {
    const l = this.log;
    return Object.assign(new MockNode(), {
      type: 'lowpass',
      frequency: new MockParam(l, 350),
      Q: new MockParam(l, 1),
      gain: new MockParam(l),
    });
  }
  createDelay() {
    return Object.assign(new MockNode(), { delayTime: new MockParam(this.log) });
  }
  createWaveShaper() {
    return Object.assign(new MockNode(), { curve: null as Float32Array | null, oversample: 'none' });
  }
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { length, sampleRate: rate, duration: length / rate, getChannelData: () => data };
  }
}

function runBuild(build: (ctx: BaseAudioContext, out: AudioNode) => void): Log {
  const ctx = new MockContext();
  build(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode);
  return ctx.log;
}

// ---- Data ----

describe('audio data', () => {
  it('every CueId has exactly one CueDef', () => {
    const ids = Object.keys(ALL_CUES).sort();
    expect(AUDIO_CUES.map((c) => c.id).sort()).toEqual(ids);
    for (const id of ids) expect(CUE_INDEX[id as CueId], id).toBe(AUDIO_CUES.findIndex((c) => c.id === id));
  });

  it('cue gains, voices, variance, cooldowns and urls are sane', () => {
    for (const c of AUDIO_CUES) {
      expect(c.gain, c.id).toBeGreaterThan(0);
      expect(c.gain, c.id).toBeLessThanOrEqual(1);
      expect(Number.isInteger(c.voices) && c.voices >= 1, c.id).toBe(true);
      expect(c.pitchVariance, c.id).toBeGreaterThanOrEqual(0);
      expect(c.pitchVariance, c.id).toBeLessThanOrEqual(3);
      expect(c.cooldownMs, c.id).toBeGreaterThanOrEqual(0);
      if (c.url !== undefined)
        expect(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(c.url), `${c.id} url must be same-origin`).toBe(false);
    }
  });

  it('every cue recipe resolves in SFX_RECIPES', () => {
    for (const c of AUDIO_CUES) expect(SFX_RECIPES[c.recipe], `${c.id} → ${c.recipe}`).toBeDefined();
  });

  it('music layers are unique, complete, have stem recipes and sane gains', () => {
    const ids = MUSIC.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(ALL_LAYERS).sort());
    for (const l of MUSIC.layers) {
      expect(STEM_RECIPES[l.id], l.id).toBeDefined();
      expect(l.gain).toBeGreaterThan(0);
      expect(l.gain).toBeLessThanOrEqual(1);
    }
  });

  it('music tempo, grids and progression are well formed', () => {
    expect(MUSIC.bpm).toBeGreaterThanOrEqual(100);
    expect(MUSIC.bpm).toBeLessThanOrEqual(140);
    expect(MUSIC.bars % MUSIC.progression.length).toBe(0);
    const spb = stepsPerBar();
    expect(MUSIC.bass.length % spb).toBe(0);
    expect(MUSIC.arp.length % spb).toBe(0);
    expect(/^[rofROF.]+$/.test(MUSIC.bass)).toBe(true);
    expect(/^[0-3.]+$/.test(MUSIC.arp)).toBe(true);
    for (const lane of Object.values(MUSIC.drums)) {
      for (const g of [lane.grid, lane.fill]) {
        expect(g.length).toBe(spb);
        expect(/^[1-9.]+$/.test(g)).toBe(true);
      }
    }
    for (const chord of MUSIC.progression) expect(chord.length).toBe(3);
    expect(MUSIC.bassSpeed).toBeLessThan(MUSIC.drumsSpeed);
    expect(MUSIC.cacheBiomes).toBeGreaterThanOrEqual(1);
    expect(MUSIC.cacheBiomes).toBeLessThanOrEqual(BIOMES.length);
  });

  it('rendered buffers stay under ~20 MB', () => {
    expect(estimateBufferBytes()).toBeLessThan(20 * 1024 * 1024);
  });
});

// ---- Pure helpers ----

describe('synth helpers', () => {
  it('midiToHz and semitonesToRate', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 9);
    expect(midiToHz(57)).toBeCloseTo(220, 9);
    expect(midiToHz(45)).toBeCloseTo(110, 9);
    expect(semitonesToRate(12)).toBeCloseTo(2, 12);
    expect(semitonesToRate(-12)).toBeCloseTo(0.5, 12);
    expect(semitonesToRate(0)).toBe(1);
  });

  it('ADSR breakpoints rise to the peak, hold the sustain and end at 0', () => {
    const e = env(0.01, 0.1, 0.5, 0.2, 0.3);
    const p = envelopeBreakpoints(e, 1, 0.8);
    expect(p.length).toBe(10);
    for (let i = 2; i < p.length; i += 2) expect(p[i]!).toBeGreaterThanOrEqual(p[i - 2]!);
    expect([p[0], p[1]]).toEqual([1, 0]);
    expect(p[2]).toBeCloseTo(1.01, 12);
    expect(p[3]).toBe(0.8);
    expect(p[5]).toBeCloseTo(0.4, 12);
    expect(p[7]).toBeCloseTo(0.4, 12);
    expect(p[8]).toBeCloseTo(1.61, 12);
    expect(p[9]).toBe(0);
    expect(Math.max(...p.filter((_, i) => i % 2 === 1))).toBe(0.8);
  });

  it('loop length is musical and identical for every stem', () => {
    expect(loopSeconds()).toBeCloseTo((MUSIC.bars * MUSIC.beatsPerBar * 60) / MUSIC.bpm, 9);
    expect(Number.isInteger(loopFrames())).toBe(true);
    expect(Math.abs(loopFrames() / AUDIO_RENDER_RATE - loopSeconds())).toBeLessThan(1 / AUDIO_RENDER_RATE);
  });

  it('chords, grids and velocities', () => {
    expect(chordForBar(0)).toEqual(MUSIC.progression[0]);
    expect(chordForBar(MUSIC.bars - 1)).toEqual(MUSIC.progression[MUSIC.progression.length - 1]);
    expect(gridAt('ab', 0, 0)).toBe('a');
    expect(gridAt('0123456789abcdefABCDEFGHIJKLMNOP', 1, 0)).toBe('A');
    expect(gridAt('0123456789abcdef', 3, 5)).toBe('5');
    expect(stepVelocity('9')).toBe(1);
    expect(stepVelocity('.')).toBe(0);
    expect(stepVelocity('0')).toBe(0);
    expect(stepVelocity('3')).toBeCloseTo(1 / 3, 12);
  });

  it('foldLoopTail wraps the tail onto the loop start', () => {
    const d = new Float32Array([1, 2, 3, 4, 5, 6]);
    expect([...foldLoopTail(d, 4)]).toEqual([6, 8, 3, 4]);
    const long = new Float32Array([1, 1, 1, 1, 1]);
    expect([...foldLoopTail(long, 2)]).toEqual([3, 2]);
  });

  it('normalizePeak scales to the target peak and ignores silence', () => {
    const d = new Float32Array([0.1, -0.5, 0.25]);
    expect(normalizePeak(d, 1)).toBeCloseTo(2, 6);
    expect(d[1]).toBeCloseTo(-1, 6);
    const z = new Float32Array(4);
    expect(normalizePeak(z, 1)).toBe(1);
    expect([...z]).toEqual([0, 0, 0, 0]);
  });
});

describe('recipes build without errors and fit their duration', () => {
  for (const [name, r] of Object.entries(SFX_RECIPES)) {
    it(`sfx ${name}`, () => {
      expect(r.duration).toBeGreaterThan(0);
      expect(r.duration).toBeLessThanOrEqual(2.5);
      const log = runBuild(r.build);
      expect(log.sources.length).toBeGreaterThan(0);
      for (const t of log.times) expect(t).toBeLessThanOrEqual(r.duration + 1e-9);
      for (const s of log.sources) {
        expect(s.started).toBeGreaterThanOrEqual(0);
        expect(s.stopped).toBeGreaterThan(s.started);
      }
    });
  }

  for (const [id, r] of Object.entries(STEM_RECIPES)) {
    for (const b of BIOMES) {
      it(`stem ${id} @ ${b.id}`, () => {
        const end = loopSeconds() + r.tail;
        const log = runBuild((ctx, out) => r.build(ctx, out, b.music.root));
        expect(log.sources.length).toBeGreaterThan(0);
        for (const t of log.times) expect(t).toBeLessThanOrEqual(end + 1e-9);
        for (const s of log.sources) {
          expect(s.started).toBeLessThan(loopSeconds());
          expect(s.stopped).toBeGreaterThan(s.started);
        }
      });
    }
  }
});

describe('adaptive mix', () => {
  const layerIndex = (id: MusicLayerId) => MUSIC.layers.findIndex((l) => l.id === id);
  const grid = Array.from({ length: 101 }, (_, i) => i / 100);

  it('is bounded by each layer gain', () => {
    const out = new Float32Array(MUSIC.layers.length);
    for (const s of [-1, 0, 0.3, 0.6, 1, 2, Number.NaN]) {
      for (const d of [-1, 0, 0.6, 1, 2, Number.NaN]) {
        for (const boosting of [false, true]) {
          for (const focus of [false, true]) {
            for (const running of [false, true]) {
              for (const bias of [0, 0.25]) {
                targetLayerGains(s, d, boosting, focus, running, bias, out);
                MUSIC.layers.forEach((l, i) => {
                  expect(out[i]).toBeGreaterThanOrEqual(0);
                  expect(out[i]).toBeLessThanOrEqual(l.gain + 1e-6);
                });
              }
            }
          }
        }
      }
    }
  });

  it('is monotonic in speed and danger', () => {
    for (const boosting of [false, true]) {
      for (const focus of [false, true]) {
        let prevS = targetLayerGains(0, 0.3, boosting, focus, true);
        let prevD = targetLayerGains(0.3, 0, boosting, focus, true);
        for (const x of grid) {
          const s = targetLayerGains(x, 0.3, boosting, focus, true);
          const d = targetLayerGains(0.3, x, boosting, focus, true);
          for (let i = 0; i < s.length; i++) {
            expect(s[i]!).toBeGreaterThanOrEqual(prevS[i]! - 1e-7);
            expect(d[i]!).toBeGreaterThanOrEqual(prevD[i]! - 1e-7);
          }
          prevS = s;
          prevD = d;
        }
      }
    }
  });

  it('brings layers in at their thresholds', () => {
    const pad = layerIndex('pad');
    const bass = layerIndex('bass');
    const drums = layerIndex('drums');
    const lead = layerIndex('lead');
    const calm = targetLayerGains(0, 0, false, false, true);
    expect(calm[pad]).toBeCloseTo(MUSIC.layers[pad]!.gain, 6);
    expect(calm[bass]).toBe(0);
    expect(calm[drums]).toBe(0);
    expect(calm[lead]).toBe(0);
    const mid = targetLayerGains(MUSIC.bassSpeed + MUSIC.ramp, 0, false, false, true);
    expect(mid[bass]).toBeCloseTo(MUSIC.layers[bass]!.gain, 6);
    expect(mid[drums]).toBe(0);
    expect(targetLayerGains(0, 0, true, false, true)[drums]).toBeCloseTo(MUSIC.layers[drums]!.gain, 6);
    expect(targetLayerGains(1, 1, false, false, true)[lead]).toBeCloseTo(MUSIC.layers[lead]!.gain, 6);
    expect(targetLayerGains(1, 0, false, true, true)[drums]!).toBeLessThan(MUSIC.layers[drums]!.gain);
    // Biome bias brings layers in earlier.
    expect(targetLayerGains(0.3, 0, false, false, true, 0.25)[drums]!).toBeGreaterThan(
      targetLayerGains(0.3, 0, false, false, true, 0)[drums]!,
    );
  });

  it('menu mix is pad only', () => {
    const menu = targetLayerGains(1, 1, true, true, false);
    MUSIC.layers.forEach((l, i) => {
      if (l.id === 'pad') expect(menu[i]).toBeCloseTo(l.gain * MUSIC.menuPad, 6);
      else expect(menu[i]).toBe(0);
    });
  });
});

describe('engine helpers', () => {
  it('clamp01 and volumeCurve', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(volumeCurve(0.5)).toBe(0.25);
    expect(volumeCurve(1)).toBe(1);
  });

  it('combo pitch climbs the minor pentatonic monotonically', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const s = pentatonicSemitones(i / 20, 12);
      expect([0, 3, 5, 7, 10, 12]).toContain(s);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(pentatonicSemitones(0, 12)).toBe(0);
    expect(pentatonicSemitones(1, 12)).toBe(12);
  });

  it('rate curve and its integral (music clock) match a numeric integration', () => {
    expect(rateAt(1, 0.9, 0.12, 0)).toBe(1);
    expect(rateAt(1, 0.9, 0.12, 10)).toBeCloseTo(0.9, 9);
    expect(rateIntegral(1, 1, 0.12, 2.5)).toBeCloseTo(2.5, 12);
    expect(rateIntegral(1, 0.9, 0.12, 0)).toBe(0);
    const dt = 0.7;
    const n = 20000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rateAt(1, 0.89, 0.12, ((i + 0.5) / n) * dt) * (dt / n);
    expect(rateIntegral(1, 0.89, 0.12, dt)).toBeCloseTo(sum, 7);
  });

  it('pickVoice prefers a free voice, else steals the one ending soonest', () => {
    const ends = new Float64Array([9, 5, 7, 3, 8]);
    expect(pickVoice(ends, 1, 3, 6)).toBe(1);
    expect(pickVoice(ends, 0, 3, 4)).toBe(1);
    expect(pickVoice(ends, 2, 3, 2)).toBe(3);
    expect(pickVoice(ends, 4, 1, 1)).toBe(4);
  });

  it('the engine is a safe no-op without Web Audio (before unlock, or in Node)', () => {
    const a = new AudioEngine();
    expect(a.ready).toBe(false);
    expect(() => {
      a.setVolumes(1, 0.5, 0.5);
      a.setMusicState(0.5, 0.5, true, false, true);
      a.setTimeWarp(0.5);
      a.setBiome(2);
      a.play('nearMiss', 1, 0, -1, 0.5);
      a.play('combo');
      a.suspend();
      a.resume();
      a.unlock();
    }).not.toThrow();
    expect(a.ready).toBe(false);
  });
});
