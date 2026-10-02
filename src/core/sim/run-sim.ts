import { DT, SHIP_X_LIMIT, SHIP_Y_LIMIT, TUNING } from '../../data/tuning.ts';
import type { StateHasher } from '../det/hash.ts';
import { approach } from '../det/math.ts';
import { COLS, cellX, cellY, ROWS } from '../gen/grid.ts';
import { nearestCellIn } from '../gen/passability.ts';
import type { ChunkSource } from '../gen/source.ts';
import { ChunkData, KIND_WELL, OF_DESTROYED, OF_PASSED, OF_REMOVED, SHAPE_SPHERE } from './chunk.ts';
import { lateralReach, pointClearance, sweptClearance } from './collision.ts';
import { EV, EventRing } from './events.ts';
import { driftOut, wellDrift } from './hazards.ts';
import { BTN_ABILITY, BTN_BOOST, BTN_FOCUS, BTN_REVIVE, type InputFrame } from './input-frame.ts';
import { ABILITY_MAGNET, ABILITY_OVERDRIVE, ABILITY_PHASE, ABILITY_PULSE, ShipStats } from './ship-stats.ts';

const SLOTS = 4;
const Q = TUNING.INPUT_QUANT;
const NEAR = TUNING.NEAR_MISS_CLEARANCE;

/**
 * The deterministic run simulation. Advances exactly one fixed tick per step() from an InputFrame.
 * No DOM, no wall clock, no Math.random, no allocation after construction.
 */
export class RunSim {
  readonly chunks: ChunkData[] = [];
  readonly events = new EventRing();
  readonly stats = new ShipStats();
  private source: ChunkSource | null = null;

  seed = 0;
  tick = 0;
  /** Index of the chunk containing the ship. */
  chunkIndex = 0;

  s = 0;
  x = 0;
  y = 0;
  prevS = 0;
  prevX = 0;
  prevY = 0;
  speed = 0;
  vx = 0;
  vy = 0;

  alive = true;
  deathObstacle = -1;

  energy = 1;
  boostTime = 0;
  focus = 1;
  focusActive = false;
  abilityCharge = 0;
  overdriveTime = 0;
  phaseTime = 0;
  phaseExtension = 0;
  magnetTime = 0;
  ghostTime = 0;

  combo = 0;
  comboTimer = 0;
  multiplier = 1;
  maxCombo = 0;

  score = 0;
  shards = 0;
  nearMisses = 0;
  perfects = 0;
  boosts = 0;
  abilityUses = 0;
  revives = 0;
  biomeMask = 0;
  chunkNearMisses = 0;
  private nextMilestone: number = TUNING.DISTANCE_MILESTONE;

  constructor() {
    for (let i = 0; i < SLOTS; i++) this.chunks.push(new ChunkData());
  }

  /** Starts a new run. Reuses all buffers; cost is dominated by generating the first chunks. */
  reset(seed: number, source: ChunkSource, stats: ShipStats): void {
    this.seed = seed >>> 0;
    this.source = source;
    const st = this.stats;
    Object.assign(st, stats);
    this.events.clear();
    this.tick = 0;
    this.chunkIndex = 0;
    this.s = 0;
    this.x = 0;
    this.y = 0;
    this.prevS = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.vx = 0;
    this.vy = 0;
    this.alive = true;
    this.deathObstacle = -1;
    this.energy = 1;
    this.boostTime = 0;
    this.focus = 1;
    this.focusActive = false;
    this.abilityCharge = 0;
    this.overdriveTime = 0;
    this.phaseTime = 0;
    this.phaseExtension = 0;
    this.magnetTime = 0;
    this.ghostTime = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.multiplier = 1;
    this.maxCombo = 0;
    this.score = 0;
    this.shards = 0;
    this.nearMisses = 0;
    this.perfects = 0;
    this.boosts = 0;
    this.abilityUses = 0;
    this.revives = 0;
    this.chunkNearMisses = 0;
    this.nextMilestone = TUNING.DISTANCE_MILESTONE;
    for (const c of this.chunks) c.reset(-1, 0);
    source.beginRun(this.seed);
    for (let i = 0; i <= TUNING.CHUNKS_AHEAD; i++) this.generateChunk(i);
    const c0 = this.chunk(0)!;
    this.speed = c0.cruise * st.speedFactor * TUNING.START_SPEED_FRACTION;
    if (this.speed > c0.vCert) this.speed = c0.vCert;
    this.biomeMask = 1 << c0.biome;
    this.events.push(EV.CHUNK_ENTER, 0, c0.biome, c0.difficulty);
  }

  /** Chunk by absolute index if it is resident, else null. */
  chunk(index: number): ChunkData | null {
    if (index < 0) return null;
    const c = this.chunks[index & (SLOTS - 1)]!;
    return c.index === index ? c : null;
  }

  get current(): ChunkData {
    return this.chunks[this.chunkIndex & (SLOTS - 1)]!;
  }

  get boosting(): boolean {
    return this.boostTime > 0 || this.overdriveTime > 0;
  }

  get intangible(): boolean {
    return this.phaseTime > 0 || this.ghostTime > 0;
  }

  private generateChunk(index: number): void {
    const out = this.chunks[index & (SLOTS - 1)]!;
    const prev = this.chunk(index - 1);
    const startS = index * TUNING.CHUNK_LENGTH;
    out.reset(index, startS);
    this.source!.generate(index, startS, prev, out);
  }

  step(inp: InputFrame): void {
    this.tick++;
    this.prevS = this.s;
    this.prevX = this.x;
    this.prevY = this.y;
    if (!this.alive) {
      if ((inp.buttons & BTN_REVIVE) !== 0) this.revive();
      return;
    }
    const st = this.stats;
    const btn = inp.buttons;
    const ev = this.events;

    // Ability charge and activation.
    if (this.abilityCharge < 1) {
      this.abilityCharge += TUNING.ABILITY_CHARGE_PASSIVE * st.abilityChargeMult * DT;
      if (this.abilityCharge >= 1) {
        this.abilityCharge = 1;
        ev.push(EV.ABILITY_READY);
      }
    }
    if ((btn & BTN_ABILITY) !== 0 && this.abilityCharge >= 1) this.activateAbility();

    // Boost.
    if (
      (btn & BTN_BOOST) !== 0 &&
      this.boostTime <= 0 &&
      this.overdriveTime <= 0 &&
      this.energy >= TUNING.BOOST_COST
    ) {
      this.boostTime = st.boostDuration;
      this.energy -= TUNING.BOOST_COST;
      this.boosts++;
      ev.push(EV.BOOST_START);
    }
    if (this.boostTime > 0) {
      this.boostTime -= DT;
      if (this.boostTime <= 0) {
        this.boostTime = 0;
        ev.push(EV.BOOST_END);
      }
    }
    if (this.overdriveTime > 0) {
      this.overdriveTime -= DT;
      if (this.overdriveTime <= 0) {
        this.overdriveTime = 0;
        ev.push(EV.ABILITY_END, ABILITY_OVERDRIVE);
      }
    }
    if (this.magnetTime > 0) {
      this.magnetTime -= DT;
      if (this.magnetTime <= 0) {
        this.magnetTime = 0;
        ev.push(EV.ABILITY_END, ABILITY_MAGNET);
      }
    }
    if (this.ghostTime > 0) {
      this.ghostTime -= DT;
      if (this.ghostTime < 0) this.ghostTime = 0;
    }
    this.energy += st.energyRegen * DT;
    if (this.energy > 1) this.energy = 1;

    // Focus meter (the slow-mo itself is presentation; the sim only tracks the meter).
    const wantFocus = (btn & BTN_FOCUS) !== 0;
    if (wantFocus && (this.focusActive || this.focus >= TUNING.FOCUS_MIN_START)) {
      if (!this.focusActive) {
        this.focusActive = true;
        ev.push(EV.FOCUS_START);
      }
      this.focus -= st.focusDrain * DT;
      if (this.focus <= 0) {
        this.focus = 0;
        this.focusActive = false;
        ev.push(EV.FOCUS_END);
      }
    } else {
      if (this.focusActive) {
        this.focusActive = false;
        ev.push(EV.FOCUS_END);
      }
      this.focus += TUNING.FOCUS_REGEN * DT;
      if (this.focus > 1) this.focus = 1;
    }

    // This tick moves at `this.speed`, which was fixed (and clamped) at the end of the previous tick, so
    // controllers (and the bot's drift feed-forward) know the exact forward step in advance.
    const cur = this.current;

    // Lateral velocity: circle-clamped command plus gravity drift (per metre of travel × speed).
    let cx = inp.steerX / Q;
    let cy = inp.steerY / Q;
    const m2 = cx * cx + cy * cy;
    if (m2 > 1) {
      const inv = 1 / Math.sqrt(m2);
      cx *= inv;
      cy *= inv;
    }
    wellDrift(cur, this.x, this.y, this.s);
    this.vx = cx * st.lateralSpeed + driftOut.x * this.speed;
    this.vy = cy * st.lateralSpeed + driftOut.y * this.speed;

    const x0 = this.x;
    const y0 = this.y;
    const s0 = this.s;
    let x1 = x0 + this.vx * DT;
    let y1 = y0 + this.vy * DT;
    if (x1 > SHIP_X_LIMIT) x1 = SHIP_X_LIMIT;
    else if (x1 < -SHIP_X_LIMIT) x1 = -SHIP_X_LIMIT;
    if (y1 > SHIP_Y_LIMIT) y1 = SHIP_Y_LIMIT;
    else if (y1 < -SHIP_Y_LIMIT) y1 = -SHIP_Y_LIMIT;
    const s1 = s0 + this.speed * DT;

    // Collisions and near-miss tracking.
    const tangible = this.phaseTime <= 0 && this.ghostTime <= 0;
    let hit = -1;
    let hitChunk: ChunkData | null = null;
    for (let k = -1; k <= 1 && hit < 0; k++) {
      const c = this.chunk(this.chunkIndex + k);
      if (!c) continue;
      const res = this.scanChunk(c, x0, y0, s0, x1, y1, s1, tangible);
      if (res >= 0) {
        hit = res;
        hitChunk = c;
      }
    }

    this.x = x1;
    this.y = y1;
    this.s = s1;

    if (hit >= 0 && hitChunk) {
      this.alive = false;
      this.deathObstacle = hitChunk.obsDef[hit]!;
      ev.push(EV.DEATH, x1, y1, s1, this.deathObstacle);
      this.source!.onDeath(s1);
      return;
    }

    // Phase Shift ends only once the ship is clear of every obstacle (bounded extension).
    if (this.phaseTime > 0) {
      this.phaseTime -= DT;
      if (this.phaseTime <= 0) {
        if (this.overlappingAny() && this.phaseExtension < TUNING.PHASE_MAX_EXTENSION) {
          this.phaseTime = DT;
          this.phaseExtension += DT;
        } else {
          this.phaseTime = 0;
          ev.push(EV.ABILITY_END, ABILITY_PHASE);
        }
      }
    }

    this.collectShards(s0, s1);

    // Combo decay and score.
    if (this.combo > 0) {
      this.comboTimer -= DT;
      if (this.comboTimer <= 0) {
        ev.push(EV.COMBO_END, this.combo);
        this.combo = 0;
        this.comboTimer = 0;
        this.multiplier = 1;
      }
    }
    const scoreMult =
      this.overdriveTime > 0 ? TUNING.OVERDRIVE_SCORE_MULT : this.boostTime > 0 ? TUNING.BOOST_SCORE_MULT : 1;
    this.score += (s1 - s0) * TUNING.SCORE_PER_METER * this.multiplier * scoreMult;

    if (s1 >= this.nextMilestone) {
      ev.push(EV.MILESTONE, this.nextMilestone);
      this.nextMilestone += TUNING.DISTANCE_MILESTONE;
    }

    // Chunk transition: generate the next chunk ahead into the slot that just fell out of range.
    if (s1 >= cur.endS) {
      this.source!.onChunkCleared(cur, this.chunkNearMisses);
      this.chunkNearMisses = 0;
      this.chunkIndex++;
      this.generateChunk(this.chunkIndex + TUNING.CHUNKS_AHEAD);
      const nc = this.current;
      ev.push(EV.CHUNK_ENTER, nc.index, nc.biome, nc.difficulty);
      if (nc.biome !== cur.biome) ev.push(EV.BIOME_CHANGE, nc.biome);
      this.biomeMask |= 1 << nc.biome;
    }
    this.updateSpeed();
  }

  /**
   * Forward speed for the NEXT tick: approaches the desired cruise/boost speed, then is clamped to the
   * certified speed of every chunk the next tick can touch. The passability proof relies on this clamp.
   */
  private updateSpeed(): void {
    const cur = this.current;
    const desired = cur.cruise * this.stats.speedFactor * (this.boosting ? TUNING.BOOST_MULT : 1);
    this.speed = approach(this.speed, desired, TUNING.SPEED_ACCEL * DT);
    let cap = cur.vCert;
    if (this.s + this.speed * DT >= cur.endS) {
      const nx = this.chunk(this.chunkIndex + 1);
      if (nx && nx.vCert < cap) cap = nx.vCert;
    }
    if (this.speed > cap) this.speed = cap;
  }

  /** Returns the index of an obstacle hit this tick in chunk c, or -1. Also finalises near-misses. */
  private scanChunk(
    c: ChunkData,
    x0: number,
    y0: number,
    s0: number,
    x1: number,
    y1: number,
    s1: number,
    tangible: boolean,
  ): number {
    const st = this.stats;
    const r = st.hitRadius;
    const h = st.hitHalfLength;
    const xl = x0 < x1 ? x0 : x1;
    const xh = x0 < x1 ? x1 : x0;
    const yl = y0 < y1 ? y0 : y1;
    const yh = y0 < y1 ? y1 : y0;
    for (let i = 0; i < c.obsCount; i++) {
      const f = c.obsFlags[i]!;
      if ((f & (OF_PASSED | OF_REMOVED | OF_DESTROYED)) !== 0) continue;
      const sMin = c.obsSMin(i);
      const sMax = c.obsSMax(i);
      if (sMin - h - r - NEAR > s1) continue;
      if (sMax + h + r + NEAR < s0) {
        this.finalisePass(c, i);
        continue;
      }
      if (!tangible) continue;
      const reach = lateralReach(c, i) + r + NEAR;
      const ox = c.obsX[i]!;
      const oy = c.obsY[i]!;
      if (ox - reach > xh || ox + reach < xl || oy - reach > yh || oy + reach < yl) continue;
      const clear = sweptClearance(c, i, x0, y0, s0, x1, y1, s1, r, h);
      if (clear < c.obsMinClear[i]!) c.obsMinClear[i] = clear;
      if (clear < 0) return i;
    }
    return -1;
  }

  private finalisePass(c: ChunkData, i: number): void {
    c.obsFlags[i]! |= OF_PASSED;
    const clear = c.obsMinClear[i]!;
    if (!(clear >= 0 && clear < NEAR)) return;
    const st = this.stats;
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    this.comboTimer = st.comboWindow;
    const mult = 1 + this.combo * TUNING.COMBO_STEP;
    this.multiplier = mult > TUNING.COMBO_MAX_MULT ? TUNING.COMBO_MAX_MULT : mult;
    const perfect = clear < TUNING.PERFECT_CLEARANCE;
    const pts = TUNING.NEAR_MISS_POINTS * this.multiplier * (perfect ? TUNING.PERFECT_MULT : 1);
    this.score += pts;
    this.nearMisses++;
    this.chunkNearMisses++;
    if (perfect) this.perfects++;
    this.energy += TUNING.ENERGY_PER_NEAR_MISS;
    if (this.energy > 1) this.energy = 1;
    if (this.abilityCharge < 1) {
      this.abilityCharge += TUNING.ABILITY_CHARGE_NEAR_MISS * st.abilityChargeMult;
      if (this.abilityCharge >= 1) {
        this.abilityCharge = 1;
        this.events.push(EV.ABILITY_READY);
      }
    }
    this.events.push(EV.NEAR_MISS, pts, clear, c.obsX[i]!, c.obsY[i]!, c.obsS[i]!, perfect ? 1 : 0);
    this.events.push(EV.COMBO_UP, this.combo, this.multiplier);
  }

  private collectShards(s0: number, s1: number): void {
    const st = this.stats;
    const R = this.magnetTime > 0 ? TUNING.MAGNET_RADIUS : st.pickupRadius;
    const R2 = R * R;
    const sl = s0 - R;
    const sh = s1 + R;
    for (let k = 0; k <= 1; k++) {
      const c = this.chunk(this.chunkIndex + k);
      if (!c) continue;
      for (let i = 0; i < c.shardCount; i++) {
        if (c.shardTaken[i] !== 0) continue;
        const ss = c.shardS[i]!;
        if (ss < sl || ss > sh) continue;
        const dx = c.shardX[i]! - this.x;
        const dy = c.shardY[i]! - this.y;
        if (dx * dx + dy * dy > R2) continue;
        c.shardTaken[i] = 1;
        this.shards++;
        const mult = this.multiplier;
        this.score += TUNING.SHARD_POINTS * mult;
        if (this.abilityCharge < 1) {
          this.abilityCharge += TUNING.ABILITY_CHARGE_SHARD * st.abilityChargeMult;
          if (this.abilityCharge >= 1) {
            this.abilityCharge = 1;
            this.events.push(EV.ABILITY_READY);
          }
        }
        this.events.push(EV.SHARD, c.shardX[i]!, c.shardY[i]!, ss, this.shards);
      }
    }
  }

  private activateAbility(): void {
    const st = this.stats;
    this.abilityCharge = 0;
    this.abilityUses++;
    this.events.push(EV.ABILITY, st.ability);
    if (st.ability === ABILITY_PHASE) {
      this.phaseTime = TUNING.PHASE_DURATION;
      this.phaseExtension = 0;
    } else if (st.ability === ABILITY_OVERDRIVE) {
      this.overdriveTime = TUNING.OVERDRIVE_DURATION;
      if (this.boostTime > 0) this.boostTime = 0;
    } else if (st.ability === ABILITY_MAGNET) {
      this.magnetTime = TUNING.MAGNET_DURATION;
    } else if (st.ability === ABILITY_PULSE) {
      this.pulse();
    }
  }

  /** Pulse Cannon: destroys every non-immune obstacle in a cylinder ahead of the ship. */
  private pulse(): void {
    const R = TUNING.PULSE_RADIUS;
    for (let k = 0; k <= 1; k++) {
      const c = this.chunk(this.chunkIndex + k);
      if (!c) continue;
      const slot = c.index & (SLOTS - 1);
      for (let i = 0; i < c.obsCount; i++) {
        if (!c.isActive(i) || c.obsKind[i] === KIND_WELL) continue;
        const ds = c.obsS[i]! - this.s;
        if (ds < -1 || ds > TUNING.PULSE_RANGE) continue;
        const dx = c.obsX[i]! - this.x;
        const dy = c.obsY[i]! - this.y;
        if (dx * dx + dy * dy > R * R) continue;
        c.obsFlags[i]! |= OF_DESTROYED;
        this.events.push(EV.OBSTACLE_DESTROYED, slot, i, c.obsX[i]!, c.obsY[i]!, c.obsS[i]!);
      }
    }
  }

  private overlappingAny(): boolean {
    const st = this.stats;
    for (let k = -1; k <= 1; k++) {
      const c = this.chunk(this.chunkIndex + k);
      if (!c) continue;
      for (let i = 0; i < c.obsCount; i++) {
        if (!c.isActive(i)) continue;
        const ext = c.obsShape[i] === SHAPE_SPHERE ? c.obsR[i]! : c.obsHS[i]!;
        if (c.obsS[i]! - ext - st.hitHalfLength > this.s || c.obsS[i]! + ext + st.hitHalfLength < this.s)
          continue;
        if (pointClearance(c, i, this.x, this.y, this.s, st.hitRadius, st.hitHalfLength) < 0) return true;
      }
    }
    return false;
  }

  /** Brings the ship back after a death: nearest certified-viable cell, intangible for REVIVE_GHOST. */
  revive(): void {
    if (this.alive) return;
    this.alive = true;
    this.revives++;
    this.ghostTime = TUNING.REVIVE_GHOST;
    this.combo = 0;
    this.comboTimer = 0;
    this.multiplier = 1;
    this.deathObstacle = -1;
    const c = this.current;
    this.speed = c.cruise * this.stats.speedFactor;
    this.updateSpeed();
    // Re-enter at the nearest cell that is certified viable at the next lattice boundary.
    if (c.sliceCount > 0) {
      let k = Math.floor((this.s - c.startS) / c.sliceLen) + 1;
      if (k > c.sliceCount) k = c.sliceCount;
      if (k < 0) k = 0;
      const cell = nearestCellIn(c.viable, k * ROWS, this.x, this.y);
      if (cell >= 0) {
        const col = cell % COLS;
        this.x = cellX(col);
        this.y = cellY((cell - col) / COLS);
        this.prevX = this.x;
        this.prevY = this.y;
      }
    }
    this.events.push(EV.REVIVE, this.x, this.y, this.s);
  }

  /** Debug/test hook: ends the run as if the ship had crashed (used by e2e tests). */
  debugKill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.deathObstacle = 0;
    this.events.push(EV.DEATH, this.x, this.y, this.s, 0);
    this.source?.onDeath(this.s);
  }

  /** Folds the full dynamic state into a hash (determinism tests and replays). */
  hashInto(h: StateHasher): void {
    h.addInt(this.tick);
    h.addInt(this.chunkIndex);
    h.addFloat(this.s);
    h.addFloat(this.x);
    h.addFloat(this.y);
    h.addFloat(this.speed);
    h.addFloat(this.energy);
    h.addFloat(this.focus);
    h.addFloat(this.abilityCharge);
    h.addFloat(this.score);
    h.addInt(this.shards);
    h.addInt(this.nearMisses);
    h.addInt(this.combo);
    h.addInt(this.alive ? 1 : 0);
  }
}
