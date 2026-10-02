import { ChunkData } from '../sim/chunk.ts';

/**
 * Packs a ChunkData into one ArrayBuffer and back, so chunks can cross a worker boundary as a single
 * transferable buffer (no structured-clone of dozens of typed arrays, no per-chunk garbage when buffers are
 * pooled). The same buffer also carries the build request inputs on the way in.
 */

type ArrayField = Exclude<
  {
    [K in keyof ChunkData]: ChunkData[K] extends Int32Array | Float64Array | Uint8Array ? K : never;
  }[keyof ChunkData],
  undefined
>;

const SCALARS = [
  'index',
  'startS',
  'length',
  'biome',
  'difficulty',
  'cruise',
  'vCert',
  'vLatEff',
  'margin',
  'gMax',
  'sliceCount',
  'sliceLen',
  'repairs',
  'attempts',
  'obsCount',
  'shardCount',
] as const;
const FLAGS = ['certified', 'fallback'] as const;
/** Request inputs live after the chunk scalars in the header. */
const H_PREV_CRUISE = SCALARS.length + FLAGS.length;
const H_D = H_PREV_CRUISE + 1;
const H_SEED = H_D + 1;
const H_HAS_PREV = H_SEED + 1;
const HEADER = H_HAS_PREV + 1;

interface Slot {
  name: ArrayField;
  offset: number;
  length: number;
  kind: 'i32' | 'f64' | 'u8';
}

const SLOTS: Slot[] = [];
let bytes = HEADER * 8;
{
  const probe = new ChunkData();
  const names = Object.keys(probe).filter((k) => {
    const v = (probe as unknown as Record<string, unknown>)[k];
    return v instanceof Int32Array || v instanceof Float64Array || v instanceof Uint8Array;
  }) as ArrayField[];
  names.sort();
  for (const name of names) {
    const arr = probe[name];
    const kind = arr instanceof Int32Array ? 'i32' : arr instanceof Float64Array ? 'f64' : 'u8';
    bytes = Math.ceil(bytes / 8) * 8;
    SLOTS.push({ name, offset: bytes, length: arr.length, kind });
    bytes += arr.byteLength;
  }
  bytes = Math.ceil(bytes / 8) * 8;
}

/** Size of one packed chunk in bytes. */
export const CHUNK_BYTES = bytes;

function view(buf: ArrayBuffer, s: Slot): Int32Array | Float64Array | Uint8Array {
  return s.kind === 'i32'
    ? new Int32Array(buf, s.offset, s.length)
    : s.kind === 'f64'
      ? new Float64Array(buf, s.offset, s.length)
      : new Uint8Array(buf, s.offset, s.length);
}

export function packChunk(c: ChunkData, buf: ArrayBuffer): void {
  const h = new Float64Array(buf, 0, HEADER);
  for (let i = 0; i < SCALARS.length; i++) h[i] = c[SCALARS[i]!];
  for (let i = 0; i < FLAGS.length; i++) h[SCALARS.length + i] = c[FLAGS[i]!] ? 1 : 0;
  for (const s of SLOTS) view(buf, s).set(c[s.name]);
}

export function unpackChunk(buf: ArrayBuffer, c: ChunkData): void {
  const h = new Float64Array(buf, 0, HEADER);
  const w = c as unknown as Record<string, number | boolean>;
  for (let i = 0; i < SCALARS.length; i++) w[SCALARS[i]!] = h[i]!;
  for (let i = 0; i < FLAGS.length; i++) w[FLAGS[i]!] = h[SCALARS.length + i] === 1;
  for (const s of SLOTS) (c[s.name] as Int32Array | Float64Array | Uint8Array).set(view(buf, s));
  c.pending = false;
}

/** Build request carried in a buffer: everything the pure builder needs. */
export interface BuildInputs {
  seed: number;
  index: number;
  startS: number;
  prevExit: Int32Array | null;
  prevCruise: number;
  d: number;
}

export function packRequest(r: BuildInputs, buf: ArrayBuffer): void {
  const h = new Float64Array(buf, 0, HEADER);
  h[0] = r.index;
  h[1] = r.startS;
  h[H_PREV_CRUISE] = r.prevCruise;
  h[H_D] = r.d;
  h[H_SEED] = r.seed;
  h[H_HAS_PREV] = r.prevExit ? 1 : 0;
  if (r.prevExit) view(buf, exitSlot()).set(r.prevExit);
}

/** Reads a request; `exit` receives the previous chunk's exit set (when present). */
export function unpackRequest(buf: ArrayBuffer, exit: Int32Array): BuildInputs {
  const h = new Float64Array(buf, 0, HEADER);
  const has = h[H_HAS_PREV] === 1;
  if (has) exit.set(view(buf, exitSlot()) as Int32Array);
  return {
    index: h[0]!,
    startS: h[1]!,
    prevCruise: h[H_PREV_CRUISE]!,
    d: h[H_D]!,
    seed: h[H_SEED]!,
    prevExit: has ? exit : null,
  };
}

function exitSlot(): Slot {
  return SLOTS.find((s) => s.name === 'exit')!;
}
