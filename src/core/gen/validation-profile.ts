import { SHIPS } from '../../data/ships.ts';
import { TUNING } from '../../data/tuning.ts';

/**
 * Worst-case composite ship used by the passability proof: the slowest lateral speed, the largest hitbox and
 * the highest forward speed of ANY ship (without upgrades; upgrades only improve lateral speed). A chunk
 * certified for this composite is passable for every ship, so one seed gives one layout for everyone.
 */
export interface ValidationProfile {
  readonly vLatMin: number;
  readonly rMax: number;
  readonly hMax: number;
  readonly speedFactorMax: number;
  readonly boostMax: number;
}

function build(): ValidationProfile {
  let vLatMin = Number.POSITIVE_INFINITY;
  let rMax = 0;
  let hMax = 0;
  let sfMax = 0;
  for (const s of SHIPS) {
    if (s.lateralSpeed < vLatMin) vLatMin = s.lateralSpeed;
    if (s.hitRadius > rMax) rMax = s.hitRadius;
    if (s.hitHalfLength > hMax) hMax = s.hitHalfLength;
    if (s.speedFactor > sfMax) sfMax = s.speedFactor;
  }
  return Object.freeze({ vLatMin, rMax, hMax, speedFactorMax: sfMax, boostMax: TUNING.BOOST_MULT });
}

export const PROFILE: ValidationProfile = build();

/** Cruise speed (m/s, before ship factor) for difficulty d. */
export function cruiseFor(d: number): number {
  return TUNING.SPEED_MIN + (TUNING.SPEED_MAX - TUNING.SPEED_MIN) * d;
}

/** Highest forward speed any ship can reach in a chunk whose own and previous cruise speeds are given. */
export function certifiedSpeed(cruise: number, prevCruise: number): number {
  const c = cruise > prevCruise ? cruise : prevCruise;
  return c * PROFILE.speedFactorMax * PROFILE.boostMax;
}
