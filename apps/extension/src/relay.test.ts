import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FEEDBACK_PATH, type RelaySeams, createRelay } from './relay.ts';
import { type RelayRequest, type RelayResponse, parseRelayRequest } from './protocol.ts';
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

  /** One path, so a route the worker grows later is refused here until somebody adds it. */
  it('refuses a path that is not the one the widget calls', async () => {
    const { relay, sent } = harness();

    for (const path of ['/session/refresh', '/health', '/feedback/../session/pair', '/']) {
      const answer = await relay({ ...READ, url: `https://worker.test${path}` }, 'https://acme.dev');
      assert.partialDeepStrictEqual(answer, { ok: false, body: 'endpoint-not-declared-for-this-site' }, path);
    }

    assert.deepEqual(sent, []);
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

  it('answers a refusal when the worker cannot be reached', async () => {
    const { relay } = harness({
      send: async () => {
        throw new Error('network');
      },
    });

    assert.partialDeepStrictEqual(await relay(READ, 'https://acme.dev'), { ok: false, body: 'worker-unreachable' });
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

  it('calls one path, and it is the one the relay allows', () => {
    const paths = [...embed.matchAll(/\$\{config\.endpoint\}([^`?]*)/g)].map((match) => match[1]);

    assert.ok(paths.length > 0, 'embed.ts no longer builds a URL from config.endpoint; this guard reads nothing');
    for (const path of paths) assert.equal(path, FEEDBACK_PATH);
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
