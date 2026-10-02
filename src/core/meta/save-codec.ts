import { crc32 } from './crc32.ts';

/** Minimal key-value storage (localStorage or an in-memory fallback). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  /** When set, setItem throws (simulates a full or blocked storage). */
  failWrites = false;

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMExceptionLike('QuotaExceededError');
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

class DOMExceptionLike extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

export interface Envelope {
  v: number;
  seq: number;
  crc: number;
  p: string;
}

export type Decoded = { ok: true; v: number; seq: number; payload: unknown } | { ok: false; reason: string };

export function encode(payload: unknown, version: number, seq: number): string {
  const p = JSON.stringify(payload);
  const env: Envelope = { v: version, seq, crc: crc32(p), p };
  return JSON.stringify(env);
}

/** Parses and verifies an envelope. Never throws. */
export function decode(text: string | null): Decoded {
  if (text === null) return { ok: false, reason: 'missing' };
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (!env || typeof env !== 'object') return { ok: false, reason: 'not an object' };
  const e = env as Partial<Envelope>;
  if (
    typeof e.v !== 'number' ||
    typeof e.seq !== 'number' ||
    typeof e.crc !== 'number' ||
    typeof e.p !== 'string'
  ) {
    return { ok: false, reason: 'bad envelope' };
  }
  if (crc32(e.p) !== e.crc) return { ok: false, reason: 'checksum mismatch' };
  try {
    return { ok: true, v: e.v, seq: e.seq, payload: JSON.parse(e.p) };
  } catch {
    return { ok: false, reason: 'bad payload' };
  }
}

export interface SlotLoad<T> {
  value: T;
  /** Which slot the value came from (null = defaults). */
  from: 'A' | 'B' | null;
  seq: number;
  /** True if a newer schema than this build understands was found: writes are disabled to protect it. */
  readOnly: boolean;
  /** Human-readable notes about recovered corruption (shown once in the UI). */
  notes: string[];
}

/**
 * Corruption-safe versioned storage with two alternating slots. Each write goes to the slot NOT holding the
 * newest valid copy, so an interrupted or corrupted write can only damage the older copy. Loads take the
 * valid slot with the highest sequence number, migrate it, and sanitise it.
 */
export class SlotStore<T> {
  private seq = 0;
  private newest: 'A' | 'B' | null = null;
  readOnly = false;
  lastError: string | null = null;

  readonly store: KeyValueStore;
  readonly key: string;
  readonly version: number;
  readonly sanitize: (raw: unknown) => T;
  readonly migrate: (raw: Record<string, unknown>, from: number) => Record<string, unknown>;
  readonly defaults: () => T;

  constructor(
    store: KeyValueStore,
    key: string,
    version: number,
    sanitize: (raw: unknown) => T,
    migrate: (raw: Record<string, unknown>, from: number) => Record<string, unknown>,
    defaults: () => T,
  ) {
    this.store = store;
    this.key = key;
    this.version = version;
    this.sanitize = sanitize;
    this.migrate = migrate;
    this.defaults = defaults;
  }

  private read(slot: 'A' | 'B'): Decoded {
    try {
      return decode(this.store.getItem(`${this.key}.${slot}`));
    } catch {
      return { ok: false, reason: 'storage unavailable' };
    }
  }

  load(): SlotLoad<T> {
    const a = this.read('A');
    const b = this.read('B');
    const notes: string[] = [];
    if (!a.ok && a.reason !== 'missing') notes.push(`slot A unreadable (${a.reason})`);
    if (!b.ok && b.reason !== 'missing') notes.push(`slot B unreadable (${b.reason})`);
    let pick: { slot: 'A' | 'B'; d: Extract<Decoded, { ok: true }> } | null = null;
    if (a.ok) pick = { slot: 'A', d: a };
    if (b.ok && (!pick || b.seq > pick.d.seq)) pick = { slot: 'B', d: b };
    if (!pick) {
      this.seq = 0;
      this.newest = null;
      return { value: this.defaults(), from: null, seq: 0, readOnly: false, notes };
    }
    this.seq = pick.d.seq;
    this.newest = pick.slot;
    if (pick.d.v > this.version) {
      this.readOnly = true;
      notes.push(`save written by a newer version (v${pick.d.v}); progress will not be saved to protect it`);
      return {
        value: this.sanitize(pick.d.payload),
        from: pick.slot,
        seq: pick.d.seq,
        readOnly: true,
        notes,
      };
    }
    const raw =
      pick.d.payload && typeof pick.d.payload === 'object' ? (pick.d.payload as Record<string, unknown>) : {};
    const migrated = pick.d.v < this.version ? this.migrate(raw, pick.d.v) : raw;
    return { value: this.sanitize(migrated), from: pick.slot, seq: pick.d.seq, readOnly: false, notes };
  }

  /** Writes `value` to the older slot. Returns false (and keeps the previous copy) if storage fails. */
  save(value: T): boolean {
    if (this.readOnly) return false;
    const target: 'A' | 'B' = this.newest === 'A' ? 'B' : 'A';
    const seq = this.seq + 1;
    try {
      this.store.setItem(`${this.key}.${target}`, encode(value, this.version, seq));
    } catch (e) {
      this.lastError = (e as Error).name || 'write failed';
      return false;
    }
    this.seq = seq;
    this.newest = target;
    this.lastError = null;
    return true;
  }

  /** Deletes both slots (player-initiated data reset). */
  wipe(): void {
    try {
      this.store.removeItem(`${this.key}.A`);
      this.store.removeItem(`${this.key}.B`);
    } catch {
      /* nothing to delete */
    }
    this.seq = 0;
    this.newest = null;
    this.readOnly = false;
  }
}
