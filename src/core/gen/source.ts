import type { ChunkData } from '../sim/chunk.ts';

/**
 * Produces chunks for a run. Implementations must be deterministic: the same seed and the same sequence of
 * calls (including the feedback hooks) must produce bit-identical chunks.
 */
export interface ChunkSource {
  beginRun(seed: number): void;
  /** Fills `out` for chunk `index` starting at track distance `startS`. `prev` is chunk index-1 (null for 0). */
  generate(index: number, startS: number, prev: ChunkData | null, out: ChunkData): void;
  /** Called when the ship leaves chunk `chunk` alive (difficulty feedback). */
  onChunkCleared(chunk: ChunkData, nearMisses: number): void;
  /** Called when the ship dies in the current chunk. */
  onDeath(distance: number): void;
}
