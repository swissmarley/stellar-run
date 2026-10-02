import type { CosmeticDef } from './types.ts';

/** Cosmetic paints (hull tint) and engine trails. Bought with shards only; purely visual. */
export const COSMETICS: readonly CosmeticDef[] = Object.freeze<CosmeticDef[]>([
  { id: 'paint_factory', name: 'Factory White', kind: 'paint', colors: [0xffffff], price: 0 },
  { id: 'paint_sky', name: 'Sky Blue', kind: 'paint', colors: [0x9fd6f5], price: 250 },
  { id: 'paint_amber', name: 'Amber', kind: 'paint', colors: [0xf2c46d], price: 250 },
  { id: 'paint_jade', name: 'Jade', kind: 'paint', colors: [0x6fd1b0], price: 400 },
  { id: 'paint_orchid', name: 'Orchid', kind: 'paint', colors: [0xe3a6c8], price: 400 },
  { id: 'paint_graphite', name: 'Graphite', kind: 'paint', colors: [0x7a8290], price: 600 },
  { id: 'trail_stock', name: 'Stock Plasma', kind: 'trail', colors: [], price: 0 },
  { id: 'trail_solar', name: 'Solar Flare', kind: 'trail', colors: [0xe69f00], price: 300 },
  { id: 'trail_ion', name: 'Ion Blue', kind: 'trail', colors: [0x56b4e9], price: 300 },
  { id: 'trail_verdant', name: 'Verdant', kind: 'trail', colors: [0x009e73], price: 500 },
  { id: 'trail_nova', name: 'Nova Pink', kind: 'trail', colors: [0xcc79a7], price: 500 },
]);
