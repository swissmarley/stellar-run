/** Sim event codes. The sim never calls listeners; it appends to a ring buffer that the game drains. */
export const EV = {
  NEAR_MISS: 1, // a=points b=clearance c=x d=y e=s f=perfect(0/1)
  SHARD: 2, // a=x b=y c=s d=total shards
  BOOST_START: 3,
  BOOST_END: 4,
  FOCUS_START: 5,
  FOCUS_END: 6,
  ABILITY: 7, // a=ability index (0 phase,1 overdrive,2 pulse,3 magnet)
  ABILITY_READY: 8,
  ABILITY_END: 9, // a=ability index
  DEATH: 10, // a=x b=y c=s d=obstacle def index
  CHUNK_ENTER: 11, // a=chunk index b=biome c=difficulty
  BIOME_CHANGE: 12, // a=biome index
  COMBO_END: 13, // a=combo reached
  REVIVE: 14,
  MILESTONE: 15, // a=distance
  OBSTACLE_DESTROYED: 16, // a=chunk slot b=obstacle index c=x d=y e=s
  COMBO_UP: 17, // a=combo b=multiplier
} as const;

export type EventCode = (typeof EV)[keyof typeof EV];

const CAP = 512;
const PAYLOAD = 6;

/** Fixed-capacity event ring buffer. Allocation-free. Oldest events are overwritten if nobody drains. */
export class EventRing {
  readonly codes = new Int32Array(CAP);
  readonly data = new Float64Array(CAP * PAYLOAD);
  private head = 0;
  private tail = 0;
  dropped = 0;

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.dropped = 0;
  }

  push(code: number, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0): void {
    const i = this.head % CAP;
    this.codes[i] = code;
    const o = i * PAYLOAD;
    this.data[o] = a;
    this.data[o + 1] = b;
    this.data[o + 2] = c;
    this.data[o + 3] = d;
    this.data[o + 4] = e;
    this.data[o + 5] = f;
    this.head++;
    if (this.head - this.tail > CAP) {
      this.tail = this.head - CAP;
      this.dropped++;
    }
  }

  /** Number of undrained events. */
  get pending(): number {
    return this.head - this.tail;
  }

  /** Returns the ring index of the next event, or -1. Read codes[idx] and data[idx*6 ...]. */
  shift(): number {
    if (this.tail >= this.head) return -1;
    const idx = this.tail % CAP;
    this.tail++;
    return idx;
  }

  static readonly PAYLOAD = PAYLOAD;
}
