import { type KeyValueStore, MemoryStore } from '../core/meta/save-codec.ts';

/**
 * Picks persistent storage: localStorage when it works (it can throw in private modes or when blocked), else
 * an in-memory store so the game still runs; the UI tells the player progress will not persist.
 */
export function openStorage(): { store: KeyValueStore; persistent: boolean } {
  try {
    const ls = window.localStorage;
    const probe = '__stellar_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return { store: ls, persistent: true };
  } catch {
    return { store: new MemoryStore(), persistent: false };
  }
}
