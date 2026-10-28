import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ATTACHMENTS_PATH,
  CHECK_PATH,
  EDIT_PATH,
  FEEDBACK_PATH,
  REPLY_PATH,
  type RelaySeams,
  createRelay,
} from './relay.ts';
import { type RelayRequest, type RelayResponse, parseRelayRequest } from './protocol.ts';
import { resolveSite } from './site-patterns.ts';
import type { SiteConfig } from './sites.ts';

/**
 * Every gate the relay applies, one by one.
 *
 * None of them is visible from outside the browser: a refusal and a worker that answered look the
 * same to the widget, which treats both as a failed call. So this file is the only place any of
 * them is ever seen to work.
 */

const TEAM: SiteConfig = { mode: 'team', endpoint: 'https://worker.test', enabled: true };
const GRANT = { accessToken: 'access.1', expiresAt: 0, identity: { subject: 'reviewer-1' } };
const ANSWER: RelayResponse = { ok: true, status: 200, body: '{"issues":[]}' };

const READ: RelayRequest = {
  url: 'https://worker.test/feedback?url=https%3A%2F%2Facme.dev%2F&client=acme',
  method: 'GET',
  headers: {},
};

const WRITE: RelayRequest = {
  url: 'https://worker.test/feedback',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{"note":"hello"}',
};

/** A relay whose three seams are fakes, and the record of what the last one was asked to send. */
function harness(overrides: Partial<RelaySeams> = {}) {
  const sent: RelayRequest[] = [];
  const relay = createRelay({
    readSite: async () => TEAM,
    ensureAccess: async () => ({ ok: true, grant: GRANT }),
    send: async (request) => {
      sent.push(request);

      return ANSWER;
    },
    ...overrides,
  });

  return { relay, sent };
}

describe('the relay refuses before it sends', () => {
  it('refuses a sender the browser could not name', async () => {
    const { relay, sent } = harness();

    assert.deepEqual(await relay(READ, undefined), { ok: false, status: 0, body: 'unknown-sender' });
    assert.deepEqual(sent, []);
  });

  /**
   * The lookup the background gives the relay is `resolveSite`. A wildcard stored in team mode by an
   * earlier version must not lend the session to a page it covers (FRU-75).
   */
  it('refuses an origin that only a team-mode wildcard covers', async () => {
    const stored = { 'https://*.vercel.app': TEAM };
    const { relay, sent } = harness({ readSite: async (origin) => resolveSite(stored, origin)?.site });

    assert.partialDeepStrictEqual(await relay(READ, 'https://somebody.vercel.app'), {
      ok: false,
      body: 'site-not-configured',
    });
    assert.deepEqual(sent, []);
  });

  it('refuses an origin nobody configured', async () => {
    const { relay, sent } = harness({ readSite: async () => undefined });

    assert.partialDeepStrictEqual(await relay(READ, 'https://acme.dev'), { ok: false, body: 'site-not-configured' });
    assert.deepEqual(sent, []);
  });

  it('refuses a site that is switched off', async () => {
    const { relay, sent } = harness({ readSite: async () => ({ ...TEAM, enabled: false }) });

    assert.partialDeepStrictEqual(await relay(READ, 'https://acme.dev'), { ok: false, body: 'site-switched-off' });
    assert.deepEqual(sent, []);
  });

  /** Private mode mounts our own widget, which calls the worker itself. Nothing relays for it. */
  it('refuses a site in private mode', async () => {
    const site: SiteConfig = { mode: 'private', endpoint: 'https://worker.test', clientId: 'acme', enabled: true };
    const { relay, sent } = harness({ readSite: async () => site });

    assert.partialDeepStrictEqual(await relay(READ, 'https://acme.dev'), { ok: false, body: 'site-not-in-team-mode' });
    assert.deepEqual(sent, []);
  });

  /**
   * The gate the whole mode rests on.
   *
   * The page declares which worker its widget is pointed at. A page that names another one is asking
   * for this reviewer's session with *that* worker — which they hold, because they paired with it
   * for some other site. Refused, and deliberately not redirected to the stored endpoint: a widget
   * told its call succeeded against a worker nobody on the page chose is worse than a failed call.
   */
  it('refuses an endpoint this origin never declared', async () => {
    const { relay, sent } = harness();

    for (const url of [
      'https://elsewhere.test/feedback',
      'http://worker.test/feedback',
      'https://worker.test.evil.dev/feedback',
      'https://worker.test:8443/feedback',
      'not a url',
    ]) {
      const answer = await relay({ ...READ, url }, 'https://acme.dev');
      assert.partialDeepStrictEqual(answer, { ok: false, body: 'endpoint-not-declared-for-this-site' }, url);
    }

    assert.deepEqual(sent, []);
  });

  it('relays a reply under one note, with the credential of the session, under an endpoint with a path too (FRU-257)', async () => {
    for (const endpoint of ['https://worker.test', 'https://worker.test/fruitback']) {
      const { relay, sent } = harness({ readSite: async () => ({ ...TEAM, endpoint }) });
      const url = `${endpoint}/feedback/issue_1/replies?client=acme`;

      const answer = await relay(
        { ...WRITE, url, body: '{"url":"https://acme.dev/","body":"Seen."}' },
        'https://acme.dev',
      );

      assert.partialDeepStrictEqual(answer, { ok: true }, endpoint);
      assert.equal(sent[0]?.url, url);
      assert.equal(sent[0]?.headers.Authorization, 'Bearer access.1');
    }
  });

  it('relays a verdict on one note, with the credential of the session, under an endpoint with a path too (FRU-300)', async () => {
    for (const endpoint of ['https://worker.test', 'https://worker.test/fruitback']) {
      const { relay, sent } = harness({ readSite: async () => ({ ...TEAM, endpoint }) });
      const url = `${endpoint}/feedback/issue_1/check?client=acme`;

      const answer = await relay(
        { ...WRITE, url, body: '{"url":"https://acme.dev/","verdict":"fixed"}' },
        'https://acme.dev',
      );

      assert.partialDeepStrictEqual(answer, { ok: true }, endpoint);
      assert.equal(sent[0]?.url, url);
      assert.equal(sent[0]?.headers.Authorization, 'Bearer access.1');
    }
  });

  it('relays the edit of one note by its author, with the credential of the session (FRU-475)', async () => {
    for (const endpoint of ['https://worker.test', 'https://worker.test/fruitback']) {
      const { relay, sent } = harness({ readSite: async () => ({ ...TEAM, endpoint }) });
      const url = `${endpoint}/feedback/issue_1/text?client=acme`;

      const answer = await relay(
        { ...WRITE, url, body: '{"url":"https://acme.dev/","text":"The price is wrong"}' },
        'https://acme.dev',
      );

      assert.partialDeepStrictEqual(answer, { ok: true }, endpoint);
      assert.equal(sent[0]?.url, url);
      assert.equal(sent[0]?.headers.Authorization, 'Bearer access.1');
    }
  });

  /** Three paths, so a route the worker grows later is refused here until somebody adds it. */
  it('refuses a path that is not the one the widget calls', async () => {
    const { relay, sent } = harness();

    for (const path of [
      '/session/refresh',
      '/health',
      '/feedback/../session/pair',
      '/',
      // A reply goes under one note, and nowhere around it (FRU-257).
      '/feedback/issue_1/replies/../../../session/pair',
      '/feedback/issue_1/replies/x',
      '/feedback//replies',
      '/feedback/a.b/replies',
      // FRU-300: a verdict goes under one note too. The planted violation of the ticket: another
      // path of writing under a note, which the worker may grow one day, is refused.
      '/feedback/issue_1/stage',
      '/feedback/issue_1/check/../stage',
      '/feedback/issue_1/check/x',
      '/feedback//check',
      // FRU-475: the text of one note, and nothing around it.
      '/feedback/issue_1/text/x',
      '/feedback/issue_1/text/../../../session/pair',
      '/feedback//text',
    ]) {
      const answer = await relay({ ...READ, url: `https://worker.test${path}` }, 'https://acme.dev');
      assert.partialDeepStrictEqual(answer, { ok: false, body: 'endpoint-not-declared-for-this-site' }, path);
    }

    assert.deepEqual(sent, []);
  });

  /**
   * The token is a bearer credential and this call is the only thing carrying it, so it does not
   * cross a plain `http://` connection. Loopback is the exception: it is the dev loop, and it is not
   * on a wire. Raised in review.
   */
  it('refuses to carry a credential over plain http, loopback excepted', async () => {
    for (const endpoint of ['http://worker.test', 'http://192.168.1.10:8788']) {
      const { relay, sent } = harness({ readSite: async () => ({ mode: 'team', endpoint, enabled: true }) });
      const answer = await relay({ ...READ, url: `${endpoint}/feedback?url=x` }, 'https://acme.dev');

      assert.partialDeepStrictEqual(answer, { ok: false, body: 'insecure-endpoint' }, endpoint);
      assert.deepEqual(sent, []);
    }

    for (const endpoint of ['http://localhost:8788', 'http://127.0.0.1:8788', 'https://worker.test']) {
      const { relay, sent } = harness({ readSite: async () => ({ mode: 'team', endpoint, enabled: true }) });
      await relay({ ...READ, url: `${endpoint}/feedback?url=x` }, 'https://acme.dev');

      assert.equal(sent.length, 1, endpoint);
    }
  });

  /**
   * No session, no call — and that is a decision, not an oversight.
   *
   * Relaying without the header would work on a worker left at `read: 'public'`: the pins would
   * appear and everything would look right, while the mode delivered none of what it promises. A
   * reviewer would have no moment at which to notice they are not paired. The popup says so; this
   * makes sure the page cannot say otherwise.
   */
  it('refuses rather than call without a session', async () => {
    for (const reason of ['not-paired', 'session-revoked-or-expired', 'unavailable'] as const) {
      const { relay, sent } = harness({ ensureAccess: async () => ({ ok: false, reason }) });

      assert.partialDeepStrictEqual(await relay(READ, 'https://acme.dev'), { ok: false, body: reason });
      assert.deepEqual(sent, []);
    }
  });

  it('answers 401 when there is no session, so the widget says to sign in again (FRU-238)', async () => {
    for (const reason of ['not-paired', 'session-revoked-or-expired'] as const) {
      const { relay } = harness({ ensureAccess: async () => ({ ok: false, reason }) });
      assert.equal((await relay(WRITE, 'https://acme.dev')).status, 401, reason);
    }
    // The control: a worker that does not answer is not a session that ended.
    const { relay } = harness({ ensureAccess: async () => ({ ok: false, reason: 'unavailable' }) });
    assert.equal((await relay(WRITE, 'https://acme.dev')).status, 0);
  });

  /**
   * The refusal of status 0 is logged by the background, and a session refusal now answers `401`:
   * without this, a reviewer whose session ended would find no trace of it in the console.
   */
  it('tells the log why it answered 401 for a session, and only then (FRU-238)', async () => {
    for (const reason of ['not-paired', 'session-revoked-or-expired'] as const) {
      const told: string[] = [];
      const { relay } = harness({ ensureAccess: async () => ({ ok: false, reason }), warn: (why) => told.push(why) });
      await relay(WRITE, 'https://acme.dev');
      assert.deepEqual(told, [reason]);
    }
    // A refusal of status 0 is logged by the background already, and an answer is no refusal.
    const told: string[] = [];
    await harness({
      ensureAccess: async () => ({ ok: false, reason: 'unavailable' }),
      warn: (why) => told.push(why),
    }).relay(WRITE, 'https://acme.dev');
    await harness({ warn: (why) => told.push(why) }).relay(WRITE, 'https://acme.dev');
    assert.deepEqual(told, []);
  });

  it('answers a refusal when the worker cannot be reached', async () => {
    const { relay } = harness({
      send: async () => {
        throw new Error('network');
      },
    });

    assert.partialDeepStrictEqual(await relay(READ, 'https://acme.dev'), { ok: false, body: 'worker-unreachable' });
  });

  /** The background aborts a call that runs too long, and a reviewer can act on that by waiting. */
  it('says a worker that never answered apart from one that could not be reached', async () => {
    const { relay } = harness({
      send: async () => {
        const aborted = new Error('timed out');
        aborted.name = 'TimeoutError';

        throw aborted;
      },
    });

    assert.partialDeepStrictEqual(await relay(READ, 'https://acme.dev'), { ok: false, body: 'worker-timeout' });
  });

  /**
   * Storage and the session do I/O, and a rejection would leave the background with no answer to
   * send — the page would then wait out its whole deadline for a refusal that already happened.
   * Raised in review.
   */
  it('answers rather than rejects, whatever a seam does', async () => {
    const throwing = async () => {
      throw new Error('storage is gone');
    };

    for (const seam of [{ readSite: throwing }, { ensureAccess: throwing }]) {
      const { relay, sent } = harness(seam);

      assert.partialDeepStrictEqual(await relay(READ, 'https://acme.dev'), { ok: false, body: 'relay-failed' });
      assert.deepEqual(sent, []);
    }
  });
});

describe('the relay sends what the background decided, never what the page asked for', () => {
  it('attaches the credential the page has no way to read', async () => {
    const { relay, sent } = harness();

    assert.deepEqual(await relay(READ, 'https://acme.dev'), ANSWER);
    assert.deepEqual(sent, [{ url: READ.url, method: 'GET', headers: { Authorization: 'Bearer access.1' } }]);
  });

  it('keeps the body and the content type of a write', async () => {
    const { relay, sent } = harness();
    await relay(WRITE, 'https://acme.dev');

    assert.deepEqual(sent, [
      {
        url: WRITE.url,
        method: 'POST',
        headers: { Authorization: 'Bearer access.1', 'Content-Type': 'application/json' },
        body: '{"note":"hello"}',
      },
    ]);
  });

  /**
   * A page that names its own `Authorization` must not choose what this call carries.
   *
   * Asserted through `parseRelayRequest`, because that is the path a real message takes: the page
   * writes the object, the parser rebuilds it, and the relay reads the result. Testing the relay on
   * a hand-built request would prove the wrong half.
   */
  it('drops an Authorization the page named, whatever its spelling', async () => {
    const { relay, sent } = harness();
    const forged = parseRelayRequest({
      url: WRITE.url,
      method: 'POST',
      headers: { authorization: 'Bearer stolen', Authorization: 'Bearer stolen', 'Content-Type': 'text/plain' },
      body: '{}',
    });

    assert.ok(forged !== undefined);
    await relay(forged, 'https://acme.dev');

    assert.deepEqual(sent[0]?.headers, { Authorization: 'Bearer access.1', 'Content-Type': 'text/plain' });
  });

  /** A worker behind a path is an ordinary Traefik deployment, and the relay has to reach it. */
  it('allows an endpoint that carries a path of its own', async () => {
    const { relay, sent } = harness({
      readSite: async () => ({ mode: 'team', endpoint: 'https://acme.dev/fruitback', enabled: true }),
    });

    const answer = await relay({ ...READ, url: 'https://acme.dev/fruitback/feedback?url=x' }, 'https://acme.dev');

    assert.deepEqual(answer, ANSWER);
    assert.equal(sent.length, 1);
  });
});

/**
 * The widget is the only caller this relay serves, and the relay allows less than a `fetch` does.
 *
 * Both of the rules below are written against `packages/widget/src/embed.ts` rather than against a
 * list kept here, so a call the widget grows later fails this file instead of being dropped on a
 * reviewer's page with nothing to see. The same cross-package reading `security.test.ts` does.
 */
describe('what the widget sends is what the relay allows', () => {
  const embed = readFileSync(fileURLToPath(new URL('../../../packages/widget/src/embed.ts', import.meta.url)), 'utf8');

  it('calls the paths the relay allows, and no other', () => {
    const paths = [...embed.matchAll(/\$\{options\.endpoint\}([^`?]*)/g)].map((match) => match[1]);

    assert.ok(paths.length > 0, 'embed.ts no longer builds a URL from options.endpoint; this guard reads nothing');
    // The id of a note is a value of the widget: an id the relay takes stands in for it.
    const resolved = paths.map((path) => path?.replace(/\$\{[^}]+\}/g, 'issue_1'));
    assert.ok(resolved.includes('/feedback/issue_1/replies'), 'the guard no longer sees the path of a reply');
    assert.ok(resolved.includes('/feedback/issue_1/check'), 'the guard no longer sees the path of a verdict');
    assert.ok(resolved.includes('/feedback/issue_1/text'), 'the guard no longer sees the path of an edit (FRU-475)');
    assert.ok(resolved.includes(ATTACHMENTS_PATH), 'the guard no longer sees the path of a file (FRU-332)');
    for (const path of resolved) {
      assert.ok(
        path === FEEDBACK_PATH ||
          path === ATTACHMENTS_PATH ||
          REPLY_PATH.test(path ?? '') ||
          CHECK_PATH.test(path ?? '') ||
          EDIT_PATH.test(path ?? ''),
        path ?? '',
      );
    }
  });

  it('names no header the relay would drop in silence', () => {
    const names = new Set([...embed.matchAll(/(?:^|[{,\s])'?([A-Z][A-Za-z-]*)'?:\s/gm)].map((match) => match[1]));

    assert.ok(names.has('Content-Type'), 'the detector found no Content-Type; it is selecting the wrong thing');
    assert.ok(names.has('Authorization'), 'the detector found no Authorization; it is selecting the wrong thing');
    assert.deepEqual(
      [...names].sort(),
      ['Authorization', 'Content-Type'],
      'embed.ts sends a header the relay does not carry: add it to ALLOWED_HEADERS or stop sending it',
    );
  });
});

describe('a call the worker refused for its session (FRU-238)', () => {
  const ENDED: RelayResponse = {
    ok: false,
    status: 401,
    body: JSON.stringify({ error: 'invalid-identity', reason: 'session-ended' }),
  };

  it('renews the access once and sends again when the token was only old', async () => {
    const tokens: string[] = [];
    const renewed: string[] = [];
    const { relay } = harness({
      renewAccess: async (_endpoint, refused) => {
        renewed.push(refused);

        return { ok: true, grant: { ...GRANT, accessToken: 'access.2' } };
      },
      send: async (request) => {
        tokens.push(request.headers.Authorization ?? '');

        return request.headers.Authorization === 'Bearer access.1' ? ENDED : ANSWER;
      },
    });

    assert.deepEqual(await relay(WRITE, 'https://acme.dev'), ANSWER);
    assert.deepEqual(tokens, ['Bearer access.1', 'Bearer access.2']);
    assert.deepEqual(renewed, ['access.1']);
  });

  it('gives the refusal back when the session ended: the renewal forgets it, and nothing is sent again', async () => {
    let sends = 0;
    const { relay } = harness({
      renewAccess: async () => ({ ok: false, reason: 'session-revoked-or-expired' }),
      send: async () => {
        sends += 1;

        return ENDED;
      },
    });

    assert.deepEqual(await relay(WRITE, 'https://acme.dev'), ENDED);
    assert.equal(sends, 1);
  });

  it('tries once: a second refusal is given back, and no other status renews anything', async () => {
    let renewals = 0;
    const renewAccess: RelaySeams['renewAccess'] = async () => {
      renewals += 1;

      return { ok: true, grant: { ...GRANT, accessToken: 'access.2' } };
    };
    const always = harness({ renewAccess, send: async () => ENDED });
    assert.deepEqual(await always.relay(WRITE, 'https://acme.dev'), ENDED);
    assert.equal(renewals, 1);

    for (const answer of [
      { ok: false, status: 403, body: '{"error":"forbidden"}' },
      { ok: false, status: 502, body: '{}' },
    ]) {
      const other = harness({ renewAccess, send: async () => answer });
      assert.deepEqual(await other.relay(READ, 'https://acme.dev'), answer);
    }
    assert.equal(renewals, 1);
  });
});

describe('a file of a note, through the relay (FRU-332)', () => {
  const FILE: RelayRequest = {
    url: 'https://worker.test/attachments?client=acme&name=page.png',
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: 'iVBORw0K',
    encoding: 'base64',
  };

  it('sends it to POST /attachments, with its type, its body in base64, and the session', async () => {
    const { relay, sent } = harness();

    assert.deepEqual(await relay(FILE, 'https://acme.dev'), ANSWER);
    assert.deepEqual(sent, [
      {
        url: FILE.url,
        method: 'POST',
        headers: { Authorization: 'Bearer access.1', 'Content-Type': 'image/png' },
        body: 'iVBORw0K',
        encoding: 'base64',
      },
    ]);
  });

  it('refuses base64 to another path, text to /attachments, and a read of /attachments', async () => {
    for (const request of [
      { ...WRITE, encoding: 'base64' as const, body: 'iVBO' },
      { ...FILE, encoding: undefined },
      { ...FILE, method: 'GET' as const },
      { ...FILE, url: 'https://worker.test/attachments/att_0123456789abcdef0123456789abcdef' },
    ]) {
      const { relay, sent } = harness();
      assert.partialDeepStrictEqual(await relay(request, 'https://acme.dev'), {
        ok: false,
        body: 'endpoint-not-declared-for-this-site',
      });
      assert.deepEqual(sent, [], JSON.stringify(request).slice(0, 120));
    }
  });
});
