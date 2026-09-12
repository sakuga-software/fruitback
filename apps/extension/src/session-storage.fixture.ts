/**
 * `chrome.storage`, in memory (SKG-602).
 *
 * Shared by `session-storage.test.ts` and `session.test.ts`: the second drives two `Sessions` over
 * one of these, which is the only way to reach what the popup and the background do to each other.
 */

import type { StorageArea } from './session-storage.ts';

export type FakeStorage = {
  area: StorageArea;
  /** Every call, in the order it was made. A round trip is what the interleavings are counted in. */
  log: string[];
  /** What the area holds, the keys included — an entry no reader answers is still in here. */
  read(): Record<string, unknown>;
};

export function storage(initial: Record<string, unknown> = {}): FakeStorage {
  const state: Record<string, unknown> = { ...initial };
  const log: string[] = [];

  const area: StorageArea = {
    get: async (keys) => {
      log.push(`get ${keys ?? 'all'}`);

      return { ...state };
    },
    set: async (items) => {
      log.push(`set ${Object.keys(items).join(',')}`);
      Object.assign(state, items);
    },
    remove: async (key) => {
      log.push(`remove ${key}`);
      delete state[key];
    },
  };

  return { area, log, read: () => ({ ...state }) };
}
