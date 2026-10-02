import type { PaletteMode } from '../data/palette.ts';
import {
  DEFAULT_KEYS,
  type HoldAction,
  type KeyBindings,
  type SteeringMode,
  type TapAction,
} from '../game/input/input-router.ts';
import type { QualityTier } from '../game/render/quality.ts';
import type { HapticLevel } from './haptics.ts';

export const SETTINGS_VERSION = 1;

export interface Settings {
  controls: {
    steering: SteeringMode;
    dragSensitivity: number;
    tiltSensitivity: number;
    invertY: boolean;
    leftHanded: boolean;
    tapAction: TapAction;
    holdAction: HoldAction;
    keys: KeyBindings;
  };
  audio: { master: number; music: number; sfx: number; muted: boolean };
  haptics: HapticLevel;
  graphics: { quality: 'auto' | QualityTier; fps30: boolean; showFps: boolean };
  a11y: {
    reducedMotion: 'auto' | 'on' | 'off';
    palette: PaletteMode;
    textScale: number;
    shake: number;
    flashes: boolean;
    popups: boolean;
  };
  privacy: { noticeSeen: boolean };
}

export function defaultSettings(): Settings {
  return {
    controls: {
      steering: 'drag',
      dragSensitivity: 1,
      tiltSensitivity: 1,
      invertY: false,
      leftHanded: false,
      tapAction: 'boost',
      holdAction: 'focus',
      keys: structuredClone(DEFAULT_KEYS),
    },
    audio: { master: 0.8, music: 0.7, sfx: 0.9, muted: false },
    haptics: 'full',
    graphics: { quality: 'auto', fps30: false, showFps: false },
    a11y: { reducedMotion: 'auto', palette: 'standard', textScale: 1, shake: 1, flashes: true, popups: true },
    privacy: { noticeSeen: false },
  };
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function n(v: unknown, fallback: number, lo: number, hi: number): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return x < lo ? lo : x > hi ? hi : x;
}

function keyList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback.slice();
  const out = v
    .filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length < 32)
    .slice(0, 4);
  return out.length > 0 ? out : fallback.slice();
}

/** Coerces stored JSON into valid settings (unknown values fall back to defaults). */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, Record<string, unknown>>;
  const c = r.controls ?? {};
  const keys = (c.keys ?? {}) as Record<string, unknown>;
  d.controls = {
    steering: pick(c.steering, ['drag', 'tilt'] as const, 'drag'),
    dragSensitivity: n(c.dragSensitivity, 1, 0.4, 2.5),
    tiltSensitivity: n(c.tiltSensitivity, 1, 0.4, 2.5),
    invertY: c.invertY === true,
    leftHanded: c.leftHanded === true,
    tapAction: pick(c.tapAction, ['boost', 'ability', 'none'] as const, 'boost'),
    holdAction: pick(c.holdAction, ['focus', 'none'] as const, 'focus'),
    keys: {
      left: keyList(keys.left, DEFAULT_KEYS.left),
      right: keyList(keys.right, DEFAULT_KEYS.right),
      up: keyList(keys.up, DEFAULT_KEYS.up),
      down: keyList(keys.down, DEFAULT_KEYS.down),
      boost: keyList(keys.boost, DEFAULT_KEYS.boost),
      focus: keyList(keys.focus, DEFAULT_KEYS.focus),
      ability: keyList(keys.ability, DEFAULT_KEYS.ability),
      pause: keyList(keys.pause, DEFAULT_KEYS.pause),
    },
  };
  const a = r.audio ?? {};
  d.audio = {
    master: n(a.master, 0.8, 0, 1),
    music: n(a.music, 0.7, 0, 1),
    sfx: n(a.sfx, 0.9, 0, 1),
    muted: a.muted === true,
  };
  d.haptics = pick(r.haptics as unknown, ['off', 'low', 'full'] as const, 'full');
  const g = r.graphics ?? {};
  d.graphics = {
    quality: pick(g.quality, ['auto', 'low', 'medium', 'high'] as const, 'auto'),
    fps30: g.fps30 === true,
    showFps: g.showFps === true,
  };
  const x = r.a11y ?? {};
  d.a11y = {
    reducedMotion: pick(x.reducedMotion, ['auto', 'on', 'off'] as const, 'auto'),
    palette: pick(x.palette, ['standard', 'highContrast'] as const, 'standard'),
    textScale: n(x.textScale, 1, 1, 1.5),
    shake: n(x.shake, 1, 0, 1),
    flashes: x.flashes !== false,
    popups: x.popups !== false,
  };
  d.privacy = { noticeSeen: r.privacy?.noticeSeen === true };
  return d;
}
