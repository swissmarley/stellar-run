import { DIFFICULTY } from '../../data/difficulty.ts';
import type { DifficultyCurveDef } from '../../data/types.ts';
import { clamp, piecewise } from '../det/math.ts';

/** Persistent part of the director (saved between sessions). */
export interface DirectorState {
  /** −1 (struggling) .. +1 (expert). */
  skill: number;
  runs: number;
}

/**
 * Difficulty director. Difficulty d ∈ [minD, maxD] for each chunk is:
 *   base(distance) + skillOffset·skill + inRun   (clamped, and rate-limited to ±maxStep per chunk)
 *  - skill: EMA over runs of how far the player gets relative to the expected distance (death rate proxy).
 *  - inRun: adapts within a run to the near-miss rate (a player threading tight gaps is in the flow).
 * Pure and deterministic: it only sees sim events, never wall-clock time.
 */
export class Director {
  readonly curve: DifficultyCurveDef;
  skill = 0;
  runs = 0;
  inRun = 0;
  private prevD = -1;
  lastD = 0;

  constructor(curve: DifficultyCurveDef = DIFFICULTY) {
    this.curve = curve;
  }

  restore(s: DirectorState | null | undefined): void {
    this.skill = s && Number.isFinite(s.skill) ? clamp(s.skill, -1, 1) : 0;
    this.runs = s && Number.isFinite(s.runs) ? Math.max(0, Math.floor(s.runs)) : 0;
  }

  snapshot(): DirectorState {
    return { skill: this.skill, runs: this.runs };
  }

  beginRun(): void {
    this.inRun = 0;
    this.prevD = -1;
  }

  /** Difficulty for a chunk starting at track distance `startS`. Always within [minD, maxD]. */
  difficultyFor(startS: number): number {
    const c = this.curve;
    const dist = Number.isFinite(startS) ? startS : 0;
    let d = piecewise(c.distance, c.base, dist) + c.skillOffset * this.skill + this.inRun;
    if (!Number.isFinite(d)) d = c.minD;
    if (this.prevD >= 0) d = clamp(d, this.prevD - c.maxStep, this.prevD + c.maxStep);
    d = clamp(d, c.minD, c.maxD);
    this.prevD = d;
    this.lastD = d;
    return d;
  }

  /** Feedback after a chunk is cleared alive. */
  onChunkCleared(length: number, nearMisses: number): void {
    const c = this.curve;
    if (!(length > 0) || !Number.isFinite(nearMisses)) return;
    const rate = (nearMisses / length) * 100;
    const t = c.targetNearMissPer100m;
    const err = clamp((rate - t) / t, -1, 1);
    this.inRun = clamp(this.inRun + c.inRunGain * err, -c.inRunOffsetMax, c.inRunOffsetMax);
  }

  /** Feedback when a run ends (death). */
  onRunEnd(distance: number): void {
    const c = this.curve;
    if (!Number.isFinite(distance) || distance < 0) return;
    const e = c.expectedDistance;
    const perf = (distance - e) / (distance + e);
    this.skill = clamp((1 - c.skillEma) * this.skill + c.skillEma * perf, -1, 1);
    this.runs++;
  }
}
