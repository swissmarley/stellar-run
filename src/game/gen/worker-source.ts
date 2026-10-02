import { CHUNK_BYTES, packRequest, unpackChunk } from '../../core/gen/chunk-codec.ts';
import type { ProceduralSource } from '../../core/gen/generator.ts';
import { ROWS } from '../../core/gen/grid.ts';
import type { ChunkSource } from '../../core/gen/source.ts';
import type { ChunkData } from '../../core/sim/chunk.ts';

/** Minimal message channel (a real Worker in the browser, an in-process fake in tests). */
export interface GenTransport {
  post(msg: { run: number; index: number; buf: ArrayBuffer }, transfer: ArrayBuffer[]): void;
  onmessage: ((e: { data: { run: number; index: number; buf: ArrayBuffer; ms?: number } }) => void) | null;
}

interface Pending {
  out: ChunkData;
  index: number;
  startS: number;
  prevExit: Int32Array;
  hasPrev: boolean;
  prevCruise: number;
  d: number;
  active: boolean;
}

export interface WorkerGenStats {
  requests: number;
  fromWorker: number;
  syncFallbacks: number;
  stale: number;
  maxWorkerMs: number;
}

/**
 * Asynchronous chunk source. Difficulty is still decided on the main thread at the request tick (the director
 * is stateful); the worker only runs the pure builder. If a result is late when the sim needs the chunk,
 * `ensure` builds it synchronously from the same captured inputs, giving a bit-identical chunk, so worker
 * timing can never change gameplay or replays. Request buffers are pooled and transferred both ways.
 */
export class WorkerSource implements ChunkSource {
  readonly inner: ProceduralSource;
  readonly stats: WorkerGenStats = { requests: 0, fromWorker: 0, syncFallbacks: 0, stale: 0, maxWorkerMs: 0 };
  private readonly transport: GenTransport;
  private run = 0;
  private readonly pool: ArrayBuffer[] = [];
  private readonly pending: Pending[] = [];

  constructor(inner: ProceduralSource, transport: GenTransport) {
    this.inner = inner;
    this.transport = transport;
    for (let i = 0; i < 4; i++) this.pool.push(new ArrayBuffer(CHUNK_BYTES));
    for (let i = 0; i < 4; i++) {
      this.pending.push({
        out: null as unknown as ChunkData,
        index: -1,
        startS: 0,
        prevExit: new Int32Array(ROWS),
        hasPrev: false,
        prevCruise: -1,
        d: 0,
        active: false,
      });
    }
    transport.onmessage = (e) => this.receive(e.data);
  }

  /** Requests not yet completed (by the worker or a synchronous fallback). */
  get inFlight(): number {
    let n = 0;
    for (const p of this.pending) if (p.active) n++;
    return n;
  }

  beginRun(seed: number): void {
    this.run++;
    for (const p of this.pending) p.active = false;
    this.inner.beginRun(seed);
  }

  generate(index: number, startS: number, prev: ChunkData | null, out: ChunkData): void {
    this.inner.generate(index, startS, prev, out);
  }

  request(index: number, startS: number, prev: ChunkData | null, out: ChunkData): void {
    const d = this.inner.decide(index, startS);
    const slot = this.pending.find((p) => !p.active);
    const buf = this.pool.pop();
    if (!slot || !buf) {
      // Out of slots or buffers (should not happen): build now, exactly like the synchronous path.
      if (buf) this.pool.push(buf);
      this.inner.build(index, startS, prev ? prev.exit : null, prev ? prev.cruise : -1, d, out);
      this.stats.syncFallbacks++;
      return;
    }
    slot.out = out;
    slot.index = index;
    slot.startS = startS;
    slot.hasPrev = prev !== null;
    if (prev) slot.prevExit.set(prev.exit);
    slot.prevCruise = prev ? prev.cruise : -1;
    slot.d = d;
    slot.active = true;
    out.pending = true;
    packRequest(
      {
        seed: this.inner.runSeed,
        index,
        startS,
        prevExit: prev ? prev.exit : null,
        prevCruise: slot.prevCruise,
        d,
      },
      buf,
    );
    this.stats.requests++;
    this.transport.post({ run: this.run, index, buf }, [buf]);
  }

  ensure(out: ChunkData): void {
    if (!out.pending) return;
    const p = this.pending.find((x) => x.active && x.out === out && x.index === out.index);
    if (!p) return;
    p.active = false;
    this.inner.build(p.index, p.startS, p.hasPrev ? p.prevExit : null, p.prevCruise, p.d, out);
    this.stats.syncFallbacks++;
  }

  private receive(m: { run: number; index: number; buf: ArrayBuffer; ms?: number }): void {
    const p = this.pending.find((x) => x.active && x.index === m.index);
    if (m.run === this.run && p && p.out.pending && p.out.index === m.index) {
      unpackChunk(m.buf, p.out);
      p.active = false;
      this.stats.fromWorker++;
      if (m.ms !== undefined && m.ms > this.stats.maxWorkerMs) this.stats.maxWorkerMs = m.ms;
    } else {
      this.stats.stale++;
    }
    this.pool.push(m.buf);
  }

  onChunkCleared(chunk: ChunkData, nearMisses: number): void {
    this.inner.onChunkCleared(chunk, nearMisses);
  }

  onDeath(distance: number): void {
    this.inner.onDeath(distance);
  }
}

/** Starts the generation worker; returns null where module workers are unavailable (falls back to sync). */
export function createGenWorker(): GenTransport | null {
  try {
    const w = new Worker(new URL('./gen-worker.ts', import.meta.url), { type: 'module', name: 'chunk-gen' });
    const t: GenTransport = {
      post: (msg, transfer) => w.postMessage(msg, transfer),
      onmessage: null,
    };
    w.onmessage = (e) => t.onmessage?.(e);
    w.onerror = () => {
      t.onmessage = null;
    };
    return t;
  } catch {
    return null;
  }
}
