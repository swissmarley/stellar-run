/**
 * Definition types: the data-driven equivalent of Unity ScriptableObjects. Definitions are plain, frozen
 * objects; runtime code refers to them by their index in the ordered registry (src/data/registry.ts).
 */

/** A value given at difficulty 0 and difficulty 1; interpolated linearly in between. */
export type DRange = readonly [atEasy: number, atHard: number];
/** A uniform random range [min, max]. */
export type Range = readonly [min: number, max: number];

export type AbilityId = 'phase' | 'overdrive' | 'pulse' | 'magnet';

export interface ShipDef {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  /** Max lateral speed (m/s, circular cap). The slowest ship bounds the passability proof. */
  readonly lateralSpeed: number;
  /** Multiplier on the chunk's cruise speed. The fastest ship bounds the certified speed. */
  readonly speedFactor: number;
  /** Hitbox capsule radius (metres). The largest ship bounds the passability proof. */
  readonly hitRadius: number;
  /** Hitbox capsule half-length along the track (metres). */
  readonly hitHalfLength: number;
  readonly ability: AbilityId;
  readonly abilityName: string;
  readonly abilityDesc: string;
  /** Price in shards (0 = owned from the start). */
  readonly price: number;
  /** Visual model parameters for the procedural mesh. */
  readonly model: {
    readonly length: number;
    readonly width: number;
    readonly wingSweep: number;
    readonly fins: number;
    readonly hull: number;
    readonly trim: number;
    readonly engine: number;
  };
}

export type ObstacleShape = 'sphere' | 'box';
export type ObstacleKind = 'static' | 'drone' | 'well';
/** Visual archetype keys implemented by src/game/render/geometry.ts. */
export type Archetype =
  | 'rock'
  | 'rockLarge'
  | 'pylon'
  | 'beam'
  | 'girder'
  | 'plate'
  | 'crate'
  | 'mine'
  | 'drone'
  | 'singularity';

export interface ObstacleDef {
  readonly id: string;
  readonly name: string;
  readonly shape: ObstacleShape;
  /** Sphere collision radius at scale 1. */
  readonly radius: number;
  /** Box half extents (x, y, along-track) at scale 1. */
  readonly half: readonly [number, number, number];
  readonly kind: ObstacleKind;
  readonly archetype: Archetype;
  /** Whether the repair step may delete it to make a chunk passable. */
  readonly removable: boolean;
  /** Pulse cannot destroy it. */
  readonly pulseImmune: boolean;
  /** Gravity well parameters (kind === 'well'). Drift per metre of travel = strength·d/(d²+softening²). */
  readonly well?: { readonly strength: number; readonly softening: number; readonly range: number };
}

/** Procedural layout elements a pattern is built from. Positions are relative to the pattern start (s) / corridor centre. */
export type ElementDef =
  | {
      readonly type: 'scatter';
      readonly obstacle: string;
      readonly count: DRange;
      readonly s: Range;
      readonly x?: Range;
      readonly y?: Range;
      readonly scale: Range;
    }
  | {
      readonly type: 'wall';
      readonly obstacle: string;
      readonly s: number;
      readonly spacing: number;
      readonly holes: DRange;
      readonly holeRadius: DRange;
      readonly scale: Range;
      readonly jitter: number;
    }
  | {
      readonly type: 'beam';
      readonly obstacle: string;
      readonly s: Range;
      readonly axis: 'x' | 'y';
      readonly offset: Range;
      readonly count: DRange;
      readonly spacing: Range;
    }
  | {
      readonly type: 'gate';
      /** Horizontal bars (top/bottom of the window). */
      readonly obstacle: string;
      /** Vertical bars (left/right of the window). */
      readonly obstacleV: string;
      readonly s: number;
      readonly opening: DRange;
    }
  | {
      readonly type: 'slalom';
      readonly obstacle: string;
      readonly s: Range;
      readonly count: DRange;
      readonly amplitude: Range;
      readonly scale: Range;
      readonly axis: 'x' | 'y';
    }
  | {
      readonly type: 'ring';
      readonly obstacle: string;
      readonly s: number;
      readonly radius: Range;
      readonly count: DRange;
      readonly scale: Range;
      readonly gap: DRange;
    }
  | {
      readonly type: 'drone';
      readonly obstacle: string;
      readonly s: Range;
      readonly count: DRange;
      readonly amplitude: Range;
      readonly period: Range;
      readonly mode: 'x' | 'y' | 'orbit';
    }
  | {
      readonly type: 'well';
      readonly obstacle: string;
      readonly s: number;
      readonly x: Range;
      readonly y: Range;
    };

export interface PatternDef {
  readonly id: string;
  readonly biomes: readonly string[];
  /** Difficulty window in which the pattern may be chosen. */
  readonly minD: number;
  readonly maxD: number;
  readonly weight: number;
  /** Length along the track in metres. */
  readonly length: number;
  readonly elements: readonly ElementDef[];
}

export interface BiomeDef {
  readonly id: string;
  readonly name: string;
  /** Colours are 0xRRGGBB. */
  readonly palette: {
    readonly fog: number;
    readonly nebulaA: number;
    readonly nebulaB: number;
    readonly nebulaC: number;
    readonly stars: number;
    readonly rail: number;
    readonly light: number;
    readonly ambient: number;
  };
  /** Colour grading applied in the final pass (lift/gamma/gain are per-channel). */
  readonly grading: {
    readonly lift: readonly [number, number, number];
    readonly gamma: readonly [number, number, number];
    readonly gain: readonly [number, number, number];
    readonly saturation: number;
    readonly contrast: number;
  };
  /** Music low-pass cutoff (Hz) and an intensity bias for the adaptive layers. */
  readonly music: { readonly cutoff: number; readonly bias: number; readonly root: number };
  /** Pattern used when generation cannot certify a chunk (must be trivially passable). */
  readonly fallbackPattern: string;
}

export interface DifficultyCurveDef {
  /** Base difficulty by distance travelled in the run (piecewise linear). */
  readonly distance: readonly number[];
  readonly base: readonly number[];
  readonly minD: number;
  readonly maxD: number;
  /** Max change of difficulty between consecutive chunks. */
  readonly maxStep: number;
  /** Gap between patterns in metres. */
  readonly patternGap: DRange;
  /**
   * Calm lead-in at the start of every chunk, in seconds of travel at the certified speed. Every position the
   * player can reach at a chunk boundary must be able to survive the next chunk, which needs lateral room.
   */
  readonly leadInSeconds: number;
  /** Multiplier on element counts. */
  readonly density: DRange;
  /** How strongly persistent skill (−1..1) shifts difficulty. */
  readonly skillOffset: number;
  /** In-run adaptive offset limit and gain. */
  readonly inRunOffsetMax: number;
  readonly inRunGain: number;
  /** Near-misses per 100 m considered "in the flow". */
  readonly targetNearMissPer100m: number;
  /** Expected run distance at skill 0, in metres; deaths far below/above shift skill. */
  readonly expectedDistance: number;
  /** EMA factor for skill updates after each run. */
  readonly skillEma: number;
}

export type UpgradeStat =
  | 'boostDuration'
  | 'energyRegen'
  | 'lateralSpeed'
  | 'focusCapacity'
  | 'magnetRadius'
  | 'comboWindow'
  | 'abilityCharge'
  | 'reviveDiscount'
  | 'shardValue';

export interface UpgradeDef {
  readonly id: string;
  readonly branch: 'propulsion' | 'handling' | 'salvage' | 'systems';
  readonly name: string;
  readonly desc: string;
  readonly stat: UpgradeStat;
  /** Additive bonus per level (fraction for multiplicative stats). */
  readonly perLevel: number;
  readonly costs: readonly number[];
  readonly requires: readonly string[];
}

export type MissionType =
  | 'distanceRun'
  | 'distanceTotal'
  | 'nearMissRun'
  | 'nearMissTotal'
  | 'shardsTotal'
  | 'abilityUses'
  | 'boosts'
  | 'scoreRun'
  | 'reachBiome'
  | 'perfects';

export interface MissionDef {
  readonly id: string;
  readonly type: MissionType;
  /** `{n}` is replaced by the target. */
  readonly text: string;
  readonly target: Range;
  /** Targets are rounded to this step. */
  readonly step: number;
  readonly reward: number;
}

export interface CosmeticDef {
  readonly id: string;
  readonly name: string;
  readonly kind: 'paint' | 'trail';
  readonly colors: readonly number[];
  readonly price: number;
}

export interface HapticDef {
  /** navigator.vibrate pattern (ms on, off, on...). */
  readonly pattern: readonly number[];
  /** Minimum ms between two pulses of this event. */
  readonly cooldown: number;
}
