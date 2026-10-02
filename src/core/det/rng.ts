/**
 * xoshiro128** PRNG (Blackman & Vigna, public domain algorithm), seeded with splitmix32.
 * 32-bit integer arithmetic only, so sequences are bit-identical across browsers and Node.
 * Never use Math.random() in src/core.
 */

const INV_2_32 = 1 / 4294967296;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private sm = 0;

  constructor(seed = 1) {
    this.seed(seed);
  }

  /** Re-seeds in place (no allocation). */
  seed(seed: number): void {
    this.sm = seed >>> 0;
    this.s0 = this.splitmix();
    this.s1 = this.splitmix();
    this.s2 = this.splitmix();
    this.s3 = this.splitmix();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  private splitmix(): number {
    this.sm = (this.sm + 0x9e3779b9) >>> 0;
    let z = this.sm;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  }

  /** Next unsigned 32-bit integer. */
  nextU32(): number {
    const s0 = this.s0;
    const s1 = this.s1;
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    let s2 = (this.s2 ^ s0) >>> 0;
    let s3 = (this.s3 ^ s1) >>> 0;
    this.s1 = (s1 ^ s2) >>> 0;
    this.s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    this.s2 = s2;
    this.s3 = s3;
    return result;
  }

  /** Uniform float in [0, 1). Exact (32-bit mantissa) in float64. */
  float(): number {
    return this.nextU32() * INV_2_32;
  }

  /** Uniform float in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.float();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** Uniform integer in [a, b] (inclusive). */
  intRange(a: number, b: number): number {
    return a + Math.floor(this.float() * (b - a + 1));
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  /** +1 or -1. */
  sign(): number {
    return this.float() < 0.5 ? -1 : 1;
  }

  /** Index chosen proportionally to non-negative weights[0..count). Returns -1 if all weights are zero. */
  weighted(weights: ArrayLike<number>, count: number): number {
    let total = 0;
    for (let i = 0; i < count; i++) total += weights[i]!;
    if (total <= 0) return -1;
    let r = this.float() * total;
    for (let i = 0; i < count; i++) {
      r -= weights[i]!;
      if (r < 0) return i;
    }
    return count - 1;
  }
}
