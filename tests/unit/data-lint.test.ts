import { describe, expect, it } from 'vitest';
import { certifiedSpeed, cruiseFor, PROFILE } from '../../src/core/gen/validation-profile.ts';
import { wellDriftBound } from '../../src/core/sim/hazards.ts';
import { BIOMES } from '../../src/data/biomes.ts';
import { OBSTACLES } from '../../src/data/obstacles.ts';
import { PATTERNS } from '../../src/data/patterns.ts';
import { OBSTACLE_INDEX, PATTERN_INDEX } from '../../src/data/registry.ts';
import { SHIPS } from '../../src/data/ships.ts';
import { TUNING } from '../../src/data/tuning.ts';
import { UPGRADES } from '../../src/data/upgrades.ts';

const VCERT_MAX = certifiedSpeed(cruiseFor(1), cruiseFor(1));

describe('data lint', () => {
  it('lattice fits one int32 row with odd dimensions', () => {
    expect(TUNING.GRID_COLS).toBeLessThanOrEqual(31);
    expect(TUNING.GRID_COLS % 2).toBe(1);
    expect(TUNING.GRID_ROWS % 2).toBe(1);
  });

  it('gravity wells never take more than GRAVITY_AUTHORITY_MAX of the slowest lateral speed (ship can always hold position)', () => {
    for (const o of OBSTACLES) {
      if (!o.well) continue;
      const drift = wellDriftBound(o.well.strength, o.well.softening) * VCERT_MAX;
      expect(drift, o.id).toBeLessThanOrEqual(TUNING.GRAVITY_AUTHORITY_MAX * PROFILE.vLatMin);
      expect(o.well.range + PROFILE.hMax + 1, `${o.id} range fits a chunk`).toBeLessThan(
        TUNING.CHUNK_LENGTH / 2,
      );
    }
  });

  it('patterns reference known obstacles, fit in a chunk and have sane drone paths', () => {
    for (const p of PATTERNS) {
      expect(p.length, p.id).toBeLessThan(TUNING.CHUNK_LENGTH - 2 * TUNING.CHUNK_EDGE_CLEARANCE);
      expect(p.minD).toBeLessThanOrEqual(p.maxD);
      for (const e of p.elements) {
        expect(OBSTACLE_INDEX[e.obstacle], `${p.id}: ${e.obstacle}`).toBeDefined();
        if (e.type === 'gate') expect(OBSTACLE_INDEX[e.obstacleV]).toBeDefined();
        if (e.type === 'drone') {
          // Peak lateral drone speed at the certified speed stays readable: ≤ 3× the slowest ship's lateral speed.
          const lip = (2 * Math.PI * e.amplitude[1]) / e.period[0];
          expect(lip * VCERT_MAX, p.id).toBeLessThanOrEqual(3 * PROFILE.vLatMin);
        }
      }
    }
  });

  it('every biome has a trivially passable fallback and content across the whole difficulty range', () => {
    for (const b of BIOMES) {
      const fb = PATTERNS[PATTERN_INDEX[b.fallbackPattern]!]!;
      expect(fb, b.id).toBeDefined();
      expect(fb.elements.length).toBe(0);
      for (const d of [0, 0.25, 0.5, 0.75, 1]) {
        const any = PATTERNS.some(
          (p) => p.biomes.includes(b.id) && d >= p.minD && d <= p.maxD && p.elements.length > 0,
        );
        expect(any, `${b.id} @ d=${d}`).toBe(true);
      }
    }
  });

  it('four ships with distinct abilities; upgrades never raise forward speed', () => {
    expect(SHIPS.length).toBe(4);
    expect(new Set(SHIPS.map((s) => s.ability)).size).toBe(4);
    for (const u of UPGRADES) {
      expect([
        'boostDuration',
        'energyRegen',
        'lateralSpeed',
        'focusCapacity',
        'magnetRadius',
        'comboWindow',
        'abilityCharge',
        'reviveDiscount',
        'shardValue',
      ]).toContain(u.stat);
      for (const r of u.requires) expect(UPGRADES.some((x) => x.id === r)).toBe(true);
      expect(u.perLevel).toBeGreaterThan(0);
    }
  });
});
