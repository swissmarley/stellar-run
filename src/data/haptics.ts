import type { HapticDef } from './types.ts';

/** Vibration patterns (ms on/off) per game event. Kept short: haptics should accent, not buzz. */
export const HAPTICS = Object.freeze({
  nearMiss: { pattern: [12], cooldown: 70 },
  perfect: { pattern: [8, 30, 16], cooldown: 90 },
  shard: { pattern: [5], cooldown: 60 },
  boost: { pattern: [18], cooldown: 150 },
  death: { pattern: [70, 40, 140], cooldown: 500 },
  ability: { pattern: [25, 25, 25], cooldown: 300 },
  abilityReady: { pattern: [10, 50, 10], cooldown: 500 },
  milestone: { pattern: [10, 40, 10, 40, 10], cooldown: 500 },
  ui: { pattern: [6], cooldown: 50 },
} satisfies Record<string, HapticDef>);

export type HapticEvent = keyof typeof HAPTICS;
