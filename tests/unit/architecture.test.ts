import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Strips comments and string literals so documentation can mention banned APIs. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

const BANNED: [RegExp, string][] = [
  [/from\s+""/, 'string-literal import (checked separately)'],
  [/Math\.random\b/, 'Math.random (use Rng)'],
  [
    /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b/,
    'implementation-approximated Math function (use DetMath)',
  ],
  [/\*\*/, 'exponent operator (implementation-approximated pow)'],
  [/\bDate\b/, 'Date (wall clock)'],
  [/\bperformance\b/, 'performance (wall clock)'],
  [/\b(window|document|navigator|localStorage)\b/, 'DOM access'],
  [/\bsetTimeout|setInterval|requestAnimationFrame\b/, 'timers'],
];

describe('architecture: src/core is pure and deterministic', () => {
  const coreFiles = files('src/core');

  it('has core files to check', () => {
    expect(coreFiles.length).toBeGreaterThan(10);
  });

  for (const f of coreFiles) {
    it(`${f} uses no banned APIs`, () => {
      const raw = readFileSync(f, 'utf8');
      const imports = [...raw.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const imp of imports) {
        expect(imp === 'three' || imp.startsWith('three/'), `${f} imports three`).toBe(false);
        expect(
          imp.includes('/game/') || imp.includes('/ui/') || imp.includes('/services/'),
          `${f} imports presentation (${imp})`,
        ).toBe(false);
      }
      const src = code(raw);
      for (const [re, why] of BANNED.slice(1)) {
        const m = src.match(re);
        expect(m, `${f}: ${why} → "${m?.[0]}"`).toBeNull();
      }
    });
  }
});
