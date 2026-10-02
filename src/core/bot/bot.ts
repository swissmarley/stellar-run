import { DT, TUNING } from '../../data/tuning.ts';
import { Rng } from '../det/rng.ts';
import { COLS, cellX, cellY, colOf, ROWS, rowOf } from '../gen/grid.ts';
import type { ChunkData } from '../sim/chunk.ts';
import { driftOut, wellDrift } from '../sim/hazards.ts';
import { BTN_ABILITY, BTN_BOOST, BTN_FOCUS, type InputFrame } from '../sim/input-frame.ts';
import type { RunSim } from '../sim/run-sim.ts';

/**
 * Bots that play through the real RunSim.
 *  - PerfectBot follows a lattice path inside the chunk's certificate (cells in F_k ∩ V_{k+1}), moving one
 *    cell per slice and cancelling gravity drift exactly. If the certificate is sound it can never die, so any
 *    death is a bug in the proof, the validator or the collision code.
 *  - HumanBot uses the same plan with reaction delay, steering noise and lapses; it dies, which exercises
 *    revive, the flow state machine and the difficulty director.
 */
export class PerfectBot {
  protected readonly rng = new Rng();
  private planned = -1;
  protected readonly pathCol = new Int16Array(TUNING.MAX_SLICES + 1);
  protected readonly pathRow = new Int16Array(TUNING.MAX_SLICES + 1);
  /** Probability per tick of pressing boost (exercises the certified-speed clamp). */
  boostRate = 0.02;
  /** Probability per tick of using a ready ability. */
  abilityRate = 0.01;
  planFailures = 0;

  reset(seed: number): void {
    this.rng.seed(seed);
    this.planned = -1;
    this.planFailures = 0;
  }

  /** Builds a path P_0..P_K through the chunk's viable cells starting from the ship's cell. */
  protected plan(c: ChunkData, x: number, y: number): void {
    let col = colOf(x);
    let row = rowOf(y);
    this.pathCol[0] = col;
    this.pathRow[0] = row;
    let dc = 0;
    let dr = 0;
    for (let k = 0; k < c.sliceCount; k++) {
      const fo = k * ROWS;
      const vo = (k + 1) * ROWS;
      if (this.rng.chance(0.2)) {
        const p = this.rng.int(5);
        dc = p === 1 ? 1 : p === 2 ? -1 : 0;
        dr = p === 3 ? 1 : p === 4 ? -1 : 0;
      }
      let moved = false;
      if (this.ok(c, fo, vo, col + dc, row + dr)) {
        col += dc;
        row += dr;
        moved = true;
      } else if (this.ok(c, fo, vo, col, row)) {
        moved = true;
      } else {
        for (let n = 0; n < 4 && !moved; n++) {
          const cc = col + (n === 0 ? 1 : n === 1 ? -1 : 0);
          const rr = row + (n === 2 ? 1 : n === 3 ? -1 : 0);
          if (this.ok(c, fo, vo, cc, rr)) {
            col = cc;
            row = rr;
            moved = true;
          }
        }
        dc = 0;
        dr = 0;
      }
      if (!moved) this.planFailures++;
      this.pathCol[k + 1] = col;
      this.pathRow[k + 1] = row;
    }
  }

  private ok(c: ChunkData, fo: number, vo: number, col: number, row: number): boolean {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    return ((c.free[fo + row]! >>> col) & 1) === 1 && ((c.viable[vo + row]! >>> col) & 1) === 1;
  }

  /** Target cell for the tick that starts at the ship's current s. */
  protected target(sim: RunSim): { tx: number; ty: number } {
    const c = sim.current;
    if (c.index !== this.planned) {
      this.plan(c, sim.x, sim.y);
      this.planned = c.index;
    }
    let k = Math.floor((sim.s - c.startS) / c.sliceLen);
    if (k < 0) k = 0;
    if (k > c.sliceCount - 1) k = c.sliceCount - 1;
    TARGET.tx = cellX(this.pathCol[k + 1]!);
    TARGET.ty = cellY(this.pathRow[k + 1]!);
    return TARGET;
  }

  decide(sim: RunSim, out: InputFrame): void {
    out.clear();
    if (!sim.alive) return;
    const t = this.target(sim);
    steerToward(sim, t.tx, t.ty, 1, out);
    this.buttons(sim, out);
  }

  protected buttons(sim: RunSim, out: InputFrame): void {
    let b = 0;
    if (this.rng.chance(this.boostRate)) b |= BTN_BOOST;
    if (sim.abilityCharge >= 1 && this.rng.chance(this.abilityRate)) b |= BTN_ABILITY;
    if (sim.tick % 600 < 90) b |= BTN_FOCUS;
    out.buttons = b;
  }
}

const TARGET = { tx: 0, ty: 0 };

/** Velocity command that reaches (tx, ty) as fast as possible, cancelling the drift by `cancel` (0..1). */
export function steerToward(sim: RunSim, tx: number, ty: number, cancel: number, out: InputFrame): void {
  const lat = sim.stats.lateralSpeed;
  wellDrift(sim.current, sim.x, sim.y, sim.s);
  const gvx = driftOut.x * sim.speed * cancel;
  const gvy = driftOut.y * sim.speed * cancel;
  const avail = lat - Math.sqrt(gvx * gvx + gvy * gvy);
  let dvx = (tx - sim.x) / DT;
  let dvy = (ty - sim.y) / DT;
  const m = Math.sqrt(dvx * dvx + dvy * dvy);
  if (m > avail && m > 0) {
    dvx *= avail / m;
    dvy *= avail / m;
  }
  out.setSteer((dvx - gvx) / lat, (dvy - gvy) / lat);
}

/** A fallible player: late reactions, noisy thumb, occasional lapses, partial drift compensation. */
export class HumanBot extends PerfectBot {
  /** Reaction delay in ticks. */
  delay = 10;
  noise = 0.25;
  lapseRate = 0.004;
  private readonly hx = new Float64Array(64);
  private readonly hy = new Float64Array(64);
  private lapse = 0;
  private lapseX = 0;
  private lapseY = 0;

  override decide(sim: RunSim, out: InputFrame): void {
    out.clear();
    if (!sim.alive) return;
    const t = this.target(sim);
    const i = sim.tick & 63;
    this.hx[i] = t.tx;
    this.hy[i] = t.ty;
    const j = (sim.tick - this.delay) & 63;
    let tx = sim.tick > this.delay ? this.hx[j]! : t.tx;
    let ty = sim.tick > this.delay ? this.hy[j]! : t.ty;
    if (this.lapse > 0) {
      this.lapse--;
      tx = this.lapseX;
      ty = this.lapseY;
    } else if (this.rng.chance(this.lapseRate)) {
      this.lapse = 20 + this.rng.int(30);
      this.lapseX = this.rng.range(-4, 4);
      this.lapseY = this.rng.range(-2.8, 2.8);
    }
    tx += this.rng.range(-this.noise, this.noise);
    ty += this.rng.range(-this.noise, this.noise);
    steerToward(sim, tx, ty, 0.5, out);
    this.buttons(sim, out);
  }
}
