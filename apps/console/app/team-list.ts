import type { Team } from './api';

/**
 * The teams of one Linear in the destination picker (FRU-501), as one state that each answer of the
 * worker moves on: the teams read so far, the cursor of the next page, the search, and the one request
 * the list waits for.
 *
 * - **One request at a time.** Each request has an id; an answer to any other id is dropped: a slow
 *   answer that a newer request replaced, or an answer for a list that « Try again » replaced.
 * - **A search asks the worker while the list is not complete**, and only once for each words. Once
 *   every team is read (`cursor` is `null`), the console filters what it holds.
 * - **« More teams » shows while there is a next page and no search**, and no page is on its way.
 */
export type TeamList = {
  /** Every team read so far, each once: the pages, then what the searches found. */
  items: readonly Team[];
  /** Where the next page starts; `null` once Linear said there is no other team. */
  cursor: string | null;
  /** The words of the search, trimmed: `''` for no search. */
  query: string;
  /** The words the worker was last asked for, or `null`. */
  searched: string | null;
  status: 'idle' | 'loading-page' | 'searching' | 'error';
  /** The request this list waits for. */
  requestId: number;
};

export type TeamListEvent =
  | { type: 'ask-page'; requestId: number }
  | { type: 'ask-search'; requestId: number }
  | { type: 'type'; query: string }
  | { type: 'answer'; requestId: number; teams: readonly Team[]; next?: string | undefined }
  | { type: 'fail'; requestId: number };

/** The list of a first page that answered `requestId`, with the search typed so far. */
export function teamListOf(
  first: { teams?: readonly Team[] | undefined; next?: string | undefined },
  requestId: number,
  query = '',
): TeamList {
  return {
    items: withTeams([], first.teams ?? []),
    cursor: first.next ?? null,
    query: query.trim(),
    searched: null,
    status: 'idle',
    requestId,
  };
}

export function stepTeamList(list: TeamList, event: TeamListEvent): TeamList {
  switch (event.type) {
    case 'ask-page':
      return list.cursor === null ? list : { ...list, status: 'loading-page', requestId: event.requestId };
    case 'ask-search':
      return { ...list, status: 'searching', searched: list.query, requestId: event.requestId };
    case 'type': {
      const query = event.query.trim();

      return { ...list, query, status: list.status === 'error' ? 'idle' : list.status };
    }
    case 'answer': {
      if (event.requestId !== list.requestId || (list.status !== 'loading-page' && list.status !== 'searching')) {
        return list;
      }
      const items = withTeams(list.items, event.teams);
      // A page moves the cursor on; a search leaves it where the pages are.
      const cursor = list.status === 'loading-page' ? (event.next ?? null) : list.cursor;

      return { ...list, items, cursor, status: 'idle' };
    }
    case 'fail':
      return event.requestId === list.requestId ? { ...list, status: 'error' } : list;
  }
}

/** The words to ask the worker for now, or `undefined`: a search on a list that is not complete, asked once. */
export function searchToAsk(list: TeamList): string | undefined {
  return list.query !== '' && list.cursor !== null && list.searched !== list.query ? list.query : undefined;
}

/** Whether the list offers « More teams »: a next page, no search, and no page on its way. */
export function offersMore(list: TeamList): boolean {
  return list.cursor !== null && list.query === '' && list.status !== 'loading-page';
}

/** These teams added to the list, each id once, in the order they came. */
function withTeams(items: readonly Team[], teams: readonly Team[]): Team[] {
  const known = new Set(items.map((team) => team.id));
  const added = teams.filter((team) => {
    if (known.has(team.id)) return false;
    known.add(team.id);

    return true;
  });

  return [...items, ...added];
}
