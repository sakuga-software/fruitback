import type { SeedAnchor } from '@fruitback/shared';

/**
 * The note somebody is writing, saved as they type (FRU-311).
 *
 * The composer lost its text to a reload, to Esc, to « Cancel » and to the cross: only « Keep for
 * later » kept it. Now each change of the field is written here, for its page and its element, and
 * the text comes back when the composer opens again on that element, or by itself when the page
 * comes back. A note sent or kept for later leaves; a field emptied by hand leaves too.
 *
 * **`sessionStorage`, per tab**, under `<configKey>:typing`, for the reasons of `drafts.ts`: it outlives
 * a reload and a navigation in the tab, goes with the tab, and two tabs do not write over each other.
 * A storage that refuses keeps the text in memory for the page.
 *
 * The anchor is the one a seed carries (`captureAnchor`), so the element is found again the way a pin
 * is. No seed is built here: the picture and the place are taken when the note is sent.
 */
export type Typing = {
  /** The canonical address of the page (`canonicalizePageUrl`). */
  page: string;
  anchor: SeedAnchor;
  text: string;
  /** When it was last written, in milliseconds. The latest of a page is the one that reopens. */
  at: number;
};

/** The element of a note, on its page. */
export type TypingPlace = { page: string; anchor: SeedAnchor };

export type TypingStore = {
  get(place: TypingPlace): Typing | undefined;
  /** The text written last on this page, if any. */
  latest(page: string): Typing | undefined;
  /** An empty text, or one of spaces only, removes the entry. */
  write(place: TypingPlace, text: string): void;
  remove(place: TypingPlace): void;
};

/** A tab holds this many texts at most. The oldest leaves first. */
export const MAX_TYPING = 20;

export type TypingStoreOptions = {
  /** `sessionStorage` in practice. `null` keeps the texts in memory, which is also what a refusal gives. */
  storage: Storage | null;
  key: string;
  now?: () => number;
};

export function createTypingStore(options: TypingStoreOptions): TypingStore {
  const { storage, key } = options;
  const now = options.now ?? Date.now;
  let entries: Typing[] = readStored(storage, key);

  const same = (entry: Typing, place: TypingPlace): boolean =>
    entry.page === place.page && entry.anchor.selector === place.anchor.selector;

  function set(next: Typing[]): void {
    entries = next;
    try {
      if (next.length === 0) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(next));
    } catch {
      // Full, or refused. The text stays in memory for this page, and a reload loses it.
    }
  }

  return {
    get: (place) => entries.find((entry) => same(entry, place)),
    latest(page) {
      return entries.filter((entry) => entry.page === page).sort((a, b) => b.at - a.at)[0];
    },
    write(place, text) {
      const others = entries.filter((entry) => !same(entry, place));
      if (text.trim() === '') {
        if (others.length !== entries.length) set(others);

        return;
      }
      set([...others, { page: place.page, anchor: place.anchor, text, at: now() }].slice(-MAX_TYPING));
    },
    remove(place) {
      const others = entries.filter((entry) => !same(entry, place));
      if (others.length !== entries.length) set(others);
    },
  };
}

/** Tolerant: a value a human can edit in devtools costs the entries it spoils, and nothing else. */
function readStored(storage: Storage | null, key: string): Typing[] {
  if (storage === null) return [];

  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((each: unknown) => {
      if (typeof each !== 'object' || each === null) return [];
      const { page, anchor, text, at } = each as Record<string, unknown>;
      if (typeof page !== 'string' || typeof text !== 'string' || typeof at !== 'number') return [];
      if (typeof anchor !== 'object' || anchor === null) return [];
      // The anchor goes to `resolveAnchor`, which needs its selector and its tag; the rest is optional.
      const { selector, tag } = anchor as Record<string, unknown>;
      if (typeof selector !== 'string' || typeof tag !== 'string') return [];

      return [{ page, anchor: anchor as SeedAnchor, text, at }];
    });
  } catch {
    return [];
  }
}
