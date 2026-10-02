/** Economy constants (all in shards, the only currency; it is earned by playing and never sold). */
export const ECONOMY = Object.freeze({
  /** Bonus shards per 100 m travelled in a run. */
  SHARDS_PER_100M: 1,
  /** Base price of a revive (once per run); upgrades can discount it. */
  REVIVE_BASE_COST: 150,
  /** Revive price grows with distance so late revives cost more (per km). */
  REVIVE_COST_PER_KM: 15,
  /** Entries kept on the local leaderboard. */
  LEADERBOARD_SIZE: 10,
  /** Starting balance for a new pilot. */
  STARTING_SHARDS: 0,
});
