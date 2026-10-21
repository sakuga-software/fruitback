import { afterEach, describe, it, vi } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import assert from 'node:assert/strict';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import type { RequestContext } from './app.ts';
import {
  type CallOptions,
  type World,
  callOn,
  memberOf,
  signInTo,
  workspaceIn,
  worlds,
} from './console-world.fixture.ts';
import {
  PROOF_GRACE_MS,
  RECHECK_MS,
  type TxtResolver,
  checkProof,
  proofRecord,
  proofState,
  readDomain,
  recheckDomains,
} from './domain-proof.ts';
import type { PgDatabase } from './postgres.ts';
import { createPgliteDatabase } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * The proof that a workspace owns a domain (FRU-103). **No test asks a real DNS**: every resolver
 * here is a double that holds a zone in a map, and `noRealDns` fails a test that would reach one.
 */

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const databases: PgDatabase[] = [];

const envWith = worlds();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) await database.close();
});

/** A DNS that holds the `TXT` records of a map. A name it does not hold answers as `node:dns` does. */
function zone(records: Record<string, string[][]> = {}): TxtResolver & { asked: string[] } {
  const asked: string[] = [];
  const resolve = async (name: string) => {
    asked.push(name);
    const found = records[name];
    if (found === undefined) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });

    return found;
  };

  return Object.assign(resolve, { asked });
}

/** A DNS that does not answer. */
const silent: TxtResolver = async () => {
  throw Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' });
};

describe('the domain a person types (FRU-103)', () => {
  it('keeps the name of the zone, whatever was pasted around it', () => {
    assert.equal(readDomain('acme.dev'), 'acme.dev');
    assert.equal(readDomain('  Preview.Acme.DEV. '), 'preview.acme.dev');
    assert.equal(readDomain('https://*.preview.acme.dev/'), 'preview.acme.dev');
    assert.equal(readDomain('*.acme.dev'), 'acme.dev');
    assert.equal(readDomain('https://acme.dev/a/path?q=1#x'), 'acme.dev');
    assert.equal(readDomain('bücher.de'), 'xn--bcher-kva.de');
  });

  it('refuses what has no zone that somebody holds', () => {
    for (const value of [
      '',
      'localhost',
      '10.0.0.1',
      '[::1]',
      'acme.dev:8080',
      'user@acme.dev',
      'a b.dev',
      '*.*.acme.dev',
      'pr-*.acme.dev',
      '-acme.dev',
      '_fruitback.acme.dev',
      `${'a'.repeat(64)}.dev`,
      42,
      undefined,
    ]) {
      assert.equal(readDomain(value), undefined, String(value));
    }
  });
});

describe('the record that proves a domain', () => {
  it('is under the domain, and names the workspace and the domain', () => {
    const record = proofRecord('ws_acme', 'acme.dev');

    assert.equal(record.name, '_fruitback.acme.dev');
    assert.match(record.value, /^fruitback-domain-verification=[0-9a-f]{40}$/);
    assert.deepEqual(proofRecord('ws_acme', 'acme.dev'), record, 'computed, so the same each time');
    assert.notEqual(proofRecord('ws_other', 'acme.dev').value, record.value, 'another workspace');
    assert.notEqual(proofRecord('ws_acme', 'preview.acme.dev').value, record.value, 'another domain');
  });

  it('is found among the other records of the name, and in the pieces the DNS cut it in', async () => {
    const { name, value } = proofRecord('ws_acme', 'acme.dev');

    assert.equal(await checkProof(zone({ [name]: [['v=spf1 -all'], [value]] }), 'ws_acme', 'acme.dev'), 'found');
    assert.equal(
      await checkProof(zone({ [name]: [[value.slice(0, 10), value.slice(10)]] }), 'ws_acme', 'acme.dev'),
      'found',
    );
  });

  it('is missing when the DNS answers without it, and unknown when the DNS does not answer', async () => {
    const { name, value } = proofRecord('ws_acme', 'acme.dev');

    assert.equal(await checkProof(zone(), 'ws_acme', 'acme.dev'), 'missing');
    assert.equal(await checkProof(zone({ [name]: [['something else']] }), 'ws_acme', 'acme.dev'), 'missing');
    assert.equal(await checkProof(zone({ [name]: [[` ${value}`]] }), 'ws_acme', 'acme.dev'), 'missing');
    assert.equal(await checkProof(zone({ [name]: [[value.toUpperCase()]] }), 'ws_acme', 'acme.dev'), 'missing');
    assert.equal(await checkProof(silent, 'ws_acme', 'acme.dev'), 'unknown');
    // A DNS that never answers is not waited for.
    assert.equal(await checkProof(() => new Promise(() => {}), 'ws_acme', 'acme.dev', 20), 'unknown');
  });

  it('of another workspace proves nothing for this one', async () => {
    const theirs = proofRecord('ws_other', 'acme.dev');

    assert.equal(await checkProof(zone({ [theirs.name]: [[theirs.value]] }), 'ws_acme', 'acme.dev'), 'missing');
  });

  it('of a domain proves nothing for the domain above it', async () => {
    const below = proofRecord('ws_acme', 'preview.acme.dev');

    assert.equal(await checkProof(zone({ [below.name]: [[below.value]] }), 'ws_acme', 'acme.dev'), 'missing');
  });
});

describe('where a proof stands', () => {
  it('is pending, proven, then lost when the DNS answers without it or when nothing confirms it', () => {
    assert.equal(proofState({}, 1_000), 'pending');
    assert.equal(proofState({ verifiedAt: 1_000 }, 1_000 + PROOF_GRACE_MS), 'proven');
    assert.equal(proofState({ verifiedAt: 1_000 }, 1_001 + PROOF_GRACE_MS), 'lost');
    assert.equal(proofState({ verifiedAt: 1_000, lostAt: 2_000 }, 2_000), 'lost');
  });
});

describe('the proofs, asked again', () => {
  async function store() {
    const database = await createPgliteDatabase();
    databases.push(database);

    return createPostgresAccountStore(database);
  }

  it('asks the proven domains not asked for a while, writes the loss once, and says it once', async () => {
    const accounts = await store();
    const alice = await accounts.signIn({ provider: 'email', subject: 'a@acme.dev', email: 'a@acme.dev' });
    const workspace = await accounts.createWorkspace('Acme', alice.id);
    const acme = await accounts.addDomain(workspace.id, 'acme.dev', 0);
    const never = await accounts.addDomain(workspace.id, 'never.dev', 1);
    const byId = async (id: string) => (await accounts.domains(workspace.id)).find((each) => each.id === id);
    await accounts.noteDomainCheck(acme.id, 'found', 1_000);
    const dns = zone();
    const warned = mockMethod(console, 'warn', () => {});

    // Not due yet.
    await recheckDomains(accounts, dns, 1_000 + RECHECK_MS - 1);
    assert.deepEqual(dns.asked, []);

    await recheckDomains(accounts, dns, 1_000 + RECHECK_MS + 1);
    assert.deepEqual(dns.asked, ['_fruitback.acme.dev'], 'a domain never proven is not asked by the timer');
    const lost = await byId(acme.id);
    assert.equal(lost?.lostAt, 1_000 + RECHECK_MS + 1);
    assert.equal(warned.mock.calls.length, 1);
    assert.match(String(warned.mock.calls[0]?.[0]), /the domain acme\.dev of the workspace .* lost its proof/);

    await recheckDomains(accounts, dns, 1_000 + 3 * RECHECK_MS);
    assert.equal(warned.mock.calls.length, 1, 'a loss is said once');
    assert.equal((await byId(acme.id))?.lostAt, 1_000 + RECHECK_MS + 1);
    assert.equal((await byId(never.id))?.lostAt, undefined);
  });

  it('says once that a proof lapsed, when the DNS did not answer for the whole grace', async () => {
    const accounts = await store();
    const alice = await accounts.signIn({ provider: 'email', subject: 'a@acme.dev', email: 'a@acme.dev' });
    const workspace = await accounts.createWorkspace('Acme', alice.id);
    const acme = await accounts.addDomain(workspace.id, 'acme.dev', 0);
    await accounts.noteDomainCheck(acme.id, 'found', 1_000);
    const warned = mockMethod(console, 'warn', () => {});
    const state = async (now: number) => proofState((await accounts.domains(workspace.id))[0] ?? {}, now);

    // Silent passes inside the grace: proven, and nothing said.
    for (let pass = 1; pass * (RECHECK_MS + 1) <= PROOF_GRACE_MS; pass += 1) {
      await recheckDomains(accounts, silent, 1_000 + pass * (RECHECK_MS + 1));
    }
    assert.equal(await state(1_000 + PROOF_GRACE_MS), 'proven');
    assert.equal(warned.mock.calls.length, 0);

    // The pass that crosses the line says it, and the ones after it do not say it again.
    const after = 1_000 + PROOF_GRACE_MS + RECHECK_MS;
    await recheckDomains(accounts, silent, after);
    assert.equal(await state(after), 'lost');
    assert.equal(warned.mock.calls.length, 1);
    assert.match(String(warned.mock.calls[0]?.[0]), /the DNS did not confirm the domain acme\.dev .* for 72 hours/);
    await recheckDomains(accounts, silent, after + RECHECK_MS + 1);
    assert.equal(warned.mock.calls.length, 1);
    // No moment of loss is invented: the DNS never answered without the record.
    assert.equal((await accounts.domains(workspace.id))[0]?.lostAt, undefined);
  });

  it('says the lapse once when a click in the console finds it before the timer does', async () => {
    const env = await envWith();
    const { alice, workspace } = await world(env);
    const base = `/console/workspaces/${workspace}/domains`;
    const domain = (await (
      await call(env, 'POST', base, { token: alice.token, body: { domain: 'acme.dev' } })
    ).json()) as View;
    const accounts = env.accounts;
    // Proven long ago, and last asked inside the grace.
    await accounts.noteDomainCheck(domain.id, 'found', Date.now() - PROOF_GRACE_MS - 60_000);
    await accounts.noteDomainCheck(domain.id, 'unknown', Date.now() - RECHECK_MS - 60_000);
    const warned = mockMethod(console, 'warn', () => {});

    const checked = await call(
      env,
      'POST',
      `${base}/${domain.id}/check`,
      { token: alice.token },
      { resolveTxt: silent },
    );
    assert.equal(((await checked.json()) as View).state, 'lost');
    assert.equal(warned.mock.calls.length, 1);
    assert.match(String(warned.mock.calls[0]?.[0]), /the DNS did not confirm the domain acme\.dev/);

    // The timer comes after: the click already said it.
    await recheckDomains(accounts, silent, Date.now() + RECHECK_MS);
    assert.equal(warned.mock.calls.length, 1);
  });

  it('changes nothing when the DNS does not answer', async () => {
    const accounts = await store();
    const alice = await accounts.signIn({ provider: 'email', subject: 'a@acme.dev', email: 'a@acme.dev' });
    const workspace = await accounts.createWorkspace('Acme', alice.id);
    const acme = await accounts.addDomain(workspace.id, 'acme.dev', 0);
    await accounts.noteDomainCheck(acme.id, 'found', 1_000);

    await recheckDomains(accounts, silent, 1_000 + RECHECK_MS + 1);

    const [kept] = await accounts.domains(workspace.id);
    assert.equal(kept?.verifiedAt, 1_000);
    assert.equal(kept?.lostAt, undefined);
    assert.equal(proofState(kept ?? {}, 1_000 + RECHECK_MS + 1), 'proven');
  });
});

// --- Through the routes: the console, then the extension. The accounts are in PostgreSQL (PGlite).

/** The resolver of a call that names none: a test that reaches it would have asked a real DNS. */
const noRealDns: TxtResolver = async (name) => {
  throw new Error(`a test asked the DNS for ${name}`);
};

function call(
  env: World,
  method: string,
  path: string,
  options: CallOptions = {},
  context: Partial<RequestContext> = {},
): Promise<Response> {
  return callOn(env, method, path, options, { resolveTxt: noRealDns, ...context });
}

const signIn = signInTo;

type View = {
  id: string;
  domain: string;
  state: string;
  record: { type: string; name: string; value: string };
  previews: string;
  previewsSite?: string;
  lostAt?: string;
  unanswered?: boolean;
};

/** A workspace of Alice with one site, and a session of the extension in it. */
async function world(env: World) {
  const alice = await signIn(env, 'alice@acme.dev');
  const workspace = await workspaceIn(env, alice.token);
  const added = await call(env, 'POST', `/console/workspaces/${workspace}/sites`, {
    token: alice.token,
    body: { url: 'https://acme.dev' },
  });
  const site = ((await added.json()) as { id: string }).id;
  const { code } = await createPairing(env.sessions, { subject: alice.id, workspace });
  const redeemed = await redeemPairing(env.sessions, code, env.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return { alice, workspace, site, extension: redeemed.session.accessToken };
}

/** What `GET /session/sites` says of the previews of each site. */
async function previewsSeen(env: World, token: string): Promise<Record<string, string[] | undefined>> {
  const response = await call(env, 'GET', '/session/sites', { token, origin: EXTENSION });
  assert.equal(response.status, 200);
  const { sites } = (await response.json()) as { sites: { id: string; previews?: string[] }[] };

  return Object.fromEntries(sites.map((site) => [site.id, site.previews]));
}

describe('a domain in the console, and the previews it covers (FRU-103)', () => {
  it('shows the record to write, proves the domain when the DNS holds it, and covers the previews of a site', async () => {
    const env = await envWith();
    const { alice, workspace, site, extension } = await world(env);
    const base = `/console/workspaces/${workspace}/domains`;

    const added = await call(env, 'POST', base, {
      token: alice.token,
      body: { domain: 'https://*.Preview.Acme.dev/' },
    });
    assert.equal(added.status, 201);
    const domain = (await added.json()) as View;
    assert.equal(domain.domain, 'preview.acme.dev');
    assert.equal(domain.state, 'pending');
    assert.deepEqual(domain.record, { type: 'TXT', ...proofRecord(workspace, 'preview.acme.dev') });
    assert.equal(domain.previews, 'https://*.preview.acme.dev');

    // Not proven: no previews, whatever the console asks.
    const early = await call(env, 'POST', `${base}/${domain.id}/previews`, { token: alice.token, body: { site } });
    assert.equal(early.status, 409);
    assert.deepEqual(await previewsSeen(env, extension), { [site]: undefined });

    const dns = zone({ [domain.record.name]: [[domain.record.value]] });
    const checked = await call(env, 'POST', `${base}/${domain.id}/check`, { token: alice.token }, { resolveTxt: dns });
    assert.equal(((await checked.json()) as View).state, 'proven');

    const covered = await call(env, 'POST', `${base}/${domain.id}/previews`, { token: alice.token, body: { site } });
    assert.equal(covered.status, 200);
    assert.equal(((await covered.json()) as View).previewsSite, site);
    assert.deepEqual(await previewsSeen(env, extension), { [site]: ['https://*.preview.acme.dev'] });

    // Taken away from the console.
    await call(env, 'POST', `${base}/${domain.id}/previews`, { token: alice.token, body: { site: null } });
    assert.deepEqual(await previewsSeen(env, extension), { [site]: undefined });
  });

  it('stops covering the previews when the record is gone, and says since when', async () => {
    const env = await envWith();
    const { alice, workspace, site, extension } = await world(env);
    const base = `/console/workspaces/${workspace}/domains`;
    const domain = (await (
      await call(env, 'POST', base, { token: alice.token, body: { domain: 'acme.dev' } })
    ).json()) as View;
    const records: Record<string, string[][]> = { [domain.record.name]: [[domain.record.value]] };
    const dns = zone(records);
    const t0 = Date.now();
    await call(env, 'POST', `${base}/${domain.id}/check`, { token: alice.token }, { resolveTxt: dns });
    await call(env, 'POST', `${base}/${domain.id}/previews`, { token: alice.token, body: { site } });
    assert.deepEqual(await previewsSeen(env, extension), { [site]: ['https://*.acme.dev'] });

    // The owner of the zone takes the record away, and the next pass asks the DNS.
    delete records[domain.record.name];
    mockMethod(console, 'warn', () => {});
    const accounts = env.accounts;
    await recheckDomains(accounts, dns, t0 + RECHECK_MS + 60_000);

    assert.deepEqual(await previewsSeen(env, extension), { [site]: undefined });
    const listed = (await (await call(env, 'GET', base, { token: alice.token })).json()) as { domains: View[] };
    assert.equal(listed.domains[0]?.state, 'lost');
    assert.equal(listed.domains[0]?.lostAt, new Date(t0 + RECHECK_MS + 60_000).toISOString());
    // The site is still named: the previews come back with the record, and the console says why not now.
    assert.equal(listed.domains[0]?.previewsSite, site);

    records[domain.record.name] = [[domain.record.value]];
    await recheckDomains(accounts, dns, t0 + 2 * RECHECK_MS + 120_000);
    assert.deepEqual(await previewsSeen(env, extension), { [site]: ['https://*.acme.dev'] });
  });

  it('covers nothing for a workspace whose record is not the one in the DNS, even under a domain another one proved', async () => {
    const env = await envWith();
    const acme = await world(env);
    const bob = await signIn(env, 'bob@globex.dev');
    const theirs = (
      (await (
        await call(env, 'POST', '/console/workspaces', { token: bob.token, body: { name: 'Globex' } })
      ).json()) as { id: string }
    ).id;
    const theirSite = (
      (await (
        await call(env, 'POST', `/console/workspaces/${theirs}/sites`, {
          token: bob.token,
          body: { url: 'https://x.dev' },
        })
      ).json()) as { id: string }
    ).id;

    // Acme proves acme.dev. Globex asks for a domain under it, and for acme.dev itself.
    const proven = (await (
      await call(env, 'POST', `/console/workspaces/${acme.workspace}/domains`, {
        token: acme.alice.token,
        body: { domain: 'acme.dev' },
      })
    ).json()) as View;
    const dns = zone({ [proven.record.name]: [[proven.record.value]] });
    await call(
      env,
      'POST',
      `/console/workspaces/${acme.workspace}/domains/${proven.id}/check`,
      { token: acme.alice.token },
      { resolveTxt: dns },
    );

    for (const name of ['preview.acme.dev', 'acme.dev']) {
      const claimed = (await (
        await call(env, 'POST', `/console/workspaces/${theirs}/domains`, { token: bob.token, body: { domain: name } })
      ).json()) as View;
      const checked = await call(
        env,
        'POST',
        `/console/workspaces/${theirs}/domains/${claimed.id}/check`,
        { token: bob.token },
        { resolveTxt: dns },
      );
      assert.equal(((await checked.json()) as View).state, 'pending', name);
      const covered = await call(env, 'POST', `/console/workspaces/${theirs}/domains/${claimed.id}/previews`, {
        token: bob.token,
        body: { site: theirSite },
      });
      assert.equal(covered.status, 409, name);
    }

    // Nor can Globex use the domain of Acme: it answers like one that does not exist.
    const borrowed = await call(env, 'POST', `/console/workspaces/${theirs}/domains/${proven.id}/previews`, {
      token: bob.token,
      body: { site: theirSite },
    });
    assert.equal(borrowed.status, 404);
    // And Acme cannot name a site of Globex.
    const lent = await call(env, 'POST', `/console/workspaces/${acme.workspace}/domains/${proven.id}/previews`, {
      token: acme.alice.token,
      body: { site: theirSite },
    });
    assert.equal(lent.status, 404);
  });

  it('says when the DNS did not answer, and changes nothing', async () => {
    const env = await envWith();
    const { alice, workspace } = await world(env);
    const base = `/console/workspaces/${workspace}/domains`;
    const domain = (await (
      await call(env, 'POST', base, { token: alice.token, body: { domain: 'acme.dev' } })
    ).json()) as View;

    const checked = (await (
      await call(env, 'POST', `${base}/${domain.id}/check`, { token: alice.token }, { resolveTxt: silent })
    ).json()) as View;

    assert.equal(checked.state, 'pending');
    assert.equal(checked.unanswered, true);
  });

  it('asks the DNS once for two clicks in a row', async () => {
    const env = await envWith();
    const { alice, workspace } = await world(env);
    const base = `/console/workspaces/${workspace}/domains`;
    const domain = (await (
      await call(env, 'POST', base, { token: alice.token, body: { domain: 'acme.dev' } })
    ).json()) as View;
    const dns = zone();

    await call(env, 'POST', `${base}/${domain.id}/check`, { token: alice.token }, { resolveTxt: dns });
    await call(env, 'POST', `${base}/${domain.id}/check`, { token: alice.token }, { resolveTxt: dns });

    assert.deepEqual(dns.asked, ['_fruitback.acme.dev']);
  });

  it('refuses what is not a domain, a domain too many, and a member who is not an admin', async () => {
    const env = await envWith();
    const { alice, workspace } = await world(env);
    const base = `/console/workspaces/${workspace}/domains`;

    assert.equal((await call(env, 'POST', base, { token: alice.token, body: { domain: 'localhost' } })).status, 400);
    for (let index = 0; index < 20; index += 1) {
      assert.equal(
        (await call(env, 'POST', base, { token: alice.token, body: { domain: `d${index}.acme.dev` } })).status,
        201,
      );
    }
    const over = await call(env, 'POST', base, { token: alice.token, body: { domain: 'one-more.acme.dev' } });
    assert.equal(over.status, 409);
    assert.deepEqual(await over.json(), { error: 'too-many-domains', max: 20 });
    // The same domain again is not one more.
    assert.equal((await call(env, 'POST', base, { token: alice.token, body: { domain: 'd0.acme.dev' } })).status, 201);

    const bob = await signIn(env, 'bob@acme.dev');
    await memberOf(env, workspace, bob.id, 'member');

    assert.equal((await call(env, 'GET', base, { token: bob.token })).status, 403);
    assert.equal((await call(env, 'POST', base, { token: bob.token, body: { domain: 'x.dev' } })).status, 403);
  });

  it('removes a domain, and the previews it covered go with it', async () => {
    const env = await envWith();
    const { alice, workspace, site, extension } = await world(env);
    const base = `/console/workspaces/${workspace}/domains`;
    const domain = (await (
      await call(env, 'POST', base, { token: alice.token, body: { domain: 'acme.dev' } })
    ).json()) as View;
    const dns = zone({ [domain.record.name]: [[domain.record.value]] });
    await call(env, 'POST', `${base}/${domain.id}/check`, { token: alice.token }, { resolveTxt: dns });
    await call(env, 'POST', `${base}/${domain.id}/previews`, { token: alice.token, body: { site } });

    assert.equal((await call(env, 'DELETE', `${base}/${domain.id}`, { token: alice.token })).status, 204);

    assert.deepEqual(await previewsSeen(env, extension), { [site]: undefined });
    assert.equal((await call(env, 'DELETE', `${base}/${domain.id}`, { token: alice.token })).status, 404);
  });
});
