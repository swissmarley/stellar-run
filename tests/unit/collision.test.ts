import { describe, expect, it } from 'vitest';
import { placeObstacle, setDronePath } from '../../src/core/gen/place.ts';
import { ChunkData } from '../../src/core/sim/chunk.ts';
import {
  CLEARANCE,
  pointClearance as pc,
  SWEEP,
  sweptClearance as sc,
} from '../../src/core/sim/collision.ts';

function pointClearance(
  c: ChunkData,
  i: number,
  x: number,
  y: number,
  s: number,
  r: number,
  h: number,
): number {
  SWEEP.set([x, y, s, x, y, s, r, h]);
  pc(c, i);
  return CLEARANCE[0]!;
}

function sweptClearance(
  c: ChunkData,
  i: number,
  x0: number,
  y0: number,
  s0: number,
  x1: number,
  y1: number,
  s1: number,
  r: number,
  h: number,
): number {
  SWEEP.set([x0, y0, s0, x1, y1, s1, r, h]);
  sc(c, i);
  return CLEARANCE[0]!;
}

import { obstaclePos, posOut } from '../../src/core/sim/hazards.ts';
import { obstacleIndex } from '../../src/data/registry.ts';

function chunk(): ChunkData {
  const c = new ChunkData();
  c.reset(1, 0);
  return c;
}

describe('collision', () => {
  it('sphere clearance accounts for the capsule half-length along s', () => {
    const c = chunk();
    const i = placeObstacle(c, obstacleIndex('rock_m'), 0, 0, 10, 1, 0); // R = 1.15
    // Ship 5 m behind the rock centre, h = 0.6, r = 0.4 → gap along s = 5 − 0.6 = 4.4 → clearance 4.4 − 1.15 − 0.4.
    expect(pointClearance(c, i, 0, 0, 5, 0.4, 0.6)).toBeCloseTo(4.4 - 1.55, 9);
    // Directly beside it: lateral 3 m.
    expect(pointClearance(c, i, 3, 0, 10, 0.4, 0.6)).toBeCloseTo(3 - 1.55, 9);
  });

  it('box clearance is exact for axis-aligned offsets', () => {
    const c = chunk();
    const i = placeObstacle(c, obstacleIndex('crate'), 0, 0, 10, 1, 0); // half 0.5
    expect(pointClearance(c, i, 2, 0, 10, 0.4, 0.6)).toBeCloseTo(2 - 0.5 - 0.4, 9);
    expect(pointClearance(c, i, 0, 0, 10, 0.4, 0.6)).toBeCloseTo(-0.4, 9);
  });

  it('swept test catches a thin beam passed in a single huge step (no tunnelling)', () => {
    const c = chunk();
    const i = placeObstacle(c, obstacleIndex('ion_beam'), 0, 0, 50, 1, 0); // hs = 0.2
    // One tick moving 30 m straight through the beam.
    expect(sweptClearance(c, i, 0, 0, 35, 0, 0, 65, 0.4, 0.6)).toBeLessThan(0);
    // Same move 1.5 m above the beam clears it (beam half-height 0.2 + r 0.4).
    expect(sweptClearance(c, i, 0, 1.5, 35, 0, 1.5, 65, 0.4, 0.6)).toBeCloseTo(1.5 - 0.2 - 0.4, 6);
  });

  it('swept minimum equals the analytic closest approach for a lateral pass', () => {
    const c = chunk();
    const i = placeObstacle(c, obstacleIndex('rock_s'), 0, 0, 10, 1, 0); // R = 0.65
    // Moves from s=9 to s=11 at x=1 (passes beside the rock): min clearance = 1 − 0.65 − 0.4.
    expect(sweptClearance(c, i, 1, 0, 9, 1, 0, 11, 0.4, 0.6)).toBeCloseTo(1 - 1.05, 6);
  });

  it('drones move as a function of ship distance, deterministically', () => {
    const c = chunk();
    const i = placeObstacle(c, obstacleIndex('drone'), 0, 0, 100, 1, 0);
    setDronePath(c, i, 3, 0, 40, 0, false);
    obstaclePos(c, i, 110); // quarter period → x = +3
    expect(posOut.x).toBeCloseTo(3, 9);
    obstaclePos(c, i, 130); // three quarters → x = −3
    expect(posOut.x).toBeCloseTo(-3, 9);
  });
});
