/**
 * Deterministic math for src/core. Uses only IEEE-754 correctly rounded operations (+ - * / sqrt floor),
 * so results are bit-identical across engines. Math.sin/cos/pow/exp/log are implementation-approximated
 * in ECMAScript and are banned in core (see tests/unit/architecture.test.ts).
 */

export const PI = Math.PI;
export const TWO_PI = 2 * Math.PI;
export const HALF_PI = Math.PI / 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function smoothstep(e0: number, e1: number, v: number): number {
  const t = clamp01(invLerp(e0, e1, v));
  return t * t * (3 - 2 * t);
}

export function fract(v: number): number {
  return v - Math.floor(v);
}

/** Moves `v` toward `target` by at most `step`. */
export function approach(v: number, target: number, step: number): number {
  if (v < target) return v + step < target ? v + step : target;
  return v - step > target ? v - step : target;
}

/** Deterministic sine: range reduction + odd Taylor polynomial to x^15 (abs error < 1e-11 on [-π/2, π/2]). */
export function dsin(x: number): number {
  const k = Math.floor(x / TWO_PI + 0.5);
  let r = x - k * TWO_PI;
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const r2 = r * r;
  let p = -1 / 1307674368000;
  p = p * r2 + 1 / 6227020800;
  p = p * r2 - 1 / 39916800;
  p = p * r2 + 1 / 362880;
  p = p * r2 - 1 / 5040;
  p = p * r2 + 1 / 120;
  p = p * r2 - 1 / 6;
  p = p * r2 + 1;
  return r * p;
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

/** Piecewise-linear interpolation through (xs[i], ys[i]) points (xs ascending), clamped at the ends. */
export function piecewise(xs: readonly number[], ys: readonly number[], v: number): number {
  const n = xs.length;
  if (v <= xs[0]!) return ys[0]!;
  if (v >= xs[n - 1]!) return ys[n - 1]!;
  for (let i = 1; i < n; i++) {
    const x1 = xs[i]!;
    if (v <= x1) {
      const x0 = xs[i - 1]!;
      return lerp(ys[i - 1]!, ys[i]!, (v - x0) / (x1 - x0));
    }
  }
  return ys[n - 1]!;
}

/** True if v is a finite number (guards against NaN/Infinity leaking into the sim). */
export function isFiniteNumber(v: number): boolean {
  return Number.isFinite(v);
}
