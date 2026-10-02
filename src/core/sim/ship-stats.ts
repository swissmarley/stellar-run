import { SHIPS } from '../../data/ships.ts';
import { TUNING } from '../../data/tuning.ts';
import type { AbilityId, ShipDef, UpgradeStat } from '../../data/types.ts';
import { UPGRADES } from '../../data/upgrades.ts';

export const ABILITY_PHASE = 0;
export const ABILITY_OVERDRIVE = 1;
export const ABILITY_PULSE = 2;
export const ABILITY_MAGNET = 3;

export function abilityIndex(a: AbilityId): number {
  return a === 'phase'
    ? ABILITY_PHASE
    : a === 'overdrive'
      ? ABILITY_OVERDRIVE
      : a === 'pulse'
        ? ABILITY_PULSE
        : ABILITY_MAGNET;
}

/** Effective ship parameters for one run: the ShipDef plus upgrade bonuses. Never mutates definitions. */
export class ShipStats {
  shipIndex = 0;
  lateralSpeed = 0;
  speedFactor = 1;
  hitRadius = 0.4;
  hitHalfLength = 0.6;
  ability = ABILITY_PHASE;
  boostDuration: number = TUNING.BOOST_DURATION;
  energyRegen: number = TUNING.ENERGY_REGEN;
  focusDrain: number = TUNING.FOCUS_DRAIN;
  pickupRadius: number = TUNING.SHARD_RADIUS;
  comboWindow: number = TUNING.COMBO_WINDOW;
  abilityChargeMult = 1;
  shardValue = 1;
  reviveDiscount = 0;
}

/** Upgrade levels by upgrade id (missing = 0). */
export type UpgradeLevels = Readonly<Record<string, number>>;

function bonus(levels: UpgradeLevels, stat: UpgradeStat): number {
  let b = 0;
  for (const u of UPGRADES) {
    if (u.stat !== stat) continue;
    const lv = levels[u.id] ?? 0;
    const capped = lv < 0 ? 0 : lv > u.costs.length ? u.costs.length : lv;
    b += capped * u.perLevel;
  }
  return b;
}

export function computeShipStats(shipIndex: number, levels: UpgradeLevels, out: ShipStats): ShipStats {
  const def: ShipDef = SHIPS[shipIndex] ?? SHIPS[0]!;
  out.shipIndex = SHIPS[shipIndex] ? shipIndex : 0;
  out.lateralSpeed = def.lateralSpeed * (1 + bonus(levels, 'lateralSpeed'));
  out.speedFactor = def.speedFactor;
  out.hitRadius = def.hitRadius;
  out.hitHalfLength = def.hitHalfLength;
  out.ability = abilityIndex(def.ability);
  out.boostDuration = TUNING.BOOST_DURATION * (1 + bonus(levels, 'boostDuration'));
  out.energyRegen = TUNING.ENERGY_REGEN * (1 + bonus(levels, 'energyRegen'));
  out.focusDrain = TUNING.FOCUS_DRAIN / (1 + bonus(levels, 'focusCapacity'));
  out.pickupRadius = TUNING.SHARD_RADIUS + bonus(levels, 'magnetRadius');
  out.comboWindow = TUNING.COMBO_WINDOW + bonus(levels, 'comboWindow');
  out.abilityChargeMult = 1 + bonus(levels, 'abilityCharge');
  out.shardValue = 1 + bonus(levels, 'shardValue');
  const disc = bonus(levels, 'reviveDiscount');
  out.reviveDiscount = disc > 0.8 ? 0.8 : disc;
  return out;
}
