import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { SEED_STAGES } from '@fruitback/shared';
import { type SiteStatus, envelopeStatuses, isBuiltIn, originOf, readSiteStatus } from './site-statuses.ts';

/** What the console of FRU-366 may write for one status of a site (FRU-365). */

const REVIEW = {
  source: 'con_linear',
  key: '6f1c2d3e-0a1b-4c5d-8e9f-a0b1c2d3e4f5',
  name: 'In Review',
  stage: 'progress',
  color: '#7dd3fc',
  textColor: '#18181b',
  position: 3,
  origin: 'tracker',
  hidden: false,
};

describe('a status of a site, as a write holds it (FRU-365)', () => {
  it('reads a status as the console sends it', () => {
    assert.deepEqual(readSiteStatus(REVIEW), { ok: true, status: REVIEW });
  });

  it('reads a status of the worker with only what it must have, and the rest as the table defaults it', () => {
    assert.deepEqual(readSiteStatus({ source: 'own', key: 'closed:completed', stage: 'done' }), {
      ok: true,
      status: {
        source: 'own',
        key: 'closed:completed',
        name: null,
        stage: 'done',
        color: null,
        textColor: null,
        position: 0,
        origin: 'tracker',
        hidden: false,
      },
    });
  });

  it('keeps an empty name as no name: the name of the tracker', () => {
    const read = readSiteStatus({ ...REVIEW, name: '' });

    assert.equal(read.ok && read.status.name, null);
  });

  it('refuses a text colour under 4.5:1 on its background, and keeps one at 4.5:1', () => {
    // #a52a3a under #ffaaaa: 3.87:1, the refused line of the sketch in statuses.md.
    assert.deepEqual(readSiteStatus({ ...REVIEW, color: '#a52a3a', textColor: '#ffaaaa' }), {
      ok: false,
      refusal: 'text-under-contrast',
    });
    // The ink #18181b on #5385ae: 4.50007:1, just over the line; white there is 3.94:1.
    assert.equal(readSiteStatus({ ...REVIEW, color: '#5385ae', textColor: '#18181b' }).ok, true);
    assert.equal(readSiteStatus({ ...REVIEW, color: '#5385ae', textColor: '#ffffff' }).ok, false);
    // #767676 under white: 4.54:1; #777777 under white: 4.48:1.
    assert.equal(readSiteStatus({ ...REVIEW, color: '#767676', textColor: '#ffffff' }).ok, true);
    assert.deepEqual(readSiteStatus({ ...REVIEW, color: '#777777', textColor: '#ffffff' }), {
      ok: false,
      refusal: 'text-under-contrast',
    });
  });

  it('refuses a text colour with no background to be read on', () => {
    assert.deepEqual(readSiteStatus({ ...REVIEW, color: null }), { ok: false, refusal: 'text-without-color' });
  });

  it('refuses each field that is not what the table keeps, and names it', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ source: '' }, 'invalid-source'],
      [{ source: 'con linear' }, 'invalid-source'],
      [{ source: 'c'.repeat(65) }, 'invalid-source'],
      [{ source: 7 }, 'invalid-source'],
      [{ key: '' }, 'invalid-key'],
      [{ key: 'in review' }, 'invalid-key'],
      [{ key: 'k'.repeat(65) }, 'invalid-key'],
      [{ name: 'n'.repeat(201) }, 'invalid-name'],
      [{ name: 3 }, 'invalid-name'],
      [{ stage: 'blue' }, 'invalid-stage'],
      [{ stage: undefined }, 'invalid-stage'],
      [{ color: 'red' }, 'invalid-color'],
      [{ color: '#fff' }, 'invalid-color'],
      [{ color: 'var(--fruitback-stage-done)' }, 'invalid-color'],
      [{ color: 'x#7dd3fc' }, 'invalid-color'],
      [{ textColor: 'black' }, 'invalid-color'],
      [{ textColor: 0 }, 'invalid-color'],
      [{ position: -1 }, 'invalid-position'],
      [{ position: 1.5 }, 'invalid-position'],
      [{ position: '1' }, 'invalid-position'],
      [{ origin: 'console' }, 'invalid-origin'],
      [{ hidden: 'false' }, 'invalid-hidden'],
    ];
    for (const [change, refusal] of cases) {
      assert.deepEqual(readSiteStatus({ ...REVIEW, ...change }), { ok: false, refusal }, JSON.stringify(change));
    }
    // The longest of each still passes: the bounds are where they are said to be.
    for (const change of [
      { source: 'c'.repeat(64) },
      { key: 'k'.repeat(64) },
      { name: 'n'.repeat(200) },
      { origin: 'team' },
    ]) {
      assert.equal(readSiteStatus({ ...REVIEW, ...change }).ok, true, JSON.stringify(change));
    }
  });

  it('refuses what is not an object', () => {
    for (const value of [null, undefined, 'In Review', [REVIEW], 3]) {
      assert.deepEqual(readSiteStatus(value), { ok: false, refusal: 'not-a-status' }, String(value));
    }
  });
});

describe('the built-in statuses, the origin, and the statuses of a read (FRU-366)', () => {
  const [first, , , done] = SEED_STAGES;

  it('calls built-in a status of the worker store whose key is a stage, and nothing else', () => {
    assert.equal(isBuiltIn('own', done as string), true);
    assert.equal(isBuiltIn('own', 'waiting'), false);
    assert.equal(isBuiltIn('con_linear', done as string), false, 'a state of a tracker is never built in');
  });

  it('gives the origin from the source and the key, never from the request', () => {
    assert.equal(originOf('own', 'waiting'), 'team');
    assert.equal(originOf('own', first as string), 'tracker');
    assert.equal(originOf('con_linear', 'st_1'), 'tracker');
  });

  it('lists the rows of a site first, each with a text colour, then the built-in statuses no row changed', () => {
    const row = (more: Partial<SiteStatus>): SiteStatus => ({
      source: 'own',
      key: 'waiting',
      name: null,
      stage: first as SiteStatus['stage'],
      color: null,
      textColor: null,
      position: 0,
      origin: 'team',
      hidden: false,
      ...more,
    });
    const listed = envelopeStatuses([
      row({ name: 'Waiting', color: '#5560c4' }),
      row({ source: 'con_linear', key: 'st_1', color: '#f3bb3d', textColor: '#000000', origin: 'tracker' }),
      row({ key: done as string, name: 'Shipped', stage: done as SiteStatus['stage'], origin: 'tracker' }),
    ]);

    assert.deepEqual(listed.slice(0, 3), [
      // No text colour: the one readableTextColor gives, white on #5560c4.
      { key: 'own:waiting', name: 'Waiting', stage: first, color: '#5560c4', textColor: '#ffffff' },
      // A text colour the team chose is kept.
      { key: 'con_linear:st_1', name: '', stage: first, color: '#f3bb3d', textColor: '#000000' },
      // No colour: no text colour either, the widget draws the stage.
      { key: `own:${done}`, name: 'Shipped', stage: done },
    ]);
    assert.deepEqual(
      listed.slice(3).map((status) => status.key),
      SEED_STAGES.filter((stage) => stage !== done).map((stage) => `own:${stage}`),
    );
    assert.deepEqual(
      envelopeStatuses([]),
      SEED_STAGES.map((stage) => ({ key: `own:${stage}`, name: '', stage })),
    );
  });
});

describe('the states of a tracker in the statuses of a read (FRU-368)', () => {
  const STATES = [
    { id: 'state_backlog', name: 'Backlog', stage: 'new' as const, color: '#bec2c8' },
    { id: 'state_done', name: 'Done', stage: 'done' as const, color: '#5e6ad2' },
    { id: 'state_odd', name: 'Odd', stage: 'todo' as const },
  ];
  const row = (fields: Partial<SiteStatus> & Pick<SiteStatus, 'key' | 'stage'>): SiteStatus => ({
    source: 'con_linear',
    name: null,
    color: null,
    textColor: null,
    position: 0,
    origin: 'tracker',
    hidden: false,
    ...fields,
  });
  const tracked = (statuses: ReturnType<typeof envelopeStatuses>) =>
    statuses.filter((status) => status.key.startsWith('con_linear:'));

  it('lists each state under its connector, with its name and stage, and the colour of its stage by default', () => {
    assert.deepEqual(tracked(envelopeStatuses([], [{ source: 'con_linear', states: STATES }])), [
      { key: 'con_linear:state_backlog', name: 'Backlog', stage: 'new' },
      { key: 'con_linear:state_done', name: 'Done', stage: 'done' },
      { key: 'con_linear:state_odd', name: 'Odd', stage: 'todo' },
    ]);
  });

  it("takes the tracker's colours when the site asks, with a text that reads on them", () => {
    assert.deepEqual(tracked(envelopeStatuses([], [{ source: 'con_linear', states: STATES }], true)), [
      { key: 'con_linear:state_backlog', name: 'Backlog', stage: 'new', color: '#bec2c8', textColor: '#18181b' },
      // Linear's Done: white, 4.70:1 (statuses.md, « The colours »).
      { key: 'con_linear:state_done', name: 'Done', stage: 'done', color: '#5e6ad2', textColor: '#ffffff' },
      // A state with no colour of its own keeps the colour of its stage.
      { key: 'con_linear:state_odd', name: 'Odd', stage: 'todo' },
    ]);
  });

  it('gives the row of the site the last word, at its place, and keeps a row of a state that is gone', () => {
    const rows = [
      row({ key: 'state_done', name: 'Shipped', stage: 'closed', color: '#a52a3a', position: 0 }),
      row({ key: 'state_backlog', stage: 'todo', position: 1 }),
      row({ key: 'state_gone', name: 'Gone', stage: 'todo', position: 2 }),
    ];

    assert.deepEqual(tracked(envelopeStatuses(rows, [{ source: 'con_linear', states: STATES }], true)), [
      { key: 'con_linear:state_gone', name: 'Gone', stage: 'todo' },
      { key: 'con_linear:state_done', name: 'Shipped', stage: 'closed', color: '#a52a3a', textColor: '#ffffff' },
      // A row with no colour of its own takes the tracker's, since the site asked for it.
      { key: 'con_linear:state_backlog', name: 'Backlog', stage: 'todo', color: '#bec2c8', textColor: '#18181b' },
      { key: 'con_linear:state_odd', name: 'Odd', stage: 'todo' },
    ]);
  });

  it('still says the five built-in statuses, and no state of a tracker that did not answer', () => {
    const statuses = envelopeStatuses([row({ key: 'state_done', stage: 'done' })], []);

    assert.deepEqual(
      statuses.map((status) => status.key),
      ['con_linear:state_done', ...SEED_STAGES.map((stage) => `own:${stage}`)],
    );
  });
});
