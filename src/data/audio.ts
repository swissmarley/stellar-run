/**
 * Sound cues and the adaptive music. Everything is synthesised at boot from the procedural recipes in
 * src/game/audio/synth.ts (CC0 placeholder audio). Setting a cue's or layer's `url` to a same-origin file
 * replaces the recipe with that file; the recipe stays as the fallback if the file fails to load.
 */

export type CueId =
  | 'boost'
  | 'nearMiss'
  | 'perfect'
  | 'shard'
  | 'death'
  | 'abilityPhase'
  | 'abilityOverdrive'
  | 'abilityPulse'
  | 'abilityMagnet'
  | 'abilityReady'
  | 'revive'
  | 'uiClick'
  | 'uiBack'
  | 'milestone'
  | 'combo'
  | 'biome';

export interface CueDef {
  readonly id: CueId;
  /** Key in SFX_RECIPES (src/game/audio/synth.ts). */
  readonly recipe: string;
  /** Optional same-origin audio file (relative to the page) that replaces the recipe. */
  readonly url?: string;
  /** Linear gain at intensity 1, in (0, 1]. Rendered recipes are peak-normalised, so this is the mix level. */
  readonly gain: number;
  /** Random pitch spread per play, ± semitones. */
  readonly pitchVariance: number;
  /** Positioned with an equal-power PannerNode when the caller passes x/y/z. */
  readonly spatial: boolean;
  /** Pooled voices; when all are busy the one closest to ending is stolen. */
  readonly voices: number;
  /** Minimum time between two plays of this cue; extra plays are dropped. */
  readonly cooldownMs: number;
  /** Semitones added at intensity 1, snapped to the minor pentatonic (e.g. rising combo blips). */
  readonly intensityPitch?: number;
}

/** Sample rate of every rendered buffer (Hz). Mono at 32 kHz keeps all buffers under ~20 MB. */
export const AUDIO_RENDER_RATE = 32000;

/** All cues. Order is the boot render order: the cues needed first (menu taps, core feedback) come first. */
export const AUDIO_CUES: readonly CueDef[] = Object.freeze([
  {
    id: 'uiClick',
    recipe: 'tick',
    gain: 0.45,
    pitchVariance: 0.4,
    spatial: false,
    voices: 2,
    cooldownMs: 30,
  },
  {
    id: 'uiBack',
    recipe: 'tickDown',
    gain: 0.45,
    pitchVariance: 0.3,
    spatial: false,
    voices: 2,
    cooldownMs: 30,
  },
  {
    id: 'nearMiss',
    recipe: 'passBy',
    gain: 0.9,
    pitchVariance: 1.2,
    spatial: true,
    voices: 4,
    cooldownMs: 40,
  },
  {
    id: 'shard',
    recipe: 'glassChime',
    gain: 0.5,
    pitchVariance: 0.6,
    spatial: false,
    voices: 4,
    cooldownMs: 25,
  },
  {
    id: 'boost',
    recipe: 'boostWhoosh',
    gain: 0.8,
    pitchVariance: 0.5,
    spatial: false,
    voices: 2,
    cooldownMs: 150,
  },
  {
    id: 'perfect',
    recipe: 'passByShimmer',
    gain: 1,
    pitchVariance: 0.8,
    spatial: true,
    voices: 2,
    cooldownMs: 60,
  },
  {
    id: 'combo',
    recipe: 'blip',
    gain: 0.42,
    pitchVariance: 0,
    spatial: false,
    voices: 3,
    cooldownMs: 40,
    intensityPitch: 12,
  },
  {
    id: 'death',
    recipe: 'explosion',
    gain: 1,
    pitchVariance: 0.3,
    spatial: false,
    voices: 1,
    cooldownMs: 500,
  },
  {
    id: 'abilityReady',
    recipe: 'ping',
    gain: 0.5,
    pitchVariance: 0,
    spatial: false,
    voices: 1,
    cooldownMs: 300,
  },
  {
    id: 'abilityPhase',
    recipe: 'phaseSweep',
    gain: 0.5,
    pitchVariance: 0,
    spatial: false,
    voices: 1,
    cooldownMs: 200,
  },
  {
    id: 'abilityOverdrive',
    recipe: 'sawRise',
    gain: 0.45,
    pitchVariance: 0,
    spatial: false,
    voices: 1,
    cooldownMs: 200,
  },
  {
    id: 'abilityPulse',
    recipe: 'boomRing',
    gain: 0.9,
    pitchVariance: 0,
    spatial: false,
    voices: 1,
    cooldownMs: 200,
  },
  {
    id: 'abilityMagnet',
    recipe: 'warble',
    gain: 0.38,
    pitchVariance: 0,
    spatial: false,
    voices: 1,
    cooldownMs: 200,
  },
  {
    id: 'revive',
    recipe: 'majorArp',
    gain: 0.8,
    pitchVariance: 0,
    spatial: false,
    voices: 1,
    cooldownMs: 500,
  },
  {
    id: 'milestone',
    recipe: 'fanfare',
    gain: 0.5,
    pitchVariance: 0,
    spatial: false,
    voices: 1,
    cooldownMs: 500,
  },
  {
    id: 'biome',
    recipe: 'airSwell',
    gain: 0.6,
    pitchVariance: 0,
    spatial: false,
    voices: 1,
    cooldownMs: 1000,
  },
]);

export type MusicLayerId = 'pad' | 'bass' | 'drums' | 'lead';

export interface MusicLayerDef {
  readonly id: MusicLayerId;
  /** Linear gain when the layer is fully in, in (0, 1]. Rendered stems are peak-normalised. */
  readonly gain: number;
  /** Optional same-origin seamless loop replacing the recipe stem. Same length as the other stems; not transposed per biome. */
  readonly url?: string;
}

/** One drum lane: 16 steps per bar, digits 1-9 = velocity, '.' = rest. `fill` replaces `grid` on the last bar. */
export interface DrumLaneDef {
  readonly grid: string;
  readonly fill: string;
}

export interface MusicDef {
  /** Tempo of the rendered loop. */
  readonly bpm: number;
  /** Loop length in bars. Every stem is exactly this long, so all layers stay sample-aligned. */
  readonly bars: number;
  /** Beats per bar; step grids have 4 steps per beat. */
  readonly beatsPerBar: number;
  /** Stems, all started at the same time and mixed by gain. */
  readonly layers: readonly MusicLayerDef[];
  /** Chords in semitones from the biome root (first tone = chord root), spread evenly over `bars`. */
  readonly progression: readonly (readonly number[])[];
  /** Bass steps (cycled per bar): r = root, o = octave, f = fifth, '.' = rest; upper case = accent. */
  readonly bass: string;
  /** Arpeggio steps (cycled over bars): 0-2 = chord tone, 3 = chord root an octave up, '.' = rest. */
  readonly arp: string;
  readonly drums: {
    readonly kick: DrumLaneDef;
    readonly snare: DrumLaneDef;
    readonly hat: DrumLaneDef;
    readonly open: DrumLaneDef;
  };
  /** speed01 (+ biome bias) at which the bass starts to fade in. */
  readonly bassSpeed: number;
  /** speed01 (+ biome bias) at which the drums start to fade in (boosting forces them in). */
  readonly drumsSpeed: number;
  /** danger01 (+ biome bias) at which the lead arpeggio starts to fade in. */
  readonly leadDanger: number;
  /** Width of each fade-in ramp past its threshold (smoothstep), in speed01/danger01 units. */
  readonly ramp: number;
  /** Drum attenuation while focus is held (0 = none, 1 = silent). */
  readonly focusDrumDuck: number;
  /** Pad level in the menu mix (running = false), relative to its layer gain. */
  readonly menuPad: number;
  /** Time constant (s) of layer fade-ins. */
  readonly fadeIn: number;
  /** Time constant (s) of layer fade-outs. */
  readonly fadeOut: number;
  /** Time constant (s) of the crossfade when the music changes key (biome change). */
  readonly crossfade: number;
  /** Low-pass closes by this fraction of the biome cutoff at speed01 = 0 (opens fully at speed01 = 1). */
  readonly speedOpen: number;
  /** Low-pass cutoff in the menu mix, as a fraction of the biome cutoff. */
  readonly menuCutoff: number;
  /** Music low-pass cutoff (Hz) at full time warp (focus slow-mo). */
  readonly focusCutoff: number;
  /** Music low-pass resonance at full time warp. */
  readonly focusQ: number;
  /** Music pitch shift at full time warp, in semitones. */
  readonly focusPitch: number;
  /** SFX bus low-pass cutoff (Hz) at full time warp. */
  readonly sfxFocusCutoff: number;
  /** Pitch shift of SFX started during full time warp, in semitones. */
  readonly sfxFocusPitch: number;
  /** Biomes whose pitched stems stay in memory (current + prefetched next). */
  readonly cacheBiomes: number;
}

/** Adaptive music: an 8-bar natural-minor loop (i-VI-III-VII) rendered per biome root. */
export const MUSIC: MusicDef = Object.freeze({
  bpm: 116,
  bars: 8,
  beatsPerBar: 4,
  layers: Object.freeze([
    { id: 'pad', gain: 0.35 },
    { id: 'bass', gain: 0.5 },
    { id: 'drums', gain: 0.8 },
    { id: 'lead', gain: 0.3 },
  ] as const),
  progression: Object.freeze([
    [0, 3, 7],
    [-4, 0, 3],
    [3, 7, 10],
    [-2, 2, 5],
  ]),
  bass: 'R.r.O.r.R.r.O.rF',
  arp: '01201201201201323210321032103213',
  drums: Object.freeze({
    kick: { grid: '9...9...9...9...', fill: '9...9...9.6.9.6.' },
    snare: { grid: '....9.......9...', fill: '....9...4...9579' },
    hat: { grid: '3.6.3.6.3.6.3..3', fill: '3.6.3.6.3.6.....' },
    open: { grid: '..............5.', fill: '................' },
  }),
  bassSpeed: 0.25,
  drumsSpeed: 0.5,
  leadDanger: 0.55,
  ramp: 0.12,
  focusDrumDuck: 0.45,
  menuPad: 0.8,
  fadeIn: 0.3,
  fadeOut: 0.8,
  crossfade: 0.25,
  speedOpen: 0.35,
  menuCutoff: 0.5,
  focusCutoff: 650,
  focusQ: 2.5,
  focusPitch: -2,
  sfxFocusCutoff: 2200,
  sfxFocusPitch: -3,
  cacheBiomes: 2,
});
