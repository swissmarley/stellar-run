import {
  BTN_ABILITY,
  BTN_BOOST,
  BTN_FOCUS,
  BTN_REVIVE,
  type InputFrame,
} from '../../core/sim/input-frame.ts';
import type { RunSim } from '../../core/sim/run-sim.ts';
import { DT, SHIP_X_LIMIT, SHIP_Y_LIMIT, TUNING } from '../../data/tuning.ts';

/** Approximate physical size of one CSS pixel on touch devices (browsers calibrate CSS px to ~1/160 in). */
const MM_PER_CSS_PX_TOUCH = 0.16;
/** On desktop monitors a CSS px is ~1/96 in. */
const MM_PER_CSS_PX_MOUSE = 0.26;

export type SteeringMode = 'drag' | 'tilt';
export type TapAction = 'boost' | 'ability' | 'none';
export type HoldAction = 'focus' | 'none';

export interface KeyBindings {
  left: string[];
  right: string[];
  up: string[];
  down: string[];
  boost: string[];
  focus: string[];
  ability: string[];
  pause: string[];
}

export interface InputSettings {
  steering: SteeringMode;
  dragSensitivity: number;
  tiltSensitivity: number;
  invertY: boolean;
  tapAction: TapAction;
  holdAction: HoldAction;
  keys: KeyBindings;
}

export const DEFAULT_KEYS: KeyBindings = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  boost: ['Space'],
  focus: ['ShiftLeft', 'ShiftRight'],
  ability: ['KeyE', 'Enter'],
  pause: ['Escape', 'KeyP'],
};

export function defaultInputSettings(): InputSettings {
  return {
    steering: 'drag',
    dragSensitivity: 1,
    tiltSensitivity: 1,
    invertY: false,
    tapAction: 'boost',
    holdAction: 'focus',
    keys: structuredClone(DEFAULT_KEYS),
  };
}

/**
 * Converts raw pointer/keyboard/tilt input into one quantised InputFrame per sim tick.
 *  - Drag: the finger moves a target point; the ship flies to it at full lateral speed (one-thumb).
 *  - Tilt: device roll/pitch relative to a calibrated neutral → lateral velocity.
 *  - Tap (short, still) → boost. Press-and-hold still at touch start → focus, latched until release.
 * Edge actions are buffered until the next sim tick consumes them, so no input is lost between ticks.
 */
export class InputRouter {
  settings: InputSettings;
  enabled = false;
  private readonly el: HTMLElement;
  private pointerId = -1;
  private pointerType = 'touch';
  private downT = 0;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private stillBroken = false;
  private focusLatched = false;
  private hasTarget = false;
  private targetX = 0;
  private targetY = 0;
  private boostPending = false;
  private abilityPending = false;
  private revivePending = false;
  private readonly keysDown = new Set<string>();
  private tiltOk = false;
  private tiltGamma = 0;
  private tiltBeta = 0;
  private neutralGamma = 0;
  private neutralBeta = 0;
  private needCalibrate = true;
  /** Wall-clock timestamp of the last raw input event (latency instrumentation). */
  lastInputAt = 0;
  onPause: (() => void) | null = null;
  /** Called on the first user gesture (audio unlock, tilt permission). */
  onGesture: (() => void) | null = null;
  private sim: RunSim | null = null;

  constructor(el: HTMLElement, settings: InputSettings) {
    this.el = el;
    this.settings = settings;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('lostpointercapture', this.onUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('deviceorientation', this.onOrientation);
  }

  bind(sim: RunSim): void {
    this.sim = sim;
  }

  /** Clears transient state at run start / resume. */
  resetForRun(): void {
    this.boostPending = false;
    this.abilityPending = false;
    this.revivePending = false;
    this.hasTarget = false;
    this.focusLatched = false;
    this.needCalibrate = true;
  }

  requestAbility(): void {
    this.abilityPending = true;
  }

  requestBoost(): void {
    this.boostPending = true;
  }

  requestRevive(): void {
    this.revivePending = true;
  }

  recalibrateTilt(): void {
    this.needCalibrate = true;
  }

  get tiltAvailable(): boolean {
    return this.tiltOk;
  }

  /** Asks for motion-sensor permission where required (iOS Safari). Must run inside a user gesture. */
  async requestTiltPermission(): Promise<boolean> {
    const DOE = (
      window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }
    ).DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        return (await DOE.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    }
    return 'DeviceOrientationEvent' in window;
  }

  private mmPerPx(): number {
    return this.pointerType === 'mouse' ? MM_PER_CSS_PX_MOUSE : MM_PER_CSS_PX_TOUCH;
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.onGesture?.();
    if (!this.enabled || this.pointerId !== -1) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    this.downT = e.timeStamp;
    this.downX = this.lastX = e.clientX;
    this.downY = this.lastY = e.clientY;
    this.moved = 0;
    this.stillBroken = false;
    this.focusLatched = false;
    this.lastInputAt = performance.now();
    if (this.sim) {
      this.targetX = this.sim.x;
      this.targetY = this.sim.y;
      this.hasTarget = this.settings.steering === 'drag';
    }
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    e.preventDefault();
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const mm = this.mmPerPx();
    this.moved += Math.abs(dx) + Math.abs(dy);
    const fromDownMm = (Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY)) * mm;
    if (fromDownMm > TUNING.HOLD_STILL_MM) this.stillBroken = true;
    if (this.hasTarget) {
      const k = mm * TUNING.DRAG_METERS_PER_MM * this.settings.dragSensitivity;
      this.targetX += dx * k;
      this.targetY += (this.settings.invertY ? dy : -dy) * k;
      if (this.targetX > SHIP_X_LIMIT) this.targetX = SHIP_X_LIMIT;
      else if (this.targetX < -SHIP_X_LIMIT) this.targetX = -SHIP_X_LIMIT;
      if (this.targetY > SHIP_Y_LIMIT) this.targetY = SHIP_Y_LIMIT;
      else if (this.targetY < -SHIP_Y_LIMIT) this.targetY = -SHIP_Y_LIMIT;
    }
    this.lastInputAt = performance.now();
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const dur = e.timeStamp - this.downT;
    const movedMm = this.moved * this.mmPerPx();
    if (this.enabled && dur <= TUNING.TAP_MAX_MS && movedMm <= TUNING.TAP_MAX_MOVE_MM) {
      if (this.settings.tapAction === 'boost') this.boostPending = true;
      else if (this.settings.tapAction === 'ability') this.abilityPending = true;
    }
    this.pointerId = -1;
    this.hasTarget = false;
    this.focusLatched = false;
    this.lastInputAt = performance.now();
  };

  private matches(list: string[], code: string): boolean {
    return list.includes(code);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.onGesture?.();
    const k = this.settings.keys;
    if (this.matches(k.pause, e.code)) {
      if (!e.repeat) this.onPause?.();
      return;
    }
    if (!this.enabled) return;
    if (!e.repeat) {
      if (this.matches(k.boost, e.code)) this.boostPending = true;
      if (this.matches(k.ability, e.code)) this.abilityPending = true;
    }
    this.keysDown.add(e.code);
    this.lastInputAt = performance.now();
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.keysDown.clear();
    this.pointerId = -1;
    this.hasTarget = false;
    this.focusLatched = false;
  };

  private readonly onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.gamma === null || e.beta === null) return;
    this.tiltOk = true;
    this.tiltGamma = e.gamma;
    this.tiltBeta = e.beta;
    if (this.needCalibrate) {
      this.neutralGamma = e.gamma;
      this.neutralBeta = e.beta;
      this.needCalibrate = false;
    }
  };

  private keyHeld(list: string[]): boolean {
    for (let i = 0; i < list.length; i++) if (this.keysDown.has(list[i]!)) return true;
    return false;
  }

  private tiltAxis(deg: number): number {
    const dz = TUNING.TILT_DEADZONE_DEG;
    const a = Math.abs(deg);
    if (a <= dz) return 0;
    const full = TUNING.TILT_FULL_DEG / this.settings.tiltSensitivity;
    const v = Math.min(1, (a - dz) / Math.max(1, full - dz));
    return deg < 0 ? -v : v;
  }

  /** Fills `out` for the next sim tick. Called once per tick by the game loop. */
  sample(now: number, out: InputFrame): void {
    out.clear();
    const sim = this.sim;
    let sx = 0;
    let sy = 0;
    const k = this.settings.keys;
    const kx = (this.keyHeld(k.right) ? 1 : 0) - (this.keyHeld(k.left) ? 1 : 0);
    const ky = (this.keyHeld(k.up) ? 1 : 0) - (this.keyHeld(k.down) ? 1 : 0);
    if (kx !== 0 || ky !== 0) {
      sx = kx;
      sy = this.settings.invertY ? -ky : ky;
      this.hasTarget = false;
    } else if (this.settings.steering === 'tilt' && this.tiltOk) {
      sx = this.tiltAxis(this.tiltGamma - this.neutralGamma);
      const by = this.tiltAxis(this.tiltBeta - this.neutralBeta);
      sy = this.settings.invertY ? by : -by;
    } else if (this.hasTarget && sim) {
      const step = sim.stats.lateralSpeed * DT;
      sx = (this.targetX - sim.x) / step;
      sy = (this.targetY - sim.y) / step;
    }
    const m2 = sx * sx + sy * sy;
    if (m2 > 1) {
      const inv = 1 / Math.sqrt(m2);
      sx *= inv;
      sy *= inv;
    }
    out.setSteer(sx, sy);
    if (
      this.pointerId !== -1 &&
      !this.focusLatched &&
      !this.stillBroken &&
      this.settings.holdAction === 'focus' &&
      now - this.downT >= TUNING.HOLD_STILL_MS
    ) {
      this.focusLatched = true;
    }
    let b = 0;
    if (this.boostPending) b |= BTN_BOOST;
    if (this.abilityPending) b |= BTN_ABILITY;
    if (this.revivePending) b |= BTN_REVIVE;
    if (this.focusLatched || this.keyHeld(k.focus)) b |= BTN_FOCUS;
    out.buttons = b;
    this.boostPending = false;
    this.abilityPending = false;
    this.revivePending = false;
  }

  dispose(): void {
    const el = this.el;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('lostpointercapture', this.onUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('deviceorientation', this.onOrientation);
  }
}
