import { HAPTICS, type HapticEvent } from '../data/haptics.ts';

export type HapticLevel = 'off' | 'low' | 'full';

/**
 * Haptics via the Vibration API (Android Chrome/Firefox). iOS Safari exposes no web vibration API, so this
 * is a silent no-op there. Patterns are rate-limited per event and scaled down at the "low" level.
 */
export class HapticsService {
  level: HapticLevel = 'full';
  private readonly last: Record<string, number> = {};
  private readonly supported: boolean;
  private readonly scaled: Record<string, number[]> = {};

  constructor() {
    this.supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    for (const [k, v] of Object.entries(HAPTICS))
      this.scaled[k] = v.pattern.map((ms, i) => (i % 2 === 0 ? Math.max(4, Math.round(ms * 0.5)) : ms));
  }

  get available(): boolean {
    return this.supported;
  }

  pulse(e: HapticEvent, now: number): void {
    if (this.level === 'off' || !this.supported) return;
    const def = HAPTICS[e];
    const prev = this.last[e] ?? -1e9;
    if (now - prev < def.cooldown) return;
    this.last[e] = now;
    try {
      navigator.vibrate(this.level === 'low' ? this.scaled[e]! : (def.pattern as number[]));
    } catch {
      /* some browsers throw without a user gesture; haptics are best-effort */
    }
  }
}
