import { BIOMES } from './biomes.ts';
import { OBSTACLES } from './obstacles.ts';
import { SHIPS } from './ships.ts';
import { UPGRADES } from './upgrades.ts';

/** Ordered lookups from definition id to registry index. Order is part of determinism: append only. */
function indexMap(list: readonly { id: string }[], kind: string): Readonly<Record<string, number>> {
  const map: Record<string, number> = {};
  list.forEach((d, i) => {
    if (d.id in map) throw new Error(`Duplicate ${kind} id "${d.id}"`);
    map[d.id] = i;
  });
  return Object.freeze(map);
}

export const OBSTACLE_INDEX = indexMap(OBSTACLES, 'obstacle');
export const SHIP_INDEX = indexMap(SHIPS, 'ship');
export const BIOME_INDEX = indexMap(BIOMES, 'biome');
export const UPGRADE_INDEX = indexMap(UPGRADES, 'upgrade');

export function obstacleIndex(id: string): number {
  const i = OBSTACLE_INDEX[id];
  if (i === undefined) throw new Error(`Unknown obstacle "${id}"`);
  return i;
}

export function biomeIndex(id: string): number {
  const i = BIOME_INDEX[id];
  if (i === undefined) throw new Error(`Unknown biome "${id}"`);
  return i;
}

export function shipIndex(id: string): number {
  const i = SHIP_INDEX[id];
  if (i === undefined) throw new Error(`Unknown ship "${id}"`);
  return i;
}
