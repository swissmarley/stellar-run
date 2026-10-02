import type { LeaderEntry, Profile } from '../core/meta/profile.ts';
import { ECONOMY } from '../data/economy.ts';
import { SHIPS } from '../data/ships.ts';

/**
 * Leaderboard abstraction. The shipped build has a local board (persisted in the profile) and a clearly
 * labelled offline MOCK of an online board. No network code exists; a real backend would implement this
 * interface behind the consent gate.
 */
export interface LeaderboardService {
  readonly id: 'local' | 'online';
  readonly label: string;
  submit(entry: LeaderEntry): Promise<void>;
  top(n: number): Promise<readonly LeaderEntry[]>;
}

export class LocalLeaderboard implements LeaderboardService {
  readonly id = 'local';
  readonly label = 'This device';
  private readonly profile: () => Profile;

  constructor(profile: () => Profile) {
    this.profile = profile;
  }

  async submit(entry: LeaderEntry): Promise<void> {
    const list = this.profile().leaderboard;
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    list.length = Math.min(list.length, ECONOMY.LEADERBOARD_SIZE);
  }

  async top(n: number): Promise<readonly LeaderEntry[]> {
    return this.profile().leaderboard.slice(0, n);
  }
}

const PILOTS = [
  'Vega',
  'Orion',
  'Lyra',
  'Cassio',
  'Nadir',
  'Altair',
  'Mira',
  'Sol',
  'Rigel',
  'Juno',
  'Deneb',
  'Kepler',
];

/** In-memory stand-in for an online board: deterministic fake pilots plus your submissions. Offline only. */
export class MockOnlineLeaderboard implements LeaderboardService {
  readonly id = 'online';
  readonly label = 'Global (offline demo)';
  private readonly entries: LeaderEntry[] = [];

  constructor() {
    for (let i = 0; i < PILOTS.length; i++) {
      const score = Math.round(42000 / (1 + i * 0.45));
      this.entries.push({
        score,
        distance: Math.round(score / 3.1),
        ship: SHIPS[i % SHIPS.length]!.id,
        date: PILOTS[i]!,
      });
    }
  }

  async submit(entry: LeaderEntry): Promise<void> {
    this.entries.push({ ...entry, date: 'You' });
    this.entries.sort((a, b) => b.score - a.score);
    this.entries.length = Math.min(this.entries.length, 50);
  }

  async top(n: number): Promise<readonly LeaderEntry[]> {
    return this.entries.slice(0, n);
  }
}
