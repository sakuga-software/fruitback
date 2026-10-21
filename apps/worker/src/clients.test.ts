import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { originsFromClients, readClientMap, resolveClient, unreadableClients, workspacesOf } from './clients.ts';

// A `ClientPolicy` since FRU-29: `teamId` and `projectId` moved to the Linear connector, which is
// where a team means something. `linear.test.ts` covers their fallback now.
const FALLBACK = {
  identitySecret: undefined,
  showComments: true,
  read: 'public',
  write: 'public',
  // Worker-wide, and no client overrides it: a description is read where the issues are (FRU-39).
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

  /**
   * Three fields that no test gave a real value before FRU-190. A mutation run counted their
   * mutants killed only when it ran out of time: nothing asserted them.
   */
  it('reads a repository whose name starts with a dot: only « . » and « .. » are refused', () => {
    // `acme/.github` is a repository that every organisation of GitHub can have.
    for (const repository of ['acme/.github', 'acme/..config', 'acme/.a', 'acme/a.b', 'acme/a..']) {
      const result = readClientMap(JSON.stringify({ acme: { repository } }));

      assert.ok(result.ok, `${repository} should be read`);
      assert.equal(result.clients?.acme?.repository, repository);
    }
    for (const repository of ['acme/.', 'acme/..']) {
      assert.equal(
        readClientMap(JSON.stringify({ acme: { repository } })).ok,
        false,
        `${repository} should be refused`,
      );
    }
  });

  it('reads the connector of a client, of any length but zero', () => {
    const result = readClientMap(JSON.stringify({ acme: { connector: 'con_0123456789abcdef' } }));

    assert.ok(result.ok);
    assert.equal(result.clients?.acme?.connector, 'con_0123456789abcdef');
    assert.equal(readClientMap(JSON.stringify({ acme: { connector: 'c' } })).ok, true);
    assert.equal(readClientMap(JSON.stringify({ acme: { connector: '' } })).ok, false);
  });

  it('reads who may read a client: « public » or « authenticated », and no other word', () => {
    for (const read of ['public', 'authenticated']) {
      const result = readClientMap(JSON.stringify({ acme: { read } }));

      assert.ok(result.ok, `${read} should be read`);
      assert.equal(result.clients?.acme?.read, read);
    }
    for (const read of ['', 'private', 'Public']) {
      assert.equal(readClientMap(JSON.stringify({ acme: { read } })).ok, false, `« ${read} » should be refused`);
    }
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
    // Not picked apart here on purpose (FRU-29): `teamId` is Linear's, an `owner/repo` would be
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
      policy: { identitySecret: undefined, showComments: true, read: 'public', write: 'public', locale: 'en' },
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
      policy: { identitySecret: undefined, showComments: true, read: 'public', write: 'public', locale: 'en' },
      client: MAP.acme,
    });
  });

  it('refuses a client it has never heard of', () => {
    const resolved = resolveClient({ clients: MAP, clientId: 'unknown', origin: null, fallback: FALLBACK });

    assert.deepEqual(resolved, { ok: false, reason: 'unknown-client' });
  });

  it('refuses a client claimed from a site it is not embedded on', () => {
    // `clientId` is client-asserted until FRU-9; binding it to an origin is the cheapest check
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
   * The extension is not a site, and its origin carries an id no operator can write down (FRU-57).
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

  it('adds nothing for a client with no origins', () => {
    assert.deepEqual(originsFromClients({ a: {}, b: { origins: ['https://one.test'] } }), ['https://one.test']);
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

describe('unreadableClients', () => {
  const SECRET = 's'.repeat(32);

  it('names the single client when it is read with a token and nothing can sign one', () => {
    assert.deepEqual(unreadableClients({ read: 'authenticated', clients: undefined, identitySecret: undefined }), [
      '<single client>',
    ]);
    assert.deepEqual(unreadableClients({ read: 'authenticated', clients: undefined, identitySecret: SECRET }), []);
    assert.deepEqual(unreadableClients({ read: 'public', clients: undefined, identitySecret: undefined }), []);
  });

  it('names each mapped client read with a token and with no key of its own, its own read first', () => {
    const clients = {
      inherits: {},
      closed: { read: 'authenticated' },
      open: { read: 'public' },
      keyed: { read: 'authenticated', identitySecret: SECRET },
    } as const;

    assert.deepEqual(unreadableClients({ read: 'authenticated', clients, identitySecret: SECRET }), [
      'inherits',
      'closed',
    ]);
    assert.deepEqual(unreadableClients({ read: 'public', clients, identitySecret: SECRET }), ['closed']);
  });

  it('reads a client of a workspace with a session token, only on a worker that opens sessions', () => {
    const clients = { site: { read: 'authenticated', workspace: 'ws_1' }, loose: { read: 'authenticated' } } as const;

    assert.deepEqual(unreadableClients({ read: 'public', clients, identitySecret: SECRET, sessions: true }), ['loose']);
    // No sessions: said, or left to its default.
    assert.deepEqual(unreadableClients({ read: 'public', clients, identitySecret: SECRET, sessions: false }), [
      'site',
      'loose',
    ]);
    assert.deepEqual(unreadableClients({ read: 'public', clients, identitySecret: SECRET }), ['site', 'loose']);
    // Sessions, but no key on the worker.
    assert.deepEqual(unreadableClients({ read: 'public', clients, identitySecret: undefined, sessions: true }), [
      'site',
      'loose',
    ]);
  });
});

describe('workspacesOf', () => {
  it('names each workspace of the map once, and none for a client outside one', () => {
    const clients = { a: { workspace: 'ws_1' }, b: {}, c: { workspace: 'ws_2' }, d: { workspace: 'ws_1' } };

    assert.deepEqual(workspacesOf(clients), ['ws_1', 'ws_2']);
    assert.deepEqual(workspacesOf(undefined), []);
  });
});
