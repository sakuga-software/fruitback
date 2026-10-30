import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Team } from './api';
import { type TeamList, type TeamListEvent, offersMore, searchToAsk, stepTeamList, teamListOf } from './team-list.ts';

/**
 * The list of teams of a Linear in the destination picker (FRU-501), against a worker that answers as
 * the route does: pages of 50 teams with `next`, and a search of the first 50 teams whose name holds
 * the words. Each case crosses the shape of the list, the moment of a search, a « Try again » after an
 * error, and a slow answer that comes after a newer one.
 */

const team = (index: number, name = `Team ${index}`): Team => ({
  id: `t${index}`,
  name,
  key: `T${index}`,
  projects: [],
});

/** A Linear of `count` teams: the last one is « Payments », on the last page. */
function linear(count: number) {
  const teams = Array.from({ length: count }, (_, index) =>
    index === count - 1 ? team(index, 'Payments') : team(index),
  );

  return {
    page(after?: string): { teams: Team[]; next?: string } {
      const start = after === undefined ? 0 : Number(after);
      const next = start + 50 < teams.length ? String(start + 50) : undefined;

      return { teams: teams.slice(start, start + 50), ...(next === undefined ? {} : { next }) };
    },
    search(words: string): { teams: Team[] } {
      return { teams: teams.filter((each) => each.name.toLowerCase().includes(words.toLowerCase())).slice(0, 50) };
    },
  };
}

/** A team that only an answer the list must drop holds: it never reaches the list. */
const STALE = team(999, 'Stale answer');

/** What the picker shows of a list: its teams that hold the search, as `SearchChoice` filters them. */
const shown = (list: TeamList) =>
  list.items.filter((each) => each.name.toLowerCase().includes(list.query.toLowerCase())).map((each) => each.name);

type Shape = 'complete' | 'one full page, no next' | 'several pages';
type Moment = 'no search' | 'typed during a load' | 'typed after the last page';

const SHAPES: Record<Shape, number> = { complete: 5, 'one full page, no next': 50, 'several pages': 120 };

/**
 * Plays one case, as the picker would: `ask` and `answer` are the calls the component makes, with
 * the id of each request. Answers are given in the order the case says.
 */
function play(shape: Shape, moment: Moment, tryAgain: boolean, slow: boolean) {
  const worker = linear(SHAPES[shape]);
  let id = 0;
  let list = teamListOf(worker.page(), ++id);
  const apply = (event: TeamListEvent) => (list = stepTeamList(list, event));
  /** The searches the list asked the worker for. */
  const searches: string[] = [];
  /** Asks the worker for a search when the list says so, and answers it at once. */
  const searchIfAsked = () => {
    const words = searchToAsk(list);
    if (words === undefined) return;
    searches.push(words);
    const requestId = ++id;
    apply({ type: 'ask-search', requestId });
    apply({ type: 'answer', requestId, ...worker.search(words) });
  };

  if (tryAgain) {
    // A page that fails says so; « Try again » reads a new first page, and the failed list is gone.
    if (list.cursor !== null) {
      const failed = ++id;
      apply({ type: 'ask-page', requestId: failed });
      apply({ type: 'fail', requestId: failed });
      assert.equal(list.status, 'error');
      assert.equal(offersMore(list), true, 'the next page can be asked again');
    }
    const old = list.requestId;
    list = teamListOf(worker.page(), ++id, list.query);
    apply({ type: 'answer', requestId: old, teams: [STALE] });
    assert.equal(list.status, 'idle');
  }

  if (slow && list.cursor !== null) {
    // A page on its way, then a search that replaces it; the page answers while the search is still
    // on its way, and is dropped; then the search answers.
    const page = ++id;
    apply({ type: 'ask-page', requestId: page });
    apply({ type: 'type', query: 'pay' });
    const words = searchToAsk(list);
    assert.equal(words, 'pay');
    searches.push('pay');
    const search = ++id;
    apply({ type: 'ask-search', requestId: search });
    apply({ type: 'answer', requestId: page, teams: [STALE], next: 'nowhere' });
    assert.notEqual(list.cursor, 'nowhere');
    apply({ type: 'answer', requestId: search, ...worker.search('pay') });
    apply({ type: 'type', query: '' });
  } else if (slow) {
    // A complete list asks for nothing: any answer is one it did not wait for.
    apply({ type: 'answer', requestId: ++id, teams: [STALE] });
  }

  if (moment === 'typed during a load' && list.cursor !== null) {
    const page = ++id;
    apply({ type: 'ask-page', requestId: page });
    assert.equal(offersMore(list), false, 'no second page while one is on its way');
    apply({ type: 'type', query: 'pay' });
    searchIfAsked();
    apply({ type: 'answer', requestId: page, ...worker.page(list.cursor ?? undefined) });
  } else if (moment === 'typed during a load') {
    apply({ type: 'type', query: 'pay' });
    searchIfAsked();
  }
  if (moment === 'typed after the last page') {
    while (offersMore(list)) {
      const page = ++id;
      apply({ type: 'ask-page', requestId: page });
      apply({ type: 'answer', requestId: page, ...worker.page(list.cursor ?? undefined) });
    }
    assert.equal(list.cursor, null);
    apply({ type: 'type', query: 'pay' });
    searchIfAsked();
  }

  return { list, searches };
}

describe('the list of teams of a Linear, case by case (FRU-501)', () => {
  for (const shape of Object.keys(SHAPES) as Shape[]) {
    for (const moment of ['no search', 'typed during a load', 'typed after the last page'] as Moment[]) {
      for (const tryAgain of [false, true]) {
        for (const slow of [false, true]) {
          const name = `${shape} × ${moment} × ${tryAgain ? '« Try again » after an error' : 'no error'} × ${
            slow ? 'a slow answer after a newer one' : 'answers in order'
          }`;
          it(name, () => {
            const { list, searches } = play(shape, moment, tryAgain, slow);
            const ids = list.items.map((each) => each.id);

            assert.equal(new Set(ids).size, ids.length, 'each team once');
            assert.ok(!ids.includes(STALE.id), 'no answer the list did not wait for');
            assert.equal(list.status, 'idle');
            assert.equal(offersMore(list), list.cursor !== null && list.query === '');
            if (moment === 'no search') {
              assert.equal(list.query, '');
              assert.equal(shown(list).length, list.items.length);
              return;
            }
            // A search finds Payments, wherever it is; the worker is asked only while a page is missing.
            assert.deepEqual(shown(list), ['Payments']);
            if (moment === 'typed after the last page') {
              const asked = slow && SHAPES[shape] > 50 ? ['pay'] : [];
              assert.deepEqual(searches, asked, 'a complete list filters what it holds');
            }
            if (SHAPES[shape] <= 50) assert.deepEqual(searches, [], 'a list with no next page never asks the worker');
            assert.equal(searchToAsk(list), undefined, 'each words asked once');
          });
        }
      }
    }
  }
});

describe('the list of teams of a Linear, one rule at a time (FRU-501)', () => {
  it('asks the worker once for each words, and again for new words', () => {
    let list = teamListOf({ teams: [team(1)], next: '50' }, 1);
    list = stepTeamList(list, { type: 'type', query: ' pay ' });
    assert.equal(searchToAsk(list), 'pay');
    list = stepTeamList(list, { type: 'ask-search', requestId: 2 });
    assert.equal(searchToAsk(list), undefined);
    list = stepTeamList(list, { type: 'type', query: 'pays' });
    assert.equal(searchToAsk(list), 'pays');
  });

  it('a first page that comes after the search was typed takes the search, and asks for it once', () => {
    // The picker builds the list with the words typed by the time the first page answers.
    const list = teamListOf({ teams: [team(1)], next: '50' }, 1, ' pay ');
    assert.equal(list.query, 'pay');
    assert.equal(searchToAsk(list), 'pay');
    assert.equal(offersMore(list), false, 'no next page while a search is typed');
    // A complete first page filters what it holds, with no request.
    assert.equal(searchToAsk(teamListOf({ teams: [team(1)] }, 2, 'pay')), undefined);
  });

  it('keeps an error until the person types again or asks again, and asks nothing on its own', () => {
    let list = teamListOf({ teams: [team(1)], next: '50' }, 1);
    list = stepTeamList(list, { type: 'type', query: 'pay' });
    list = stepTeamList(list, { type: 'ask-search', requestId: 2 });
    list = stepTeamList(list, { type: 'fail', requestId: 2 });
    assert.equal(list.status, 'error');
    assert.equal(searchToAsk(list), undefined, 'a failed search is not asked again by itself');
    list = stepTeamList(list, { type: 'type', query: 'paym' });
    assert.equal(list.status, 'idle');
    assert.equal(searchToAsk(list), 'paym');
  });

  it('a search moves no cursor: the pages go on where they were', () => {
    let list = teamListOf({ teams: [team(1)], next: '50' }, 1);
    list = stepTeamList(list, { type: 'type', query: 'pay' });
    list = stepTeamList(list, { type: 'ask-search', requestId: 2 });
    list = stepTeamList(list, { type: 'answer', requestId: 2, teams: [team(120, 'Payments')], next: '50-of-search' });
    assert.equal(list.cursor, '50');
    list = stepTeamList(list, { type: 'type', query: '' });
    assert.equal(offersMore(list), true);
  });

  it('the control: an answer with the id the list waits for is taken', () => {
    let list = teamListOf({ teams: [team(1)], next: '50' }, 1);
    list = stepTeamList(list, { type: 'ask-page', requestId: 7 });
    list = stepTeamList(list, { type: 'answer', requestId: 7, teams: [team(2)] });
    assert.deepEqual(
      list.items.map((each) => each.id),
      ['t1', 't2'],
    );
    assert.equal(list.cursor, null);
  });
});
