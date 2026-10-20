import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessResult } from './session.ts';
import { SITE_PAGE_SIZE, parseSitePage, readSiteNotes, siteNotesUrl } from './site-notes.ts';

/**
 * The read of the notes of a whole site (FRU-307), from `GET /session/notes` of the worker
 * (FRU-306): the address, the token, the renewal of an old token, and what each answer says.
 */

const ENDPOINT = 'https://feedback.acme.dev';
const grant = (token: string): AccessResult => ({ ok: true, grant: { accessToken: token, expiresAt: 0 } as never });

const BODY = {
  notes: [
    {
      seed: 'sd_1',
      excerpt: 'The Add button is almost invisible.',
      page: { url: 'https://staging.acme.dev/', path: '/' },
      stage: 'ripening',
      author: { kind: 'you', name: 'Camille' },
      reference: 'FRU-128',
      referenceUrl: 'https://linear.app/acme/issue/FRU-128',
      createdAt: '2026-10-18T12:00:00.000Z',
    },
  ],
  total: 1,
  searched: ['excerpt'],
};

function fetcher(answers: { status: number; body?: unknown }[]) {
  const asked: { url: string; auth: string | null }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    asked.push({ url, auth: new Headers(init?.headers).get('Authorization') });
    const answer = answers.shift() ?? { status: 500 };

    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;

  return { fake, asked };
}

describe('the read of the notes of a whole site (FRU-307)', () => {
  it('asks one page of the site, with the words, and the token of the session', async () => {
    const { fake, asked } = fetcher([{ status: 200, body: BODY }]);

    const read = await readSiteNotes(
      ENDPOINT,
      { site: 'site_1', q: '  add button ' },
      { ensureAccess: async () => grant('t1'), fetcher: fake },
    );

    assert.ok(read.ok);
    assert.equal(asked[0]?.url, `${ENDPOINT}/session/notes?site=site_1&limit=${SITE_PAGE_SIZE}&q=add+button`);
    assert.equal(asked[0]?.auth, 'Bearer t1');
    assert.deepEqual(read.page.notes[0], {
      seed: 'sd_1',
      excerpt: 'The Add button is almost invisible.',
      page: { url: 'https://staging.acme.dev/', path: '/' },
      stage: 'ripening',
      author: 'Camille',
      mine: true,
      reference: 'FRU-128',
      referenceUrl: 'https://linear.app/acme/issue/FRU-128',
      createdAt: '2026-10-18T12:00:00.000Z',
    });
  });

  it('renews a token the worker refused once, then asks again', async () => {
    const { fake, asked } = fetcher([{ status: 401 }, { status: 200, body: BODY }]);
    const renewed: string[] = [];

    const read = await readSiteNotes(
      ENDPOINT,
      { site: 'site_1', cursor: 'abc' },
      {
        ensureAccess: async () => grant('old'),
        renewAccess: async (_endpoint, refused) => {
          renewed.push(refused);
          return grant('new');
        },
        fetcher: fake,
      },
    );

    assert.ok(read.ok);
    assert.deepEqual(renewed, ['old']);
    assert.deepEqual(
      asked.map((each) => each.auth),
      ['Bearer old', 'Bearer new'],
    );
    assert.match(asked[1]?.url ?? '', /cursor=abc/);
  });

  it('says signed-out for a session that ended, unavailable for a worker or a site with no list, failed otherwise', async () => {
    const ask = (answers: { status: number; body?: unknown }[], access: AccessResult = grant('t')) =>
      readSiteNotes(ENDPOINT, { site: 's' }, { ensureAccess: async () => access, fetcher: fetcher(answers).fake });

    assert.deepEqual(await ask([{ status: 401 }]), { ok: false, reason: 'signed-out' });
    assert.deepEqual(await ask([], { ok: false, reason: 'session-revoked-or-expired' }), {
      ok: false,
      reason: 'signed-out',
    });
    assert.deepEqual(await ask([], { ok: false, reason: 'not-paired' }), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await ask([{ status: 404 }]), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await ask([{ status: 503 }]), { ok: false, reason: 'failed' });
    assert.deepEqual(await ask([], { ok: false, reason: 'unavailable' }), { ok: false, reason: 'failed' });
    assert.deepEqual(await ask([{ status: 200, body: { nope: true } }]), { ok: false, reason: 'failed' });
    const thrown = await readSiteNotes(
      ENDPOINT,
      { site: 's' },
      { ensureAccess: async () => grant('t'), fetcher: (async () => Promise.reject(new Error('offline'))) as never },
    );
    assert.deepEqual(thrown, { ok: false, reason: 'failed' });
  });

  it('drops a note that is not well formed, and never keeps an address that is not http', () => {
    const page = parseSitePage({
      total: 3,
      next: 'n1',
      notes: [
        BODY.notes[0],
        { ...BODY.notes[0], seed: 'sd_2', page: { url: 'javascript:alert(1)', path: '/' } },
        { ...BODY.notes[0], seed: 'sd_3', stage: 'rotten' },
        { ...BODY.notes[0], seed: 'sd_4', referenceUrl: 'javascript:alert(1)', author: { kind: 'anonymous' } },
      ],
    });

    assert.deepEqual(
      page?.notes.map((note) => note.seed),
      ['sd_1', 'sd_4'],
    );
    assert.equal(page?.notes[1]?.referenceUrl, undefined);
    assert.equal(page?.notes[1]?.author, undefined);
    assert.equal(page?.next, 'n1');
    assert.equal(parseSitePage({ notes: [], total: -1 }), undefined);
  });

  it('builds the address with no words when the search is blank', () => {
    assert.equal(
      siteNotesUrl(ENDPOINT, { site: 'a', q: '   ' }),
      `${ENDPOINT}/session/notes?site=a&limit=${SITE_PAGE_SIZE}`,
    );
  });
});
