import { type ChunkData, KIND_DRONE, SHAPE_SPHERE } from '../sim/chunk.ts';
import { obstaclePos, posOut } from '../sim/hazards.ts';
import type { RunSim } from '../sim/run-sim.ts';

/**
 * Independent clearance oracle. Re-checks an executed trajectory with a different formulation from the sim's
 * collision code (explicit closest point on the hitbox segment, dense sub-stepping instead of golden-section
 * search) and asserts the certificate's promise: clearance ≥ the chunk's validation margin.
 */
export class Oracle {
  readonly sub: number;
  checks = 0;
  violations = 0;
  /** Smallest (clearance − margin) observed; ≥ 0 means every promise held. */
  worstSlack = Number.POSITIVE_INFINITY;
  lastViolation = '';

  constructor(subSteps = 8) {
    this.sub = subSteps;
  }

  /** Static clearance between the ship capsule at (x, y, s) and obstacle i. */
  static clearance(c: ChunkData, i: number, x: number, y: number, s: number, r: number, h: number): number {
    let ox = c.obsX[i]!;
    let oy = c.obsY[i]!;
    if (c.obsKind[i] === KIND_DRONE) {
      obstaclePos(c, i, s);
      ox = posOut.x;
      oy = posOut.y;
    }
    const os = c.obsS[i]!;
    if (c.obsShape[i] === SHAPE_SPHERE) {
      // Closest point on the segment (x, y, s−h)→(x, y, s+h) to the sphere centre.
      const ax = x;
      const ay = y;
      const as = s - h;
      const ls = 2 * h;
      let t = ls > 0 ? (os - as) / ls : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax - ox;
      const py = ay - oy;
      const ps = as + t * ls - os;
      return Math.sqrt(px * px + py * py + ps * ps) - c.obsR[i]! - r;
    }
    const dx = Math.max(0, Math.abs(x - ox) - c.obsHX[i]!);
    const dy = Math.max(0, Math.abs(y - oy) - c.obsHY[i]!);
    const lo = os - c.obsHS[i]!;
    const hi = os + c.obsHS[i]!;
    const ds = Math.max(0, lo - (s + h), s - h - hi);
    return Math.sqrt(dx * dx + dy * dy + ds * ds) - r;
  }

  /** Checks the last tick of `sim` (from prev* to current state). Call after every step while tangible. */
  check(sim: RunSim): void {
    if (!sim.alive || sim.intangible) return;
    const r = sim.stats.hitRadius;
    const h = sim.stats.hitHalfLength;
    for (let k = -1; k <= 1; k++) {
      const c = sim.chunk(sim.chunkIndex + k);
      if (!c) continue;
      for (let i = 0; i < c.obsCount; i++) {
        if (!c.isActive(i)) continue;
        const ext = c.obsShape[i] === SHAPE_SPHERE ? c.obsR[i]! : c.obsHS[i]!;
        const os = c.obsS[i]!;
        if (os - ext - h - 3 > sim.s || os + ext + h + 3 < sim.prevS) continue;
        for (let q = 0; q <= this.sub; q++) {
          const t = q / this.sub;
          const x = sim.prevX + (sim.x - sim.prevX) * t;
          const y = sim.prevY + (sim.y - sim.prevY) * t;
          const s = sim.prevS + (sim.s - sim.prevS) * t;
          const slack = Oracle.clearance(c, i, x, y, s, r, h) - c.margin;
          this.checks++;
          if (slack < this.worstSlack) this.worstSlack = slack;
          if (slack < -1e-6) {
            this.violations++;
            this.lastViolation = `chunk ${c.index} obstacle ${i} (def ${c.obsDef[i]}) slack ${slack.toFixed(4)} at s=${s.toFixed(2)}`;
          }
        }
      }
    }
  }
}
