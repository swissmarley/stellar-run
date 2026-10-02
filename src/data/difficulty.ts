import type { DifficultyCurveDef } from './types.ts';

/** The single difficulty curve used by the director. */
export const DIFFICULTY: DifficultyCurveDef = Object.freeze<DifficultyCurveDef>({
  distance: [0, 600, 1500, 3000, 5000, 8000],
  base: [0.08, 0.2, 0.38, 0.6, 0.8, 1.0],
  minD: 0.05,
  maxD: 1,
  maxStep: 0.08,
  patternGap: [22, 7],
  density: [0.6, 1.2],
  skillOffset: 0.2,
  inRunOffsetMax: 0.12,
  inRunGain: 0.025,
  targetNearMissPer100m: 1.0,
  expectedDistance: 1500,
  skillEma: 0.35,
});
