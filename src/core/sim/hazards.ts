import { dcos, dsin, TWO_PI } from '../det/math.ts';
import { type ChunkData, KIND_DRONE, KIND_WELL } from './chunk.ts';

/**
 * Moving-hazard and gravity-field math. Every moving hazard is a function of the SHIP's track distance,
 * never of time, so a chunk's passability does not depend on the speed profile (see docs/ARCHITECTURE.md).
 */

/** Scratch output of obstaclePos (allocation-free). */
export const posOut = { x: 0, y: 0 };

/** Lateral position of obstacle i when the ship is at track distance shipS. */
export function obstaclePos(c: ChunkData, i: number, shipS: number): void {
  if (c.obsKind[i] !== KIND_DRONE) {
    posOut.x = c.obsX[i]!;
    posOut.y = c.obsY[i]!;
    return;
  }
  const th = TWO_PI * ((shipS - c.obsS[i]!) / c.obsPeriod[i]! + c.obsPhase[i]!);
  const sn = dsin(th);
  posOut.x = c.obsX[i]! + c.obsAmpX[i]! * sn;
  posOut.y = c.obsY[i]! + c.obsAmpY[i]! * (c.obsOrbit[i] === 1 ? dcos(th) : sn);
}

/** Lipschitz bound of a drone's lateral position w.r.t. ship travel (metres per metre). */
export function droneLipschitz(c: ChunkData, i: number): number {
  const ax = c.obsAmpX[i]!;
  const ay = c.obsAmpY[i]!;
  return (TWO_PI * Math.sqrt(ax * ax + ay * ay)) / c.obsPeriod[i]!;
}

/** Upper bound of |drift| (per metre of travel) of a well with strength G and softening a. */
export function wellDriftBound(g: number, a: number): number {
  return g / (2 * a);
}

/** Scratch output of wellDrift: [x, y] drift per metre of travel. */
export const DRIFT = new Float64Array(2);
/** Scratch input of wellDrift: [x, y, s] (typed slots avoid boxing double arguments). */
export const DRIFT_AT = new Float64Array(3);

/**
 * Lateral drift per metre of forward travel at DRIFT_AT = (x, y, s), summed over the chunk's wells:
 * g = G·w(Δs)·d/(|d|² + a²), w = 1 − (Δs/range)², pointing at the singularity.
 */
export function wellDrift(c: ChunkData): void {
  const x = DRIFT_AT[0]!;
  const y = DRIFT_AT[1]!;
  const s = DRIFT_AT[2]!;
  let gx = 0;
  let gy = 0;
  if (c.gMax > 0) {
    for (let i = 0; i < c.obsCount; i++) {
      if (c.obsKind[i] !== KIND_WELL || !c.isActive(i)) continue;
      const range = c.obsWellRange[i]!;
      const ds = s - c.obsS[i]!;
      if (ds > range || ds < -range) continue;
      const q = ds / range;
      const w = 1 - q * q;
      const dx = c.obsX[i]! - x;
      const dy = c.obsY[i]! - y;
      const a = c.obsWellA[i]!;
      const f = (c.obsWellG[i]! * w) / (dx * dx + dy * dy + a * a);
      gx += dx * f;
      gy += dy * f;
    }
  }
  DRIFT[0] = gx;
  DRIFT[1] = gy;
}
