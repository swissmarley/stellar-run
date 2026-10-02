import { COSMETICS } from '../../data/cosmetics.ts';
import { ECONOMY } from '../../data/economy.ts';
import { MISSIONS } from '../../data/missions.ts';
import { SHIPS } from '../../data/ships.ts';
import { UPGRADES } from '../../data/upgrades.ts';
import type { DirectorState } from '../director/director.ts';

/** Current save schema version. Bump it and add a migration in MIGRATIONS when the shape changes. */
export const PROFILE_VERSION = 2;

export interface MissionState {
  id: string;
  target: number;
  progress: number;
  claimed: boolean;
}

export interface LeaderEntry {
  score: number;
  distance: number;
  ship: string;
  date: string;
}

export interface LifetimeStats {
  runs: number;
  distance: number;
  nearMisses: number;
  perfects: number;
  shards: number;
  abilityUses: number;
  boosts: number;
  deaths: number;
}

/** Everything persisted about the player (settings live in a separate file). */
export interface Profile {
  shards: number;
  ownedShips: string[];
  selectedShip: string;
  upgrades: Record<string, number>;
  ownedCosmetics: string[];
  paint: string;
  trail: string;
  best: { score: number; distance: number };
  stats: LifetimeStats;
  missions: { day: string; list: MissionState[] };
  leaderboard: LeaderEntry[];
  director: DirectorState;
}

export function defaultProfile(): Profile {
  return {
    shards: ECONOMY.STARTING_SHARDS,
    ownedShips: [SHIPS[0]!.id],
    selectedShip: SHIPS[0]!.id,
    upgrades: {},
    ownedCosmetics: ['paint_factory', 'trail_stock'],
    paint: 'paint_factory',
    trail: 'trail_stock',
    best: { score: 0, distance: 0 },
    stats: {
      runs: 0,
      distance: 0,
      nearMisses: 0,
      perfects: 0,
      shards: 0,
      abilityUses: 0,
      boosts: 0,
      deaths: 0,
    },
    missions: { day: '', list: [] },
    leaderboard: [],
    director: { skill: 0, runs: 0 },
  };
}

function num(v: unknown, fallback: number, lo = 0, hi = Number.MAX_SAFE_INTEGER): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length < 64 ? v : fallback;
}

function ids(v: unknown, valid: ReadonlySet<string>): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && valid.has(x) && !out.includes(x)) out.push(x);
  return out;
}

const SHIP_IDS = new Set(SHIPS.map((s) => s.id));
const COSMETIC_IDS = new Set(COSMETICS.map((c) => c.id));
const MISSION_IDS = new Set(MISSIONS.map((m) => m.id));

/**
 * Coerces arbitrary parsed JSON into a valid Profile: unknown ids are dropped, numbers clamped, missing fields
 * defaulted. A save edited by hand or by an older/newer build can never crash the game.
 */
export function sanitizeProfile(raw: unknown): Profile {
  const d = defaultProfile();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const p: Profile = defaultProfile();
  p.shards = Math.floor(num(r.shards, d.shards, 0, 1e9));
  p.ownedShips = ids(r.ownedShips, SHIP_IDS);
  if (!p.ownedShips.includes(SHIPS[0]!.id)) p.ownedShips.unshift(SHIPS[0]!.id);
  p.selectedShip = str(r.selectedShip, d.selectedShip);
  if (!p.ownedShips.includes(p.selectedShip)) p.selectedShip = p.ownedShips[0]!;
  const ups = (r.upgrades && typeof r.upgrades === 'object' ? r.upgrades : {}) as Record<string, unknown>;
  for (const u of UPGRADES) {
    const lv = Math.floor(num(ups[u.id], 0, 0, u.costs.length));
    if (lv > 0) p.upgrades[u.id] = lv;
  }
  p.ownedCosmetics = ids(r.ownedCosmetics, COSMETIC_IDS);
  for (const base of ['paint_factory', 'trail_stock'])
    if (!p.ownedCosmetics.includes(base)) p.ownedCosmetics.push(base);
  p.paint = str(r.paint, d.paint);
  if (!p.ownedCosmetics.includes(p.paint) || !p.paint.startsWith('paint_')) p.paint = d.paint;
  p.trail = str(r.trail, d.trail);
  if (!p.ownedCosmetics.includes(p.trail) || !p.trail.startsWith('trail_')) p.trail = d.trail;
  const best = (r.best ?? {}) as Record<string, unknown>;
  p.best = { score: num(best.score, 0, 0, 1e12), distance: num(best.distance, 0, 0, 1e9) };
  const st = (r.stats ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(d.stats) as (keyof LifetimeStats)[])
    p.stats[k] = Math.floor(num(st[k], 0, 0, 1e12));
  const ms = (r.missions ?? {}) as Record<string, unknown>;
  p.missions.day = str(ms.day, '');
  if (Array.isArray(ms.list)) {
    for (const m of ms.list.slice(0, 3)) {
      if (!m || typeof m !== 'object') continue;
      const mm = m as Record<string, unknown>;
      if (typeof mm.id !== 'string' || !MISSION_IDS.has(mm.id)) continue;
      p.missions.list.push({
        id: mm.id,
        target: Math.max(1, Math.floor(num(mm.target, 1, 1, 1e9))),
        progress: Math.floor(num(mm.progress, 0, 0, 1e12)),
        claimed: mm.claimed === true,
      });
    }
  }
  if (Array.isArray(r.leaderboard)) {
    for (const e of r.leaderboard.slice(0, ECONOMY.LEADERBOARD_SIZE)) {
      if (!e || typeof e !== 'object') continue;
      const ee = e as Record<string, unknown>;
      p.leaderboard.push({
        score: num(ee.score, 0, 0, 1e12),
        distance: num(ee.distance, 0, 0, 1e9),
        ship: SHIP_IDS.has(ee.ship as string) ? (ee.ship as string) : SHIPS[0]!.id,
        date: str(ee.date, ''),
      });
    }
    p.leaderboard.sort((a, b) => b.score - a.score);
  }
  const dir = (r.director ?? {}) as Record<string, unknown>;
  p.director = { skill: num(dir.skill, 0, -1, 1), runs: Math.floor(num(dir.runs, 0, 0, 1e9)) };
  return p;
}

/** Migrations from version N to N+1 operating on raw JSON (before sanitising). */
export const MIGRATIONS: Readonly<Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>> =
  {
    // v1 (first public schema): currency was called `coins`, the ship was a single `ship` field, and there were
    // no cosmetics or director state.
    1: (raw) => {
      const { coins, ship, ships, ...rest } = raw;
      return {
        ...rest,
        shards: coins,
        selectedShip: ship,
        ownedShips: Array.isArray(ships) ? ships : [ship],
      };
    },
  };

/** Applies migrations from `fromVersion` up to PROFILE_VERSION. */
export function migrate(raw: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  let v = fromVersion;
  let r = raw;
  while (v < PROFILE_VERSION) {
    const m = MIGRATIONS[v];
    if (m) r = m(r);
    v++;
  }
  return r;
}
