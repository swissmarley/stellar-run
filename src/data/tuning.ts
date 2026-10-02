/**
 * Global gameplay constants. Every number that shapes how the game plays lives here or in another
 * src/data module. docs/TUNING.md is generated from this file (`npm run docs:tuning`): keep one
 * `/** doc *\/` comment per key and `// ## Section` headers.
 */
export const TUNING = {
  // ## Simulation
  /** Fixed simulation rate in ticks per second (2 ticks per 60 Hz frame). Higher rates shrink the tick slack in the passability proof. The sim never reads wall-clock time. */
  SIM_HZ: 120,
  /** Longest wall-clock frame accepted by the accumulator, in seconds (avoids the spiral of death after tab switches). */
  MAX_FRAME_DT: 0.1,
  /** Max sim ticks per rendered frame; extra time is dropped (game slows rather than stutters). */
  MAX_TICKS_PER_FRAME: 8,
  /** Quantisation of analog steering in InputFrame (ints in [-Q, Q]); makes replays exact. */
  INPUT_QUANT: 10000,

  // ## Corridor and lattice
  /** Edge length of one passability lattice cell, in metres. */
  CELL: 0.3,
  /** Lattice columns across the corridor (X). Odd, so a cell centre sits at x = 0. Must be ≤ 31 (one int32 row). */
  GRID_COLS: 31,
  /** Lattice rows (Y). Odd, so a cell centre sits at y = 0. */
  GRID_ROWS: 21,

  // ## Chunks
  /** Length of one procedural chunk along the track, in metres. */
  CHUNK_LENGTH: 200,
  /** Chunks generated ahead of the one the ship is in. */
  CHUNKS_AHEAD: 2,
  /** Obstacle influence (radius + ship + margin + half-length, or a gravity well's range) must stay this far inside a chunk's ends. */
  CHUNK_EDGE_CLEARANCE: 5,
  /** Empty warm-up chunks at the start of every run. */
  INTRO_CHUNKS: 1,
  /** Chunks per biome before the next biome begins. */
  BIOME_CHUNKS: 6,
  /** Capacity of one chunk's obstacle store. */
  MAX_OBSTACLES_PER_CHUNK: 120,
  /** Capacity of one chunk's shard store. */
  MAX_SHARDS_PER_CHUNK: 48,
  /** Capacity of slices per chunk (lattice steps along s). */
  MAX_SLICES: 96,

  // ## Forward speed
  /** Cruise speed at difficulty 0, in m/s (before the ship's speed factor). */
  SPEED_MIN: 32,
  /** Cruise speed at difficulty 1, in m/s. */
  SPEED_MAX: 62,
  /** Forward acceleration/deceleration toward the desired speed, in m/s². */
  SPEED_ACCEL: 24,
  /** Speed at spawn as a fraction of cruise speed. */
  START_SPEED_FRACTION: 0.55,

  // ## Boost
  /** Forward speed multiplier while boosting. Validation certifies every chunk at this multiplier. */
  BOOST_MULT: 1.4,
  /** Duration of one boost burst in sim seconds. */
  BOOST_DURATION: 1.1,
  /** Energy consumed by one boost (energy is 0..1). */
  BOOST_COST: 0.34,
  /** Energy regenerated per sim second. */
  ENERGY_REGEN: 0.16,
  /** Energy granted per near-miss. */
  ENERGY_PER_NEAR_MISS: 0.08,
  /** Score multiplier while boosting. */
  BOOST_SCORE_MULT: 1.5,

  // ## Focus (slow-mo)
  /** Wall-clock time scale while focus is active (presentation only; the sim is unchanged). */
  FOCUS_TIME_SCALE: 0.45,
  /** Focus meter drained per sim second while active (meter is 0..1). */
  FOCUS_DRAIN: 0.45,
  /** Focus meter regenerated per sim second while inactive. */
  FOCUS_REGEN: 0.1,
  /** Minimum meter needed to start focusing. */
  FOCUS_MIN_START: 0.2,

  // ## Near-misses, combo and score
  /** A pass with surface clearance below this (metres) counts as a near-miss. */
  NEAR_MISS_CLEARANCE: 0.9,
  /** Clearance below this is a PERFECT near-miss. */
  PERFECT_CLEARANCE: 0.3,
  /** Base points for a near-miss (multiplied by the combo multiplier). */
  NEAR_MISS_POINTS: 50,
  /** Extra multiplier for PERFECT near-misses. */
  PERFECT_MULT: 2,
  /** Sim seconds without a near-miss before the combo resets. */
  COMBO_WINDOW: 4,
  /** Multiplier added per combo step. */
  COMBO_STEP: 0.25,
  /** Maximum combo multiplier. */
  COMBO_MAX_MULT: 5,
  /** Points per metre travelled (times multiplier). */
  SCORE_PER_METER: 1,
  /** Points per shard collected. */
  SHARD_POINTS: 10,
  /** Distance between "milestone" celebrations, in metres. */
  DISTANCE_MILESTONE: 1000,

  // ## Abilities
  /** Ability charge per near-miss (charge is 0..1; full = ready). */
  ABILITY_CHARGE_NEAR_MISS: 0.12,
  /** Ability charge per shard. */
  ABILITY_CHARGE_SHARD: 0.02,
  /** Passive ability charge per sim second. */
  ABILITY_CHARGE_PASSIVE: 0.012,
  /** Phase Shift: intangibility duration in sim seconds. */
  PHASE_DURATION: 1.6,
  /** Phase Shift: max automatic extension while still overlapping an obstacle. */
  PHASE_MAX_EXTENSION: 1,
  /** Pulse: obstacles within this distance ahead are destroyed (metres). */
  PULSE_RANGE: 45,
  /** Pulse: lateral radius of the blast (metres). */
  PULSE_RADIUS: 5.5,
  /** Magnet: duration in sim seconds. */
  MAGNET_DURATION: 6,
  /** Magnet: shard pickup radius while active (metres). */
  MAGNET_RADIUS: 3.6,
  /** Overdrive: free boost duration in sim seconds. */
  OVERDRIVE_DURATION: 3,
  /** Overdrive: score multiplier while active (replaces the boost multiplier). */
  OVERDRIVE_SCORE_MULT: 2,

  // ## Pickups and revive
  /** Normal shard pickup radius (metres, lateral and along s). */
  SHARD_RADIUS: 0.9,
  /** Shards are placed every N lattice slices along a guaranteed-safe path. */
  SHARD_SPACING_SLICES: 2,
  /** Intangibility after a revive, in sim seconds. */
  REVIVE_GHOST: 1.5,

  // ## Passability validation
  /** Extra clearance demanded by the validator at difficulty 0 (metres). */
  MARGIN_EASY: 0.25,
  /** Extra clearance demanded by the validator at difficulty 1 (metres). */
  MARGIN_HARD: 0.08,
  /** Max obstacles the repair step may remove before falling back to the safe pattern. */
  MAX_REPAIR_REMOVALS: 6,
  /** Full regeneration attempts (with fresh random draws) before the safe fallback pattern. */
  MAX_GEN_ATTEMPTS: 4,
  /** Gravity drift may consume at most this fraction of the slowest ship's lateral speed (data lint). */
  GRAVITY_AUTHORITY_MAX: 0.5,

  // ## Game feel (wall-clock, presentation only)
  /** Hit-stop freeze on collision, seconds. */
  HIT_STOP: 0.09,
  /** Time scale of the death sequence. */
  DEATH_SLOWMO: 0.25,
  /** Wall seconds of the death sequence before results/revive appear. */
  DEATH_SEQUENCE: 0.8,
  /** Results screen ignores input for this long, to avoid accidental taps. */
  RESULTS_INPUT_DELAY: 0.25,
  /** How long the revive offer stays up, seconds. */
  REVIVE_OFFER_TIME: 4,

  // ## Camera
  /** Chase distance behind the ship (metres). */
  CAMERA_DISTANCE: 7.2,
  /** Camera height above the ship (metres). */
  CAMERA_HEIGHT: 1.6,
  /** Fraction of the ship's lateral offset the camera follows. */
  CAMERA_FOLLOW: 0.7,
  /** Look-ahead distance of the camera target (metres). */
  CAMERA_LOOK_AHEAD: 30,
  /** Spring stiffness of the camera follow (1/s). */
  CAMERA_SPRING: 8,
  /** Base vertical field of view (degrees) for a 9:19.5 portrait screen. */
  FOV_BASE: 72,
  /** Extra FOV while boosting (degrees). */
  FOV_BOOST_KICK: 10,
  /** Extra FOV at top cruise speed (degrees). */
  FOV_SPEED_KICK: 5,
  /** Maximum horizontal FOV (degrees); taller FOVs are reduced on wide screens/foldables. */
  HFOV_MAX: 70,
  /** Maximum ship bank angle (degrees) at full lateral speed. */
  BANK_MAX_DEG: 34,
  /** Fraction of the ship's bank applied to the camera roll. */
  CAMERA_BANK_FACTOR: 0.3,
  /** Trauma added by a near-miss (0..1). */
  SHAKE_NEAR_MISS: 0.3,
  /** Trauma added by death. */
  SHAKE_DEATH: 1,
  /** Trauma decay per second. */
  SHAKE_DECAY: 1.8,
  /** Positional shake at full trauma (metres). */
  SHAKE_MAX_OFFSET: 0.3,

  // ## Input
  /** Drag steering: metres of ship travel per millimetre of finger travel (times sensitivity). */
  DRAG_METERS_PER_MM: 0.3,
  /** A touch shorter than this (ms) that barely moved is a tap (boost). */
  TAP_MAX_MS: 220,
  /** Max finger travel (mm) for a tap. */
  TAP_MAX_MOVE_MM: 3,
  /** Pressing and holding still this long (ms) at the start of a touch starts focus (latched until release). */
  HOLD_STILL_MS: 300,
  /** Max finger travel (mm) while "holding still". */
  HOLD_STILL_MM: 2,
  /** Tilt dead zone (degrees). */
  TILT_DEADZONE_DEG: 2.5,
  /** Tilt angle (degrees) giving full lateral speed at sensitivity 1. */
  TILT_FULL_DEG: 20,

  // ## Performance
  /** Auto quality downgrade when p95 frame time exceeds this (ms) for QUALITY_SAMPLE_SECONDS. */
  QUALITY_DOWNGRADE_P95_MS: 18,
  /** Window for the auto-quality check, seconds. */
  QUALITY_SAMPLE_SECONDS: 3,
} as const;

export const DT = 1 / TUNING.SIM_HZ;
/** Half extent of the lattice in X (metres). */
export const HALF_W = (TUNING.GRID_COLS * TUNING.CELL) / 2;
/** Half extent of the lattice in Y (metres). */
export const HALF_H = (TUNING.GRID_ROWS * TUNING.CELL) / 2;
/** The ship's centre is clamped to the outermost cell centres. */
export const SHIP_X_LIMIT = HALF_W - TUNING.CELL / 2;
export const SHIP_Y_LIMIT = HALF_H - TUNING.CELL / 2;
