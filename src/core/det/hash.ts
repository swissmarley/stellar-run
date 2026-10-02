/**
 * Deterministic 32-bit hashing. Pure integer math (Math.imul + unsigned shifts), identical on every JS engine.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Folds one 32-bit word (as 4 little-endian bytes) into an FNV-1a state. */
export function fnvWord(h: number, w: number): number {
  h = Math.imul(h ^ (w & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((w >>> 8) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((w >>> 16) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((w >>> 24) & 0xff), FNV_PRIME);
  return h >>> 0;
}

/** Murmur3 finaliser: avalanches the bits of a 32-bit value. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of up to three 32-bit words, e.g. (runSeed, chunkIndex, stream). */
export function hash32(a: number, b = 0, c = 0): number {
  let h = FNV_OFFSET;
  h = fnvWord(h, a >>> 0);
  h = fnvWord(h, b >>> 0);
  h = fnvWord(h, c >>> 0);
  return fmix32(h);
}

/** FNV-1a over a string's UTF-16 code units (used for date seeds and save checksums of ids). */
export function hashString(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ (s.charCodeAt(i) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ (s.charCodeAt(i) >>> 8), FNV_PRIME);
  }
  return fmix32(h >>> 0);
}

/** Incremental hasher for float64 state snapshots (replay/determinism checks). Allocation-free after construction. */
export class StateHasher {
  private readonly f64 = new Float64Array(1);
  private readonly u32 = new Uint32Array(this.f64.buffer);
  private h = FNV_OFFSET;

  reset(): void {
    this.h = FNV_OFFSET;
  }

  addInt(v: number): void {
    this.h = fnvWord(this.h, v | 0);
  }

  addFloat(v: number): void {
    this.f64[0] = v;
    this.h = fnvWord(this.h, this.u32[0]!);
    this.h = fnvWord(this.h, this.u32[1]!);
  }

  digest(): number {
    return fmix32(this.h);
  }
}
