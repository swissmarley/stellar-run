/**
 * Colour-blind-safe palettes (Okabe & Ito, "Color Universal Design", 2008). Hazards and pickups are never
 * distinguished by colour alone: hazards are angular with a rim glow, pickups are glowing diamonds.
 */
export const OKABE_ITO = {
  black: 0x000000,
  orange: 0xe69f00,
  skyBlue: 0x56b4e9,
  bluishGreen: 0x009e73,
  yellow: 0xf0e442,
  blue: 0x0072b2,
  vermillion: 0xd55e00,
  reddishPurple: 0xcc79a7,
} as const;

export interface GamePalette {
  readonly hazardRim: number;
  readonly hazardBody: number;
  readonly energy: number;
  readonly drone: number;
  readonly pickup: number;
  readonly player: number;
  readonly ui: number;
  readonly danger: number;
}

export type PaletteMode = 'standard' | 'highContrast';

export const PALETTES: Readonly<Record<PaletteMode, GamePalette>> = {
  standard: {
    hazardRim: OKABE_ITO.vermillion,
    hazardBody: 0x6b625c,
    energy: OKABE_ITO.orange,
    drone: OKABE_ITO.yellow,
    pickup: OKABE_ITO.skyBlue,
    player: 0xf2f6ff,
    ui: OKABE_ITO.skyBlue,
    danger: OKABE_ITO.vermillion,
  },
  highContrast: {
    hazardRim: 0xffffff,
    hazardBody: 0x3a3a3a,
    energy: OKABE_ITO.yellow,
    drone: OKABE_ITO.orange,
    pickup: OKABE_ITO.yellow,
    player: OKABE_ITO.skyBlue,
    ui: OKABE_ITO.yellow,
    danger: OKABE_ITO.orange,
  },
};
