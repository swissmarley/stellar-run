import { TUNING } from '../../data/tuning.ts';

const MAX_O = TUNING.MAX_OBSTACLES_PER_CHUNK;
const MAX_SH = TUNING.MAX_SHARDS_PER_CHUNK;
const ROWS = TUNING.GRID_ROWS;
const MAX_SL = TUNING.MAX_SLICES;

/** Obstacle flag: removed by the generator's repair step (never existed in play). */
export const OF_REMOVED = 1;
/** Obstacle flag: destroyed during play (Pulse). */
export const OF_DESTROYED = 2;
/** Obstacle flag: the ship has fully passed it (near-miss evaluated). */
export const OF_PASSED = 4;
/** Shape: sphere / box (Uint8). */
export const SHAPE_SPHERE = 0;
export const SHAPE_BOX = 1;
/** Kind: static / drone / well (Uint8). */
export const KIND_STATIC = 0;
export const KIND_DRONE = 1;
export const KIND_WELL = 2;

/**
 * One generated chunk: obstacles and shards as structure-of-arrays, plus the passability certificate
 * (per-slice free masks, backward-viable sets, entry and exit sets). Instances are pooled and reused.
 */
export class ChunkData {
  index = -1;
  startS = 0;
  length: number = TUNING.CHUNK_LENGTH;
  biome = 0;
  difficulty = 0;
  /** Target cruise speed (m/s, before ship speed factor). */
  cruise = 0;
  /** Certified max forward speed: the passability proof holds for any speed ≤ vCert. */
  vCert = 0;
  /** Lateral speed assumed by the proof after gravity drift is subtracted. */
  vLatEff = 0;
  /** Validation clearance margin (metres). */
  margin = 0;
  /** Sum of gravity-drift bounds (per metre of travel) of all wells in the chunk. */
  gMax = 0;
  sliceCount = 0;
  sliceLen = 0;
  /** Free masks F_k: row j of slice k at [k*ROWS + j]; bit i = column i is free. */
  readonly free = new Int32Array(MAX_SL * ROWS);
  /** Backward-viable sets V_k for k in [0, sliceCount]. */
  readonly viable = new Int32Array((MAX_SL + 1) * ROWS);
  readonly entry = new Int32Array(ROWS);
  readonly exit = new Int32Array(ROWS);
  certified = false;
  /** True while the chunk is being generated asynchronously; the sim and views must not read it yet. */
  pending = false;
  repairs = 0;
  attempts = 0;
  fallback = false;
  /** Generator time in microseconds (diagnostics only; never fed back into the sim). */
  genMicros = 0;

  obsCount = 0;
  readonly obsDef = new Uint8Array(MAX_O);
  readonly obsShape = new Uint8Array(MAX_O);
  readonly obsKind = new Uint8Array(MAX_O);
  readonly obsFlags = new Uint8Array(MAX_O);
  readonly obsX = new Float64Array(MAX_O);
  readonly obsY = new Float64Array(MAX_O);
  readonly obsS = new Float64Array(MAX_O);
  /** Sphere radius (scaled). */
  readonly obsR = new Float64Array(MAX_O);
  /** Box half extents (scaled). */
  readonly obsHX = new Float64Array(MAX_O);
  readonly obsHY = new Float64Array(MAX_O);
  readonly obsHS = new Float64Array(MAX_O);
  /** Visual scale and rotation seed. */
  readonly obsScale = new Float64Array(MAX_O);
  readonly obsSeed = new Float64Array(MAX_O);
  /** Drone path: x = X + ampX·sin(θ), y = Y + ampY·(orbit ? cos θ : sin θ), θ = 2π((shipS − S)/period + phase). */
  readonly obsAmpX = new Float64Array(MAX_O);
  readonly obsAmpY = new Float64Array(MAX_O);
  readonly obsPeriod = new Float64Array(MAX_O);
  readonly obsPhase = new Float64Array(MAX_O);
  readonly obsOrbit = new Uint8Array(MAX_O);
  /** Well: strength G, softening a, range along s. */
  readonly obsWellG = new Float64Array(MAX_O);
  readonly obsWellA = new Float64Array(MAX_O);
  readonly obsWellRange = new Float64Array(MAX_O);
  /** Minimum surface clearance seen while passing (near-miss tracking). */
  readonly obsMinClear = new Float64Array(MAX_O);

  shardCount = 0;
  readonly shardX = new Float64Array(MAX_SH);
  readonly shardY = new Float64Array(MAX_SH);
  readonly shardS = new Float64Array(MAX_SH);
  readonly shardTaken = new Uint8Array(MAX_SH);

  reset(index: number, startS: number): void {
    this.index = index;
    this.startS = startS;
    this.length = TUNING.CHUNK_LENGTH;
    this.biome = 0;
    this.difficulty = 0;
    this.cruise = 0;
    this.vCert = 0;
    this.vLatEff = 0;
    this.margin = 0;
    this.gMax = 0;
    this.sliceCount = 0;
    this.sliceLen = 0;
    this.certified = false;
    this.pending = false;
    this.repairs = 0;
    this.attempts = 0;
    this.fallback = false;
    this.genMicros = 0;
    this.obsCount = 0;
    this.shardCount = 0;
  }

  /** Clears obstacles and shards only (used between generation attempts). */
  clearContent(): void {
    this.obsCount = 0;
    this.shardCount = 0;
    this.gMax = 0;
  }

  get endS(): number {
    return this.startS + this.length;
  }

  /** Track-distance extent of obstacle i's body (without drone/ship inflation). */
  obsSMin(i: number): number {
    return this.obsS[i]! - (this.obsShape[i] === SHAPE_SPHERE ? this.obsR[i]! : this.obsHS[i]!);
  }

  obsSMax(i: number): number {
    return this.obsS[i]! + (this.obsShape[i] === SHAPE_SPHERE ? this.obsR[i]! : this.obsHS[i]!);
  }

  isActive(i: number): boolean {
    return (this.obsFlags[i]! & (OF_REMOVED | OF_DESTROYED)) === 0;
  }

  /** Copies everything (used by tests and the bench to snapshot a chunk). */
  copyFrom(o: ChunkData): void {
    this.reset(o.index, o.startS);
    this.length = o.length;
    this.biome = o.biome;
    this.difficulty = o.difficulty;
    this.cruise = o.cruise;
    this.vCert = o.vCert;
    this.vLatEff = o.vLatEff;
    this.margin = o.margin;
    this.gMax = o.gMax;
    this.sliceCount = o.sliceCount;
    this.sliceLen = o.sliceLen;
    this.free.set(o.free);
    this.viable.set(o.viable);
    this.entry.set(o.entry);
    this.exit.set(o.exit);
    this.certified = o.certified;
    this.repairs = o.repairs;
    this.attempts = o.attempts;
    this.fallback = o.fallback;
    this.obsCount = o.obsCount;
    this.shardCount = o.shardCount;
    for (const k of OBS_ARRAYS) (this[k] as Float64Array).set(o[k] as Float64Array);
    for (const k of SHARD_ARRAYS) (this[k] as Float64Array).set(o[k] as Float64Array);
  }
}

const OBS_ARRAYS = [
  'obsDef',
  'obsShape',
  'obsKind',
  'obsFlags',
  'obsX',
  'obsY',
  'obsS',
  'obsR',
  'obsHX',
  'obsHY',
  'obsHS',
  'obsScale',
  'obsSeed',
  'obsAmpX',
  'obsAmpY',
  'obsPeriod',
  'obsPhase',
  'obsOrbit',
  'obsWellG',
  'obsWellA',
  'obsWellRange',
  'obsMinClear',
] as const;
const SHARD_ARRAYS = ['shardX', 'shardY', 'shardS', 'shardTaken'] as const;
