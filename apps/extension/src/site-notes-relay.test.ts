import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessResult } from './session.ts';
import { PAGE_EXCERPT_MAX, createSiteNotesRelay, excerptAtMost } from './site-notes-relay.ts';
import type { SiteConfig } from './sites.ts';
import { parseBridgeMessage, parsePageSiteRead } from './protocol.ts';

/**
 * « All pages » of the widget the extension mounts (FRU-470): what the background reads for the page,
 * and everything it refuses. The page can post this request itself, so each refusal is a test.
 */

const ENDPOINT = 'https://feedback.acme.dev';
const ORIGIN = 'https://staging.acme.dev';
const grant = (token: string): AccessResult => ({ ok: true, grant: { accessToken: token, expiresAt: 0 } as never });
const TEAM: SiteConfig = { endpoint: ENDPOINT, enabled: true, mode: 'team', mount: { clientId: 'site_1' } };

const BODY = {
  notes: [
    {
      note: 'sd_1',
      excerpt: 'The Add button is almost invisible.',
      page: { url: `${ORIGIN}/cart`, path: '/cart' },
      stage: 'progress',
      author: { kind: 'you', name: 'Camille' },
      reference: 'FRU-128',
      referenceUrl: 'https://linear.app/acme/issue/FRU-128',
      createdAt: '2026-10-18T12:00:00.000Z',
    },
  ],
  total: 3,
  next: 'cursor-2',
};

function relayFor(site: SiteConfig | undefined, answers: { status: number; body?: unknown }[] = []) {
  const asked: { url: string; auth: string | null }[] = [];
  const read: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    asked.push({ url, auth: new Headers(init?.headers).get('Authorization') });
    const answer = answers.shift() ?? { status: 500 };

    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  const relay = createSiteNotesRelay({
    readSite: async (origin) => {
      read.push(origin);

      return site;
    },
    ensureAccess: async () => grant('t1'),
    fetcher,
  });

  return { relay, asked, read };
}

describe('the notes of every page, for the widget the extension mounts (FRU-470)', () => {
  it('reads the site of the entry of the origin, with the words and the cursor of the page, and the session', async () => {
    const { relay, asked, read } = relayFor(TEAM, [{ status: 200, body: BODY }]);

    const answer = await relay({ q: 'add', cursor: 'c1' }, ORIGIN);

    assert.deepEqual(read, [ORIGIN]);
    assert.equal(asked[0]?.url, `${ENDPOINT}/session/notes?site=site_1&limit=50&q=add&cursor=c1`);
    assert.equal(asked[0]?.auth, 'Bearer t1');
    // The link to the tracker and « mine » stay in the side panel: the page never holds them.
    assert.deepEqual(answer, {
      ok: true,
      notes: [
        {
          note: 'sd_1',
          excerpt: 'The Add button is almost invisible.',
          page: { url: `${ORIGIN}/cart`, path: '/cart' },
          stage: 'progress',
          author: 'Camille',
          reference: 'FRU-128',
          createdAt: '2026-10-18T12:00:00.000Z',
        },
      ],
      total: 3,
      next: 'cursor-2',
    });
  });

  it('reads nothing for a sender with no origin, no entry, an entry off, private, not mounted, or on http', async () => {
    const refused: (SiteConfig | undefined)[] = [
      undefined,
      { ...TEAM, enabled: false },
      { endpoint: ENDPOINT, enabled: true, mode: 'private', clientId: 'site_1' },
      { endpoint: ENDPOINT, enabled: true, mode: 'team' },
      { ...TEAM, endpoint: 'http://feedback.acme.dev' },
    ];
    for (const site of refused) {
      const { relay, asked } = relayFor(site, [{ status: 200, body: BODY }]);
      assert.deepEqual(await relay({}, ORIGIN), { ok: false, reason: 'unavailable' }, JSON.stringify(site));
      assert.equal(asked.length, 0, `asked the worker for ${JSON.stringify(site)}`);
    }
    const { relay, read } = relayFor(TEAM);
    assert.deepEqual(await relay({}, undefined), { ok: false, reason: 'unavailable' });
    assert.deepEqual(read, [], 'the origin comes from the sender only');
  });

  it('gives the page an excerpt of 64 code points at most, whatever the worker sent (review of #645)', async () => {
    const long = `${'é'.repeat(70)} and more`;
    const body = { ...BODY, notes: [{ ...BODY.notes[0], excerpt: long }] };
    const answer = await relayFor(TEAM, [{ status: 200, body }]).relay({}, ORIGIN);

    assert.ok(answer.ok);
    assert.equal([...(answer.notes[0]?.excerpt ?? '')].length, PAGE_EXCERPT_MAX);
    // Between two graphemes: a family of four people is kept whole or not at all.
    const family = '👨‍👩‍👧‍👦';
    assert.equal(excerptAtMost(`${'a'.repeat(60)}${family}`), 'a'.repeat(60));
    assert.equal(excerptAtMost('short'), 'short');
  });

  it('says a session that ended, and a worker that did not answer', async () => {
    assert.deepEqual(await relayFor(TEAM, [{ status: 401 }]).relay({}, ORIGIN), { ok: false, reason: 'signed-out' });
    assert.deepEqual(await relayFor(TEAM, [{ status: 500 }]).relay({}, ORIGIN), { ok: false, reason: 'failed' });
  });

  it('answers even when the storage throws', async () => {
    const relay = createSiteNotesRelay({
      readSite: async () => {
        throw new Error('storage');
      },
      ensureAccess: async () => grant('t1'),
    });

    assert.deepEqual(await relay({}, ORIGIN), { ok: false, reason: 'failed' });
  });
});

describe('the messages of « All pages » on the bridge (FRU-470)', () => {
  it('carries the words and the cursor of the page, and nothing else', () => {
    assert.deepEqual(
      parseBridgeMessage({
        channel: 'fruitback-extension/2',
        kind: 'site-notes-request',
        id: 'r1',
        query: { q: 'add', cursor: 'c1', site: 'someone-else', endpoint: 'https://evil.test' },
      }),
      { channel: 'fruitback-extension/2', kind: 'site-notes-request', id: 'r1', query: { q: 'add', cursor: 'c1' } },
    );
    assert.equal(
      parseBridgeMessage({ channel: 'fruitback-extension/2', kind: 'site-notes-request', id: 'r1', query: { q: 3 } }),
      undefined,
    );
    assert.equal(
      parseBridgeMessage({
        channel: 'fruitback-extension/2',
        kind: 'site-notes-request',
        id: 'r1',
        query: { q: 'x'.repeat(201) },
      }),
      undefined,
    );
  });

  it('rebuilds an answer field by field: a bad note costs that note, a bad answer is none', () => {
    const good = {
      note: 'sd_1',
      excerpt: 'Words',
      page: { url: `${ORIGIN}/`, path: '/' },
      stage: 'new',
      createdAt: '2026-10-18T12:00:00.000Z',
      token: 'never',
    };
    assert.deepEqual(parsePageSiteRead({ ok: true, notes: [good, { note: 'x' }], total: 2 }), {
      ok: true,
      notes: [
        {
          note: 'sd_1',
          excerpt: 'Words',
          page: { url: `${ORIGIN}/`, path: '/' },
          stage: 'new',
          createdAt: good.createdAt,
        },
      ],
      total: 2,
    });
    assert.deepEqual(parsePageSiteRead({ ok: false, reason: 'signed-out' }), { ok: false, reason: 'signed-out' });
    assert.equal(parsePageSiteRead({ ok: false, reason: 'teapot' }), undefined);
    assert.equal(parsePageSiteRead({ ok: true, notes: 'no', total: 1 }), undefined);
    assert.equal(parsePageSiteRead(undefined), undefined);
  });
});
