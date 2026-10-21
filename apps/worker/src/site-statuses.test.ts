import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { readSiteStatus } from './site-statuses.ts';

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
