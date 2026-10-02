import { OBSTACLES } from '../../data/obstacles.ts';
import { TUNING } from '../../data/tuning.ts';
import { type ChunkData, KIND_DRONE, KIND_STATIC, KIND_WELL, SHAPE_BOX, SHAPE_SPHERE } from '../sim/chunk.ts';
import { wellDriftBound } from '../sim/hazards.ts';

/** Appends an obstacle of definition `def` at (x, y, s) with uniform scale. Returns its index or -1 if full. */
export function placeObstacle(
  c: ChunkData,
  def: number,
  x: number,
  y: number,
  s: number,
  scale: number,
  seed: number,
): number {
  if (c.obsCount >= TUNING.MAX_OBSTACLES_PER_CHUNK) return -1;
  const d = OBSTACLES[def]!;
  const i = c.obsCount++;
  c.obsDef[i] = def;
  c.obsShape[i] = d.shape === 'sphere' ? SHAPE_SPHERE : SHAPE_BOX;
  c.obsKind[i] = d.kind === 'drone' ? KIND_DRONE : d.kind === 'well' ? KIND_WELL : KIND_STATIC;
  c.obsFlags[i] = 0;
  c.obsX[i] = x;
  c.obsY[i] = y;
  c.obsS[i] = s;
  c.obsScale[i] = scale;
  c.obsSeed[i] = seed;
  c.obsR[i] = d.radius * scale;
  c.obsHX[i] = d.half[0] * (d.half[0] > 3 ? 1 : scale);
  c.obsHY[i] = d.half[1] * (d.half[1] > 3 ? 1 : scale);
  c.obsHS[i] = d.half[2] * scale;
  c.obsAmpX[i] = 0;
  c.obsAmpY[i] = 0;
  c.obsPeriod[i] = 1;
  c.obsPhase[i] = 0;
  c.obsOrbit[i] = 0;
  c.obsWellG[i] = 0;
  c.obsWellA[i] = 1;
  c.obsWellRange[i] = 0;
  c.obsMinClear[i] = Number.POSITIVE_INFINITY;
  if (d.well) {
    c.obsWellG[i] = d.well.strength;
    c.obsWellA[i] = d.well.softening;
    c.obsWellRange[i] = d.well.range;
    c.gMax += wellDriftBound(d.well.strength, d.well.softening);
  }
  return i;
}

/** Configures obstacle i as a drone following a sinusoidal path keyed on ship travel. */
export function setDronePath(
  c: ChunkData,
  i: number,
  ampX: number,
  ampY: number,
  period: number,
  phase: number,
  orbit: boolean,
): void {
  c.obsAmpX[i] = ampX;
  c.obsAmpY[i] = ampY;
  c.obsPeriod[i] = period;
  c.obsPhase[i] = phase;
  c.obsOrbit[i] = orbit ? 1 : 0;
}

export function placeShard(c: ChunkData, x: number, y: number, s: number): void {
  if (c.shardCount >= TUNING.MAX_SHARDS_PER_CHUNK) return;
  const i = c.shardCount++;
  c.shardX[i] = x;
  c.shardY[i] = y;
  c.shardS[i] = s;
  c.shardTaken[i] = 0;
}

/** Recomputes c.gMax from the active wells (after repair removals). */
export function recomputeGMax(c: ChunkData): void {
  let g = 0;
  for (let i = 0; i < c.obsCount; i++) {
    if (c.obsKind[i] === KIND_WELL && c.isActive(i)) g += wellDriftBound(c.obsWellG[i]!, c.obsWellA[i]!);
  }
  c.gMax = g;
}
