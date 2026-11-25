import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UNREACHABLE } from './api.ts';
import { edited, known, listedOf } from './listed.ts';

describe('a list read from the worker (FRU-162)', () => {
  const sites = (data: { sites: string[] }) => data.sites;

  it('is failed when the worker refused or did not answer, never empty', () => {
    assert.equal(listedOf({ ok: false, status: 503, error: 'store-unavailable' }, sites), 'failed');
    assert.equal(listedOf({ ok: false, status: 401, error: 'unauthenticated' }, sites), 'failed');
    assert.equal(listedOf(UNREACHABLE, sites), 'failed');
  });

  it('is empty only when the worker answered an empty list: the control', () => {
    assert.deepEqual(listedOf({ ok: true, data: { sites: [] } }, sites), []);
    assert.deepEqual(listedOf({ ok: true, data: { sites: ['a'] } }, sites), ['a']);
  });

  it('is failed for an answer that says yes and holds no list', () => {
    assert.equal(listedOf({ ok: true, data: undefined as unknown as { sites: string[] } }, sites), 'failed');
    assert.equal(listedOf({ ok: true, data: {} as { sites: string[] } }, sites), 'failed');
    // A selector written for a list, on an answer that is an object: it throws, and that is `failed`.
    const pending = (data: { status: string }[]) => data.filter((each) => each.status === 'pending');
    assert.equal(listedOf({ ok: true, data: {} as { status: string }[] }, pending), 'failed');
  });

  it('has no items to count while it is loading or failed', () => {
    assert.equal(known('loading'), undefined);
    assert.equal(known('failed'), undefined);
    assert.deepEqual(known([]), []);
  });

  it('stays not read when a row is removed from it or added to it', () => {
    const remove = (items: readonly string[]) => items.filter((item) => item !== 'a');

    assert.equal(edited('failed', remove), 'failed');
    assert.equal(edited('loading', remove), 'loading');
    assert.deepEqual(edited(['a', 'b'], remove), ['b']);
  });
});

describe('a screen that reads a list (FRU-162)', () => {
  /** A refused answer that becomes an empty list in the state of a screen: `if (!answer.ok) return setX([])`. */
  const EMPTY_FOR_A_FAILURE = /!\w+\.ok\)[^;\n]*set\w+\(\[\]\)/;
  // The screens, and their parts (FRU-614).
  const folders = ['./routes/', './parts/'].map((folder) => new URL(folder, import.meta.url));
  /** The setters of a state that starts as an empty list: `const [x, setX] = useState<T[]>([])`. */
  const EMPTY_AT_FIRST = /const \[\w+, (set\w+)\] = useState(?:<[^>]*>)?\(\[\]\)/g;
  /**
   * FRU-675: a refused answer that leaves such a state as it was, empty, with nothing said.
   * `if (!answer.ok) return;` before its setter (the members of the menu of a task before FRU-673),
   * and `if (answer.ok) setX(…)` with nothing for a refusal (its labels before FRU-675).
   */
  const KEPT_EMPTY = [/if \(!\w+\.ok\) return;\s*(set\w+)\(/g, /if \(\w+\.ok\) (set\w+)\(/g];
  /** The setters of a state that starts empty, that a failed answer leaves so. */
  const keptEmpty = (source: string): string[] => {
    const empty = new Set([...source.matchAll(EMPTY_AT_FIRST)].map((found) => found[1]));

    return KEPT_EMPTY.flatMap((form) => [...source.matchAll(form)].map((found) => found[1] ?? '')).filter((setter) =>
      empty.has(setter),
    );
  };
  it('never keeps an empty list for an answer that failed', () => {
    const found = folders.flatMap((folder) =>
      readdirSync(folder).filter((name) => EMPTY_FOR_A_FAILURE.test(readFileSync(new URL(name, folder), 'utf8'))),
    );

    assert.deepEqual(found, []);
  });

  it('never leaves a list that starts empty as it is for an answer that failed (FRU-675)', () => {
    const found = folders.flatMap((folder) =>
      readdirSync(folder).flatMap((name) =>
        keptEmpty(readFileSync(new URL(name, folder), 'utf8')).map((setter) => `${name} ${setter}`),
      ),
    );

    // FRU-682 fixed the last known case, the connectors of the screen of the notes.
    assert.deepEqual(found, []);
  });

  it('finds the two forms it looks for: the control (FRU-675)', () => {
    // The members of the menu of a task before FRU-673, and its labels before FRU-675.
    const members = `const [people, setPeople] = useState<TaskPerson[]>([]);
      if (!answer.ok) return;
      setPeople(answer.data.members);`;
    const labels = `const [labels, setLabels] = useState<TaskLabel[]>([]);
      if (answer.ok) setLabels(answer.data.labels);`;
    assert.deepEqual(keptEmpty(members), ['setPeople']);
    assert.deepEqual(keptEmpty(labels), ['setLabels']);
    // A state that does not start as an empty list, or a list that says its failure: not this defect.
    assert.deepEqual(keptEmpty(`const [x, setX] = useState('loading');\n if (answer.ok) setX(answer.data);`), []);
    assert.deepEqual(
      keptEmpty(`const [labels, setLabels] = useState<Listed<TaskLabel>>('loading');
      setLabels(listedOf(answer, (data) => data.labels));`),
      [],
    );
  });

  it('finds the line it looks for: the control', () => {
    // The line of the panel of a connector before it was a `Listed`: a failed read of the states read
    // as « no site sends here yet ».
    assert.match('      if (!answer.ok) return setStates([]);', EMPTY_FOR_A_FAILURE);
    assert.doesNotMatch('      setStates(listedOf(answer, (data) => data.states));', EMPTY_FOR_A_FAILURE);
  });
});
