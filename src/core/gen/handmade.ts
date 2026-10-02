import { obstacleIndex } from '../../data/registry.ts';
import { TUNING } from '../../data/tuning.ts';
import type { ChunkData } from '../sim/chunk.ts';
import { placeObstacle, placeShard, setDronePath } from './place.ts';
import type { ChunkSource } from './source.ts';
import { certifiedSpeed, cruiseFor } from './validation-profile.ts';

/**
 * Milestone-1 chunk source: three hand-made layouts on a loop at a fixed difficulty. Kept as a
 * deterministic fixture for tests and as the reference "known-good" content.
 */
export class HandmadeSource implements ChunkSource {
  difficulty = 0.3;

  beginRun(_seed: number): void {}

  generate(index: number, startS: number, prev: ChunkData | null, out: ChunkData): void {
    out.difficulty = this.difficulty;
    out.cruise = cruiseFor(out.difficulty);
    out.vCert = certifiedSpeed(out.cruise, prev ? prev.cruise : out.cruise);
    out.margin = TUNING.MARGIN_EASY;
    out.biome = Math.floor(index / TUNING.BIOME_CHUNKS) % 4;
    if (index < TUNING.INTRO_CHUNKS) return;
    const rockM = obstacleIndex('rock_m');
    const rockL = obstacleIndex('rock_l');
    const beam = obstacleIndex('ion_beam');
    const pylon = obstacleIndex('ion_pylon');
    const drone = obstacleIndex('drone');
    const S = startS;
    switch (index % 3) {
      case 1:
        placeObstacle(out, rockM, -2.2, 0.4, S + 30, 1, 0.1);
        placeObstacle(out, rockL, 2.4, -1.0, S + 48, 1, 0.2);
        placeObstacle(out, rockM, 0.2, 1.8, S + 66, 1, 0.3);
        placeObstacle(out, rockM, -3.0, -2.0, S + 84, 1, 0.4);
        placeObstacle(out, rockL, 0.0, -0.3, S + 104, 1, 0.5);
        placeObstacle(out, rockM, 3.2, 2.1, S + 122, 1, 0.6);
        break;
      case 2:
        placeObstacle(out, beam, 0, 1.4, S + 40, 1, 0.1);
        placeObstacle(out, beam, 0, -1.6, S + 72, 1, 0.2);
        placeObstacle(out, pylon, -2.1, 0, S + 104, 1, 0.3);
        placeObstacle(out, pylon, 2.1, 0, S + 104, 1, 0.4);
        break;
      default: {
        for (let k = 0; k < 3; k++) {
          const i = placeObstacle(out, drone, 0, (k - 1) * 1.6, S + 40 + k * 36, 1, 0.1 * k);
          if (i >= 0) setDronePath(out, i, 3.2, 0, 60, k * 0.3, false);
        }
        break;
      }
    }
    for (let k = 0; k < 8; k++) placeShard(out, 0, 0, S + 20 + k * 16);
  }

  onChunkCleared(_chunk: ChunkData, _nearMisses: number): void {}
  onDeath(_distance: number): void {}
}
