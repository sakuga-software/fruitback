import { type Seed, parseSeed } from '@fruitback/shared';

/**
 * The notes kept for later, not sent yet (FRU-124).
 *
 * A reviewer goes through a page, or through several, and sends the notes together. Each one is a
 * whole seed, built at the moment it was written: the element, the place and the picture are those
 * of that moment, and the worker plants it as it would have planted it then.
 *
 * **`sessionStorage`, per tab**, as the ticket decided. The drafts outlive a reload and a navigation
 * in the tab, which reading several pages needs, and they go with the tab. Not `localStorage`: notes
 * that were never sent would stay on a shared machine, readable by every script of the origin, and
 * two tabs would write over each other.
 *
 * The picture is not a problem of size here: a seed holds the address of a picture the host already
 * uploaded, not the picture.
 */
export type Draft = {
  seed: Seed;
  /** The opaque id of the place a member chose, when it is not the first one (FRU-123). */
  destination?: string;
};

export type DraftStore = {
  /** Oldest first. */
  list(): readonly Draft[];
  add(draft: Draft): void;
  /** The drafts the worker kept. The others stay. */
  remove(ids: readonly string[]): void;
  subscribe(listener: () => void): () => void;
};

export type DraftStoreOptions = {
  /** `sessionStorage` in practice. `null` keeps the drafts in memory, which is also what a refusal gives. */
  storage: Storage | null;
  key: string;
};

export function createDraftStore(options: DraftStoreOptions): DraftStore {
  const { storage, key } = options;
  const listeners = new Set<() => void>();
  let drafts: readonly Draft[] = readStored(storage, key);

  function set(next: readonly Draft[]): void {
    drafts = next;
    try {
      if (next.length === 0) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(next));
    } catch {
      // Full, or refused. The drafts stay in memory for this page, and a reload loses them.
    }
    for (const listener of listeners) listener();
  }

  return {
    list: () => drafts,
    add(draft) {
      set([...drafts.filter((each) => each.seed.id !== draft.seed.id), draft]);
    },
    remove(ids) {
      const gone = new Set(ids);
      if (!drafts.some((draft) => gone.has(draft.seed.id))) return;
      set(drafts.filter((draft) => !gone.has(draft.seed.id)));
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

/**
 * Tolerant, like `readStored` of the config: a value a human can edit in devtools costs the drafts it
 * spoils, and nothing else. Every seed goes through `parseSeed`, because the worker refuses a batch
 * whole for one thing that is not a seed.
 */
function readStored(storage: Storage | null, key: string): Draft[] {
  if (storage === null) return [];

  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((each: unknown) => {
      if (typeof each !== 'object' || each === null) return [];
      const { seed, destination } = each as { seed?: unknown; destination?: unknown };
      const read = parseSeed(seed);
      if (!read.ok) return [];

      return [{ seed: read.seed, ...(typeof destination === 'string' ? { destination } : {}) }];
    });
  } catch {
    return [];
  }
}

/** `sessionStorage` of this window, or `null` where reading it throws (a sandboxed frame, a privacy mode). */
export function sessionStorageOf(view: Window | null): Storage | null {
  try {
    return view?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** What a worker takes in one request (FRU-124), from the envelope of a read. */
export type BatchOffer = { max: number; maxBytes: number };

/** Read tolerantly: anything but two positive integers means the worker takes one note at a time. */
export function offeredBatch(value: unknown): BatchOffer | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { max, maxBytes } = value as { max?: unknown; maxBytes?: unknown };
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

  return whole(max) && whole(maxBytes) ? { max, maxBytes } : undefined;
}

/**
 * The requests that send these drafts, in their order.
 *
 * One place for each request, because `?destination=` is for the whole batch. Then as many notes as
 * the worker takes, and as many bytes: the cap of the body does not move for a batch, and ten long
 * notes go over it. A draft heavier than the cap alone goes alone, and its `413` keeps it.
 *
 * With no offer, one note for each request, and the body is the seed and not an array: a worker that
 * offers no batch never receives one.
 */
export function cutIntoRequests(drafts: readonly Draft[], offer: BatchOffer | undefined): Draft[][] {
  if (offer === undefined) return drafts.map((draft) => [draft]);

  const byPlace = new Map<string | undefined, Draft[]>();
  for (const draft of drafts) byPlace.set(draft.destination, [...(byPlace.get(draft.destination) ?? []), draft]);

  const requests: Draft[][] = [];
  for (const group of byPlace.values()) {
    let current: Draft[] = [];
    for (const draft of group) {
      const next = [...current, draft];
      if (current.length > 0 && (next.length > offer.max || bodyBytes(next) > offer.maxBytes)) {
        requests.push(current);
        current = [draft];
      } else {
        current = next;
      }
    }
    if (current.length > 0) requests.push(current);
  }

  return requests;
}

/** The body of a batch, as it goes on the wire. */
export function batchBody(drafts: readonly Draft[]): string {
  return JSON.stringify(drafts.map((draft) => draft.seed));
}

function bodyBytes(drafts: readonly Draft[]): number {
  return new TextEncoder().encode(batchBody(drafts)).length;
}
