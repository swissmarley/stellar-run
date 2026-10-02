import { COSMETICS } from '../../data/cosmetics.ts';
import { ECONOMY } from '../../data/economy.ts';
import { SHIPS } from '../../data/ships.ts';
import { UPGRADES } from '../../data/upgrades.ts';
import type { RunSim } from '../sim/run-sim.ts';
import type { Profile } from './profile.ts';

/** Pure economy rules. Every purchase is in shards earned by playing; nothing is sold for money. */

export type PurchaseResult =
  | { ok: true }
  | { ok: false; reason: 'owned' | 'funds' | 'locked' | 'maxed' | 'unknown' };

/** Shards earned by a finished run: shards collected (× refinery bonus) plus a distance bonus. */
export function runEarnings(sim: RunSim): number {
  return Math.floor(sim.shards * sim.stats.shardValue + Math.floor(sim.s / 100) * ECONOMY.SHARDS_PER_100M);
}

/** Price of the one revive allowed per run. */
export function reviveCost(distance: number, discount: number): number {
  const base = ECONOMY.REVIVE_BASE_COST + Math.floor(distance / 1000) * ECONOMY.REVIVE_COST_PER_KM;
  return Math.max(10, Math.round(base * (1 - discount)));
}

export function buyShip(p: Profile, id: string): PurchaseResult {
  const ship = SHIPS.find((s) => s.id === id);
  if (!ship) return { ok: false, reason: 'unknown' };
  if (p.ownedShips.includes(id)) return { ok: false, reason: 'owned' };
  if (p.shards < ship.price) return { ok: false, reason: 'funds' };
  p.shards -= ship.price;
  p.ownedShips.push(id);
  return { ok: true };
}

export function upgradeLevel(p: Profile, id: string): number {
  return p.upgrades[id] ?? 0;
}

/** Cost of the next level, or -1 if maxed/unknown. */
export function nextUpgradeCost(p: Profile, id: string): number {
  const u = UPGRADES.find((x) => x.id === id);
  if (!u) return -1;
  const lv = upgradeLevel(p, id);
  return lv >= u.costs.length ? -1 : u.costs[lv]!;
}

export function upgradeUnlocked(p: Profile, id: string): boolean {
  const u = UPGRADES.find((x) => x.id === id);
  return !!u && u.requires.every((r) => upgradeLevel(p, r) > 0);
}

export function buyUpgrade(p: Profile, id: string): PurchaseResult {
  const cost = nextUpgradeCost(p, id);
  if (cost < 0) return { ok: false, reason: UPGRADES.some((u) => u.id === id) ? 'maxed' : 'unknown' };
  if (!upgradeUnlocked(p, id)) return { ok: false, reason: 'locked' };
  if (p.shards < cost) return { ok: false, reason: 'funds' };
  p.shards -= cost;
  p.upgrades[id] = upgradeLevel(p, id) + 1;
  return { ok: true };
}

export function buyCosmetic(p: Profile, id: string): PurchaseResult {
  const c = COSMETICS.find((x) => x.id === id);
  if (!c) return { ok: false, reason: 'unknown' };
  if (p.ownedCosmetics.includes(id)) return { ok: false, reason: 'owned' };
  if (p.shards < c.price) return { ok: false, reason: 'funds' };
  p.shards -= c.price;
  p.ownedCosmetics.push(id);
  return { ok: true };
}

export function equipCosmetic(p: Profile, id: string): boolean {
  const c = COSMETICS.find((x) => x.id === id);
  if (!c || !p.ownedCosmetics.includes(id)) return false;
  if (c.kind === 'paint') p.paint = id;
  else p.trail = id;
  return true;
}
