import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccessResult } from './session.ts';
import { issueOf, sendSiteVerdict } from './site-check.ts';

/**
 * A verdict on a note of another page, from the side panel (FRU-734): the read of its page gives the
 * id of its issue, then the verdict goes to `POST /feedback/<issue>/check`, both with the session.
 */

const WORKER = 'https://api.acme.dev';
const grant = (token: string): AccessResult => ({ ok: true, grant: { accessToken: token, expiresAt: 0 } as never });
const QUERY = { site: 'site_1', url: 'https://staging.acme.dev/about', note: 'sd_far', verdict: 'fixed' } as const;
const READ = {
  issues: [
    { id: 'other-issue', note: { id: 'sd_other' } },
    { id: 'iss_42', note: { id: 'sd_far' } },
  ],
};

type Seen = { url: string; method: string; auth: string | null; body?: string };

function worker(answers: ((seen: Seen) => Response)[]) {
  const seen: Seen[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: headers.get('Authorization'),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    seen.push(call);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`no answer for ${call.method} ${call.url}`);

    return answer(call);
  }) as typeof fetch;

  return { seen, fetcher };
}
const json = (status: number, body: unknown) => () => Response.json(body, { status });

describe('sendSiteVerdict (FRU-734)', () => {
  it('reads the page of the note for its issue, then posts the verdict on that issue', async () => {
    const { seen, fetcher } = worker([json(200, READ), json(201, { stage: 'done' })]);

    const outcome = await sendSiteVerdict(WORKER, QUERY, { ensureAccess: async () => grant('t1'), fetcher });

    assert.equal(outcome, 'sent');
    assert.deepEqual(
      seen.map((call) => `${call.method} ${call.url} ${call.auth}`),
      [
        `GET ${WORKER}/feedback?url=${encodeURIComponent(QUERY.url)}&client=site_1 Bearer t1`,
        `POST ${WORKER}/feedback/iss_42/check?client=site_1 Bearer t1`,
      ],
    );
    assert.deepEqual(JSON.parse(seen[1]?.body ?? '{}'), { url: QUERY.url, verdict: 'fixed' });
  });

  it('is refused when the page no longer holds the note, and posts nothing', async () => {
    const { seen, fetcher } = worker([json(200, { issues: [{ id: 'x', note: { id: 'sd_other' } }] })]);

    assert.equal(await sendSiteVerdict(WORKER, QUERY, { ensureAccess: async () => grant('t1'), fetcher }), 'refused');
    assert.equal(seen.length, 1);
  });

  it('says what the worker answered to the verdict: refused, or failed for a try again', async () => {
    for (const [status, outcome] of [
      [409, 'refused'],
      [403, 'refused'],
      [503, 'failed'],
    ] as const) {
      const { fetcher } = worker([json(200, READ), json(status, { error: 'x' })]);
      assert.equal(await sendSiteVerdict(WORKER, QUERY, { ensureAccess: async () => grant('t1'), fetcher }), outcome);
    }
    const silent = worker([json(200, READ), () => Promise.reject(new Error('offline')) as never]);
    assert.equal(
      await sendSiteVerdict(WORKER, QUERY, { ensureAccess: async () => grant('t1'), fetcher: silent.fetcher }),
      'failed',
    );
  });

  it('renews an old token once, and says signed-out when the renewal is refused', async () => {
    const renewed = worker([json(401, {}), json(200, READ), json(201, {})]);
    const outcome = await sendSiteVerdict(WORKER, QUERY, {
      ensureAccess: async () => grant('old'),
      renewAccess: async () => grant('new'),
      fetcher: renewed.fetcher,
    });
    assert.equal(outcome, 'sent');
    assert.deepEqual(
      renewed.seen.map((call) => call.auth),
      ['Bearer old', 'Bearer new', 'Bearer new'],
    );

    const ended = worker([json(401, {})]);
    assert.equal(
      await sendSiteVerdict(WORKER, QUERY, {
        ensureAccess: async () => grant('old'),
        renewAccess: async () => ({ ok: false, reason: 'session-revoked-or-expired' }) as AccessResult,
        fetcher: ended.fetcher,
      }),
      'signed-out',
    );
  });

  it('sends nothing with no session', async () => {
    const { seen, fetcher } = worker([]);
    const outcome = await sendSiteVerdict(WORKER, QUERY, {
      ensureAccess: async () => ({ ok: false, reason: 'session-revoked-or-expired' }) as AccessResult,
      fetcher,
    });

    assert.equal(outcome, 'signed-out');
    assert.equal(seen.length, 0);
  });
});

describe('issueOf', () => {
  it('finds the issue of a note, and nothing in a body it cannot read', () => {
    assert.equal(issueOf(READ, 'sd_far'), 'iss_42');
    for (const body of [
      undefined,
      null,
      'x',
      {},
      { issues: 'no' },
      { issues: [null, { id: 3, note: { id: 'sd_far' } }] },
    ]) {
      assert.equal(issueOf(body, 'sd_far'), undefined);
    }
  });
});
