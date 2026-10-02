import { TUNING } from '../../data/tuning.ts';
import type { PostOptions } from './post.ts';

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityProfile {
  readonly tier: QualityTier;
  readonly pixelRatioCap: number;
  readonly post: PostOptions;
  readonly dust: number;
  readonly skyDetail: boolean;
}

export const QUALITY: Readonly<Record<QualityTier, QualityProfile>> = {
  low: {
    tier: 'low',
    pixelRatioCap: 1.25,
    post: { bloom: false, grade: false, msaa: 0 },
    dust: 90,
    skyDetail: false,
  },
  medium: {
    tier: 'medium',
    pixelRatioCap: 1.6,
    post: { bloom: false, grade: true, msaa: 0 },
    dust: 160,
    skyDetail: true,
  },
  high: {
    tier: 'high',
    pixelRatioCap: 2,
    post: { bloom: true, grade: true, msaa: 4 },
    dust: 260,
    skyDetail: true,
  },
};

/** Initial guess from coarse device signals; the auto-tuner refines it from real frame times. */
export function detectTier(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency || 4;
  const mem = nav.deviceMemory ?? 4;
  const touch = matchMedia('(pointer: coarse)').matches;
  if (cores <= 4 || mem <= 2) return 'low';
  if (touch) return 'medium';
  return 'high';
}

/**
 * Watches frame times and steps quality down when the 95th percentile stays above the budget for a whole
 * window (never up automatically, to avoid oscillation). Allocation-free.
 */
export class AutoQuality {
  private readonly samples = new Float64Array(512);
  private readonly sorted = new Float64Array(512);
  private n = 0;
  private windowT = 0;
  enabled = true;
  lastP95 = 0;

  /** Returns true when a downgrade is recommended. */
  push(frameMs: number): boolean {
    if (!this.enabled) return false;
    this.samples[this.n % this.samples.length] = frameMs;
    this.n++;
    this.windowT += frameMs / 1000;
    if (this.windowT < TUNING.QUALITY_SAMPLE_SECONDS) return false;
    const count = Math.min(this.n, this.samples.length);
    this.sorted.set(this.samples.subarray(0, count));
    const view = this.sorted.subarray(0, count);
    view.sort();
    this.lastP95 = view[Math.floor(count * 0.95)]!;
    this.windowT = 0;
    this.n = 0;
    return this.lastP95 > TUNING.QUALITY_DOWNGRADE_P95_MS;
  }

  reset(): void {
    this.n = 0;
    this.windowT = 0;
  }
}

export function lowerTier(t: QualityTier): QualityTier {
  return t === 'high' ? 'medium' : 'low';
}
