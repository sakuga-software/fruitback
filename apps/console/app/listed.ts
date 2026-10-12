import type { Answer } from './api.ts';

/**
 * A list a screen read from the worker (FRU-162).
 *
 * **No list is not an empty list.** `loading`: no answer yet. `failed`: the worker refused, or did
 * not answer. Only an answer that holds a list is a list, so only that one may show the empty state.
 * A screen that drew `[]` for a failed read said « No site yet » during an outage.
 */
export type Listed<T> = readonly T[] | 'loading' | 'failed';

/**
 * The list an answer holds, or `failed`. An answer that says yes and holds no list (no body, or
 * another shape) is `failed` too: it is not an empty list, and reading a field of nothing threw.
 * A selector that throws on such a shape is `failed` as well: the screen offers to try again.
 */
export function listedOf<D, T>(answer: Answer<D>, pick: (data: D) => readonly T[]): readonly T[] | 'failed' {
  if (!answer.ok || typeof answer.data !== 'object' || answer.data === null) return 'failed';
  try {
    const list: unknown = pick(answer.data);

    return Array.isArray(list) ? (list as readonly T[]) : 'failed';
  } catch {
    // The selector read a list where the answer has another shape: `data.filter` of an object.
    return 'failed';
  }
}

/** The items of a list that was read, and none of one that was not. For a count that is drawn only when known. */
export function known<T>(list: Listed<T>): readonly T[] | undefined {
  return typeof list === 'string' ? undefined : list;
}

/**
 * A list changed by a gesture of this screen, an added or a removed row. A list that was not read
 * stays what it is: a row taken off nothing would read as « No site yet ».
 */
export function edited<T>(list: Listed<T>, edit: (items: readonly T[]) => readonly T[]): Listed<T> {
  return typeof list === 'string' ? list : edit(list);
}
