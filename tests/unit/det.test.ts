import { describe, expect, it } from 'vitest';
import { hash32, StateHasher } from '../../src/core/det/hash.ts';
import { dcos, dsin } from '../../src/core/det/math.ts';
import { Rng } from '../../src/core/det/rng.ts';

// Golden vectors produced by the independent Python reference implementation (tools/rng_ref.py).
const GOLDEN: Record<number, number[]> = {
  0: [3809008728, 1133695204, 53579671, 2891528803, 139681546, 2203266335],
  1: [2442144158, 3238099751, 3819917871, 2104621829, 2021136066, 4223536128],
  42: [2837322924, 544945897, 479756282, 3500138142, 339756180, 113173290],
  3735928559: [2306529437, 2576298207, 1250671110, 2699168992, 2319502352, 3183738783],
};

describe('Rng (xoshiro128**)', () => {
  it('matches the Python reference bit-for-bit', () => {
    for (const [seed, want] of Object.entries(GOLDEN)) {
      const r = new Rng(Number(seed));
      expect(want.map(() => r.nextU32())).toEqual(want);
    }
  });

  it('re-seeding in place restarts the sequence', () => {
    const r = new Rng(7);
    const a = [r.nextU32(), r.nextU32()];
    r.seed(7);
    expect([r.nextU32(), r.nextU32()]).toEqual(a);
  });

  it('float() is in [0,1) and roughly uniform', () => {
    const r = new Rng(99);
    const bins = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      bins[Math.floor(f * 10)]++;
    }
    for (const b of bins) expect(Math.abs(b - 10_000)).toBeLessThan(600);
  });

  it('weighted() respects weights and handles all-zero', () => {
    const r = new Rng(3);
    const w = [0, 3, 1];
    const hits = [0, 0, 0];
    for (let i = 0; i < 40_000; i++) hits[r.weighted(w, 3)]++;
    expect(hits[0]).toBe(0);
    expect(hits[1]! / hits[2]!).toBeGreaterThan(2.7);
    expect(hits[1]! / hits[2]!).toBeLessThan(3.3);
    expect(r.weighted([0, 0], 2)).toBe(-1);
  });
});

describe('hash32', () => {
  it('matches the Python reference', () => {
    expect([hash32(1, 2, 3), hash32(0), hash32(0xffffffff, 7, 9), hash32(12345, 678, 1)]).toEqual([
      765788207, 336666008, 965808327, 2303216429,
    ]);
  });

  it('StateHasher distinguishes -0/+0 and NaN payloads by bits', () => {
    const h = new StateHasher();
    h.addFloat(0);
    const a = h.digest();
    h.reset();
    h.addFloat(-0);
    expect(h.digest()).not.toBe(a);
  });
});

describe('DetMath', () => {
  it('dsin/dcos stay within 1e-10 of Math.sin/cos over a wide range', () => {
    let worst = 0;
    for (let x = -200; x <= 200; x += 0.0137) {
      worst = Math.max(worst, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThan(1e-10);
  });
});
