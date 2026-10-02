/**
 * Consent gate (GDPR-ready). The shipped game collects nothing, so every purpose is permanently "denied" and
 * the first-launch notice simply says so. Any future telemetry, online leaderboard or ad provider must check
 * `allowed(purpose)` first, and the settings screen exposes the choices.
 */
export type ConsentPurpose = 'analytics' | 'onlineLeaderboard' | 'ads';

export class ConsentService {
  private readonly granted = new Set<ConsentPurpose>();

  allowed(purpose: ConsentPurpose): boolean {
    return this.granted.has(purpose) && this.available(purpose);
  }

  /** Purposes this build can actually perform. None: no network code exists. */
  available(_purpose: ConsentPurpose): boolean {
    return false;
  }

  set(purpose: ConsentPurpose, on: boolean): void {
    if (on && this.available(purpose)) this.granted.add(purpose);
    else this.granted.delete(purpose);
  }
}
