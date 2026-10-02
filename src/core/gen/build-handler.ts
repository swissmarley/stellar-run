import { ChunkData } from '../sim/chunk.ts';
import { packChunk, unpackRequest } from './chunk-codec.ts';
import { type GenStats, ProceduralSource } from './generator.ts';
import { ROWS } from './grid.ts';

/**
 * The work done inside the generation worker, as a pure function of a request buffer: read the inputs, build
 * and certify the chunk with the same code as the synchronous path, and pack the result into the same buffer.
 * Kept free of worker APIs so tests can run it in-process.
 */
export function createBuildHandler(): { handle(buf: ArrayBuffer): void; stats: GenStats } {
  const builder = new ProceduralSource();
  const scratch = new ChunkData();
  const exit = new Int32Array(ROWS);
  return {
    stats: builder.stats,
    handle(buf: ArrayBuffer): void {
      const r = unpackRequest(buf, exit);
      builder.setSeed(r.seed);
      builder.build(r.index, r.startS, r.prevExit, r.prevCruise, r.d, scratch);
      packChunk(scratch, buf);
    },
  };
}
