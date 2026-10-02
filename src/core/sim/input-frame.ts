import { TUNING } from '../../data/tuning.ts';

/** Edge-triggered: start a boost burst. */
export const BTN_BOOST = 1;
/** Level: focus (slow-mo) requested. */
export const BTN_FOCUS = 2;
/** Edge-triggered: fire the ship ability. */
export const BTN_ABILITY = 4;
/** Edge-triggered: revive (only meaningful while dead; issued by the game flow). */
export const BTN_REVIVE = 8;

/**
 * One tick of player intent, quantised to integers so a recorded stream replays bit-exactly.
 * Steering is a lateral velocity command in units of the ship's lateral speed (circle-clamped by the sim).
 */
export class InputFrame {
  steerX = 0;
  steerY = 0;
  buttons = 0;

  clear(): void {
    this.steerX = 0;
    this.steerY = 0;
    this.buttons = 0;
  }

  copyFrom(o: InputFrame): void {
    this.steerX = o.steerX;
    this.steerY = o.steerY;
    this.buttons = o.buttons;
  }

  /** Sets steering from floats in [-1, 1] (quantised). */
  setSteer(x: number, y: number): void {
    this.steerX = quantise(x);
    this.steerY = quantise(y);
  }
}

export function quantise(v: number): number {
  const q = TUNING.INPUT_QUANT;
  const r = Math.round(v * q);
  return r > q ? q : r < -q ? -q : r === 0 ? 0 : r;
}
