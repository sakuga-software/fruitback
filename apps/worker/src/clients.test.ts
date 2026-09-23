import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { originsFromClients, readClientMap, resolveClient } from './clients.ts';

// A `ClientPolicy` since SKG-522: `teamId` and `projectId` moved to the Linear connector, which is
// where a team means something. `linear.test.ts` covers their fallback now.
const FALLBACK = {
  identitySecret: undefined,
  showComments: true,
  read: 'public',
  // Worker-wide, and no client overrides it: a description is read where the issues are (SKG-532).
  locale: 'en',
} as const;

const MAP = {
  acme: { teamId: 'team_acme', projectId: 'project_acme', origins: ['https://acme.test'] },
  globex: { teamId: 'team_globex' },
};

describe('readClientMap', () => {
  it('is absent on a single-client worker, which is the default', () => {
    assert.deepEqual(readClientMap(undefined), { ok: true, clients: undefined });
    assert.deepEqual(readClientMap('   '), { ok: true, clients: undefined });
  });

  it('reads a map', () => {
    const result = readClientMap(JSON.stringify(MAP));

    assert.ok(result.ok);
    assert.equal(result.clients?.acme?.teamId, 'team_acme');
    assert.deepEqual(result.clients?.acme?.origins, ['https://acme.test']);
  });

  it('refuses a malformed map rather than falling back to one team', () => {
    // The fallback in a multi-tenant deployment is the leak: a typo here would silently pool every
    // client's feedback into the default team.
    for (const value of ['{ not json', '"a string"', '{"acme":{"teamId":""}}', '{"acme":{"origins":[]}}', '{}']) {
      assert.equal(readClientMap(value).ok, false, `${value} should be refused`);
    }
  });
});

describe('resolveClient', () => {
  it('changes nothing when no map is configured', () => {
    const resolved = resolveClient({ clients: undefined, clientId: undefined, origin: null, fallback: FALLBACK });

    assert.deepEqual(resolved, { ok: true, policy: FALLBACK, client: undefined });
  });

  it('hands the client entry on, for the store to read its own fields from', () => {
    // Not picked apart here on purpose (SKG-522): `teamId` is Linear's, an `owner/repo` would be
    // GitHub's, and SQLite wants neither. Naming any of them in this function is what made the
    // read cache know that stores route by team.
    const resolved = resolveClient({
      clients: MAP,
      clientId: 'acme',
      origin: 'https://acme.test',
      fallback: FALLBACK,
    });

    assert.deepEqual(resolved, {
      ok: true,
      policy: { identitySecret: undefined, showComments: true, read: 'public', locale: 'en' },
      client: MAP.acme,
    });
  });

  it('requires a client once the worker serves several', () => {
    // Answering the default here is what let one client read another's feedback.
    const resolved = resolveClient({ clients: MAP, clientId: undefined, origin: null, fallback: FALLBACK });

    assert.deepEqual(resolved, { ok: false, reason: 'client-required' });
  });

  it('trims the id, because it arrives from two places', () => {
    // The query parameter was trimmed at its call site and the seed's own id was not, so a client
    // with a stray space resolved on a read and came back unknown on a write.
    const resolved = resolveClient({ clients: MAP, clientId: '  acme  ', origin: null, fallback: FALLBACK });

    assert.deepEqual(resolved, {
      ok: true,
      policy: { identitySecret: undefined, showComments: true, read: 'public', locale: 'en' },
      client: MAP.acme,
    });
  });

  it('refuses a client it has never heard of', () => {
    const resolved = resolveClient({ clients: MAP, clientId: 'unknown', origin: null, fallback: FALLBACK });

    assert.deepEqual(resolved, { ok: false, reason: 'unknown-client' });
  });

  it('refuses a client claimed from a site it is not embedded on', () => {
    // `clientId` is client-asserted until SKG-498; binding it to an origin is the cheapest check
    // available, at the same trust level CORS already gives.
    const resolved = resolveClient({
      clients: MAP,
      clientId: 'acme',
      origin: 'https://evil.test',
      fallback: FALLBACK,
    });

    assert.deepEqual(resolved, { ok: false, reason: 'origin-not-allowed-for-client' });
  });

  it('has nothing to check when the request is not a browser', () => {
    // No `Origin` means curl or server-to-server, exactly as `resolveCors` reasons about it.
    const resolved = resolveClient({ clients: MAP, clientId: 'acme', origin: null, fallback: FALLBACK });

    assert.ok(resolved.ok);
  });

  /**
   * The extension is not a site, and its origin carries an id no operator can write down (SKG-596).
   * The same reasoning the `origin: null` case above applies: this binds a claim to a site, and a
   * caller that is not a site has nothing to bind.
   */
  it('lets the extension relay for a client whose origins it can never be on', () => {
    const resolved = resolveClient({
      clients: MAP,
      clientId: 'acme',
      origin: 'chrome-extension://ekjmfoaibpceoc',
      fallback: FALLBACK,
    });

    assert.equal(resolved.ok, true);
  });

  it('lets a client with no origins be embedded anywhere', () => {
    const resolved = resolveClient({
      clients: MAP,
      clientId: 'globex',
      origin: 'https://anywhere.test',
      fallback: FALLBACK,
    });

    assert.ok(resolved.ok);
  });
});

describe('originsFromClients', () => {
  it('collects every site the map allows, without repeats', () => {
    const clients = { a: { origins: ['https://one.test'] }, b: { origins: ['https://one.test', 'https://two.test'] } };

    assert.deepEqual(originsFromClients(clients), ['https://one.test', 'https://two.test']);
  });

  it('is empty on a single-client worker', () => {
    assert.deepEqual(originsFromClients(undefined), []);
  });
});

describe('the identity secret is never inherited', () => {
  it('does not lend the worker’s secret to a mapped client', () => {
    // `teamId` and `projectId` fall back per field; a signing key must not. One secret shared across
    // tenants lets a compromised tenant mint a verified identity on anyone else's issues — the same
    // reasoning as the fallback team, and the same answer.
    const resolved = resolveClient({
      clients: { acme: { teamId: 'team_acme' } },
      clientId: 'acme',
      origin: null,
      fallback: { ...FALLBACK, identitySecret: 'the-worker-wide-secret-long-enough' },
    });

    assert.ok(resolved.ok);
    assert.equal(resolved.policy.identitySecret, undefined);
    // The other fields still fall back, which is the difference being drawn. `showComments` and
    // `read` stand in for what `projectId` used to show here, now that it belongs to the connector.
    assert.equal(resolved.policy.showComments, true);
    assert.equal(resolved.policy.read, 'public');
  });

  it('uses a client’s own secret when it has one', () => {
    const resolved = resolveClient({
      clients: { acme: { teamId: 'team_acme', identitySecret: 'the-acme-secret-which-is-long-enough' } },
      clientId: 'acme',
      origin: null,
      fallback: { ...FALLBACK, identitySecret: 'the-worker-wide-secret-long-enough' },
    });

    assert.ok(resolved.ok);
    assert.equal(resolved.policy.identitySecret, 'the-acme-secret-which-is-long-enough');
  });

  it('still uses the worker’s secret when there is no map at all', () => {
    const fallback = { ...FALLBACK, identitySecret: 'the-worker-wide-secret-long-enough' };
    const resolved = resolveClient({ clients: undefined, clientId: undefined, origin: null, fallback });

    assert.ok(resolved.ok);
    assert.equal(resolved.policy.identitySecret, 'the-worker-wide-secret-long-enough');
  });
});
