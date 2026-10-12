import type { Answer } from './api.ts';

/**
 * A list a screen read from the worker (FRU-162).
 *
 * **No list is not an empty list.** `loading`: no answer yet. `failed`: the worker refused, or did
 * not answer. Only an answer that holds a list is a list, so only that one may show the empty state.
 * A screen that drew `[]` for a failed read said « No site yet » during an outage.
 */
export type Listed<T> = readonly T[] | 'loading' | 'failed';

/** The list an answer holds, or `failed`. */
export function listedOf<D, T>(answer: Answer<D>, pick: (data: D) => readonly T[]): readonly T[] | 'failed' {
  return answer.ok ? pick(answer.data) : 'failed';
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
