/**
 * The places a note can go, as the worker offers them to this reader (FRU-123).
 *
 * A site can send its notes to several places of its tracker. The worker names them in the answer of
 * a read, in `destinations`, and only to a person who may see the tracker. Everybody else gets no
 * such field, and an older worker sends none: the composer then shows no choice at all.
 *
 * The first place is where a note goes when nobody chooses. The widget sends the id of another place
 * and nothing else: the id is opaque, and the worker checks it again.
 */

export type Destination = {
  /** Opaque. The worker resolves it, and refuses one the site does not have. */
  id: string;
  /** What the worker calls the place. Absent for a place set before the worker wrote labels. */
  label?: string;
};

/** An id is a short digest. The limit keeps a hostile answer from putting a document in a URL. */
export const DESTINATION_ID_MAX = 200;
const LABEL_MAX = 200;

/**
 * Read `destinations` from the answer of a read, like `offeredStages` reads `stages`: tolerantly.
 *
 * Absent, malformed or shorter than two places all answer an empty list, which is no choice.
 *
 * **One bad entry costs the whole list, and not that entry.** The first place is the default by its
 * position. A list with one entry removed would show another default than the one the worker uses,
 * and a note would go where the line did not say. A label is only a name, so a bad label costs the
 * label.
 */
export function offeredDestinations(value: unknown): Destination[] {
  if (!Array.isArray(value) || value.length < 2) return [];

  const seen = new Set<string>();
  const places: Destination[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return [];

    const { id, label } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || id.length > DESTINATION_ID_MAX || seen.has(id)) return [];
    seen.add(id);

    const name = typeof label === 'string' ? label.trim().slice(0, LABEL_MAX) : '';
    places.push(name === '' ? { id } : { id, label: name });
  }

  return places;
}

/**
 * The id that travels with a note, or nothing.
 *
 * Only a choice travels. The first place is where the worker sends a note that names none, so a
 * member who chose nothing makes the request of everybody else, and of a widget older than this.
 * An id that is not offered now does not travel either: the worker would refuse the note for it.
 */
export function destinationToSend(offered: readonly Destination[], chosen: string | undefined): string | undefined {
  return chosen !== offered[0]?.id && offered.some((place) => place.id === chosen) ? chosen : undefined;
}

/**
 * The places the last read offered.
 *
 * Not in `ConfigStore`, for the reason `OfferedStages` is not: the list is the worker's word about
 * this reader now. A copy in `localStorage` would show the names of a tracker to the next person on
 * this browser, and after the reader lost the right to see them.
 */
export type OfferedDestinations = {
  get(): readonly Destination[];
  set(places: readonly Destination[]): void;
  subscribe(listener: () => void): () => void;
};

export function createOfferedDestinations(): OfferedDestinations {
  let current: readonly Destination[] = [];
  const listeners = new Set<() => void>();

  return {
    get: () => current,
    set(places) {
      // Every read sets the list, and most reads change nothing. A listener redraws the choice, and
      // a redraw under somebody who is choosing moves their focus.
      if (JSON.stringify(places) === JSON.stringify(current)) return;

      current = places.map((place) => ({ ...place }));
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}
