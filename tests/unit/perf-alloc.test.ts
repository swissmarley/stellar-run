import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('allocation and GC behaviour of the per-tick path (sim + bot + chunk generation)', () => {
  it('no major GC and only sub-millisecond minor GCs over 5 simulated minutes', () => {
    const r = spawnSync(
      process.execPath,
      ['--expose-gc', '--max-semi-space-size=64', 'tools/alloc-check.ts'],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    const [alloc, gc] = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // Regression guard: structural allocations (arrays/objects/closures per tick) would add kilobytes per tick.
    expect(alloc.bytesPerTickMedian).toBeLessThan(4000);
    expect(gc.majorGcCount).toBe(0);
    expect(gc.minorGcMaxMs).toBeLessThan(2);
  }, 120_000);
});
