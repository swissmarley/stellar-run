import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/det/rng.ts';
import { Director } from '../../src/core/director/director.ts';
import { DIFFICULTY } from '../../src/data/difficulty.ts';

describe('difficulty director', () => {
  it('stays within [minD, maxD] and never jumps more than maxStep per chunk under adversarial feedback', () => {
    const r = new Rng(31337);
    const weird = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1e9, 1e9, 0, -0];
    for (let trial = 0; trial < 200; trial++) {
      const d = new Director();
      d.restore({ skill: r.range(-3, 3), runs: r.int(50) });
      for (let run = 0; run < 20; run++) {
        d.beginRun();
        let prev = -1;
        let s = 0;
        const chunks = r.int(80);
        for (let k = 0; k < chunks; k++) {
          const v = d.difficultyFor(r.chance(0.02) ? weird[r.int(weird.length)]! : s);
          expect(v).toBeGreaterThanOrEqual(DIFFICULTY.minD);
          expect(v).toBeLessThanOrEqual(DIFFICULTY.maxD);
          if (prev >= 0) expect(Math.abs(v - prev)).toBeLessThanOrEqual(DIFFICULTY.maxStep + 1e-12);
          prev = v;
          d.onChunkCleared(
            r.chance(0.02) ? weird[r.int(weird.length)]! : 200,
            r.chance(0.02) ? weird[r.int(weird.length)]! : r.int(12),
          );
          s += 200;
        }
        d.onRunEnd(r.chance(0.05) ? weird[r.int(weird.length)]! : s);
        expect(d.skill).toBeGreaterThanOrEqual(-1);
        expect(d.skill).toBeLessThanOrEqual(1);
        expect(Number.isFinite(d.inRun)).toBe(true);
      }
    }
  });

  it('adapts: repeated early deaths lower difficulty, long runs raise it', () => {
    const weak = new Director();
    const strong = new Director();
    for (let i = 0; i < 10; i++) {
      weak.onRunEnd(200);
      strong.onRunEnd(9000);
    }
    weak.beginRun();
    strong.beginRun();
    expect(weak.skill).toBeLessThan(-0.5);
    expect(strong.skill).toBeGreaterThan(0.5);
    expect(weak.difficultyFor(2000)).toBeLessThan(strong.difficultyFor(2000));
  });

  it('near-miss rate shifts in-run difficulty within its cap', () => {
    const d = new Director();
    d.beginRun();
    for (let i = 0; i < 100; i++) d.onChunkCleared(200, 20);
    expect(d.inRun).toBeCloseTo(DIFFICULTY.inRunOffsetMax, 9);
    for (let i = 0; i < 100; i++) d.onChunkCleared(200, 0);
    expect(d.inRun).toBeCloseTo(-DIFFICULTY.inRunOffsetMax, 9);
  });
});
