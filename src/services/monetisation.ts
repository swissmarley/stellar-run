/**
 * Monetisation hooks: interfaces only. STELLAR RUN ships with no ads and no real-money purchases. The game
 * calls these interfaces, and the shipped no-op implementations report "unavailable", so the UI hides those
 * paths. A fork could plug a provider in here (behind the consent service) without touching game code.
 */

export type RewardedResult = 'completed' | 'skipped' | 'unavailable';

export interface AdService {
  /** Whether a rewarded ad could be shown right now. */
  rewardedAvailable(): boolean;
  showRewarded(placement: 'revive'): Promise<RewardedResult>;
}

export interface IapProduct {
  id: string;
  title: string;
  price: string;
}

export type PurchaseOutcome = 'purchased' | 'cancelled' | 'failed' | 'unavailable';

export interface IapService {
  products(): Promise<readonly IapProduct[]>;
  purchase(id: string): Promise<PurchaseOutcome>;
  restore(): Promise<readonly string[]>;
}

export class NoAds implements AdService {
  rewardedAvailable(): boolean {
    return false;
  }

  async showRewarded(): Promise<RewardedResult> {
    return 'unavailable';
  }
}

export class NoIap implements IapService {
  async products(): Promise<readonly IapProduct[]> {
    return [];
  }

  async purchase(): Promise<PurchaseOutcome> {
    return 'unavailable';
  }

  async restore(): Promise<readonly string[]> {
    return [];
  }
}
