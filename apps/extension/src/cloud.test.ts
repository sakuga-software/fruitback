import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApply } from './bridge.ts';
import {
  accountLanguage,
  ADDABLE_OVER_HTTP,
  addSite,
  addableFromPopup,
  addableWorkspaces,
  cloudEntry,
  finishAdd,
  offerFor,
  parseWorkspaceSites,
  setSiteSettings,
  sitesOf,
  sourceOffer,
} from './cloud.ts';
import { type LanguageArea, storedLanguage } from './language.ts';
import { rememberLanguage } from './language-sync.ts';
import { CHANNEL, type BridgeMessage, parseBridgeMessage } from './protocol.ts';
import { parseSite } from './sites.ts';
import type { AccessResult } from './session.ts';

const LISTED = {
  workspace: { id: 'ws_1', name: 'Acme' },
  sites: [
    { id: 'site_1', origin: 'https://staging.acme.dev', visibility: 'members' },
    { id: 'site_2', origin: 'https://acme.dev', visibility: 'everyone' },
  ],
};

const GRANTED: AccessResult = {
  ok: true,
  grant: { accessToken: 'tok', expiresAt: Date.now() + 600_000 },
} as AccessResult;

/** A worker that answers the list to the right token, and counts who asked. */
function worker(body: unknown = LISTED, status = 200) {
  const asked: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    asked.push(url);
    const token = (init?.headers as Record<string, string> | undefined)?.Authorization;

    return token === 'Bearer tok'
      ? new Response(JSON.stringify(body), { status })
      : new Response('{}', { status: 401 });
  }) as typeof fetch;

  return { asked, fetcher };
}

describe('the sites the welcome page turns on (FRU-483)', () => {
  const seams = (fetcher: typeof fetch) => ({
    endpoints: async () => ['https://api.fruitback.test'],
    ensureAccess: async () => GRANTED,
    fetcher,
  });

  it('lists each site of the account as an offer for its own origin, and leaves a pattern out', async () => {
    const { fetcher } = worker({
      ...LISTED,
      sites: [...LISTED.sites, { id: 'site_3', origin: 'https://*.preview.acme.dev', visibility: 'members' }],
    });
    const sites = await sitesOf('https://api.fruitback.test', seams(fetcher));

    assert.deepEqual(
      sites?.map((offer) => [offer.pattern, offer.site.id, offer.workspace.name]),
      [
        ['https://staging.acme.dev', 'site_1', 'Acme'],
        ['https://acme.dev', 'site_2', 'Acme'],
      ],
    );
    assert.deepEqual(cloudEntry(sites![0]!), parseSite(cloudEntry(sites![0]!)));
    assert.equal(cloudEntry(sites![0]!).endpoint, 'https://api.fruitback.test');
  });

  it('says nothing when Fruitback does not answer, which is not « no site »', async () => {
    assert.equal(await sitesOf('https://api.fruitback.test', seams(worker({}, 500).fetcher)), undefined);
    assert.deepEqual(await sitesOf('https://api.fruitback.test', seams(worker({ ...LISTED, sites: [] }).fetcher)), []);
  });
});

describe('the sites of the workspace (FRU-101)', () => {
  it('offers the site the tab is on, through the session that lists it', async () => {
    const { fetcher, asked } = worker();
    const offer = await offerFor('https://staging.acme.dev', {
      endpoints: async () => ['https://api.fruitback.test'],
      ensureAccess: async () => GRANTED,
      fetcher,
    });

    assert.deepEqual(offer, {
      endpoint: 'https://api.fruitback.test',
      workspace: { id: 'ws_1', name: 'Acme' },
      site: {
        id: 'site_1',
        origin: 'https://staging.acme.dev',
        visibility: 'members',
        workspace: { id: 'ws_1', name: 'Acme' },
      },
      pattern: 'https://staging.acme.dev',
    });
    assert.deepEqual(asked, ['https://api.fruitback.test/session/sites']);
  });

  it('offers nothing for a tab that is not a site of the workspace', async () => {
    const offer = await offerFor('https://elsewhere.dev', {
      endpoints: async () => ['https://api.fruitback.test'],
      ensureAccess: async () => GRANTED,
      fetcher: worker().fetcher,
    });

    assert.equal(offer, undefined);
  });

  it('never sends the token over plain http, and asks nothing of a session it cannot use', async () => {
    const { fetcher, asked } = worker();
    const insecure = await offerFor('https://staging.acme.dev', {
      endpoints: async () => ['http://api.fruitback.test'],
      ensureAccess: async () => GRANTED,
      fetcher,
    });
    const refused = await offerFor('https://staging.acme.dev', {
      endpoints: async () => ['https://api.fruitback.test'],
      ensureAccess: async () => ({ ok: false, reason: 'not-paired' }) as AccessResult,
      fetcher,
    });

    assert.equal(insecure, undefined);
    assert.equal(refused, undefined);
    assert.deepEqual(asked, []);
  });

  it('reads a worker with no accounts, and one that fails, as no offer', async () => {
    for (const [body, status] of [
      [{ error: 'not-found' }, 404],
      ['not json', 200],
    ] as const) {
      const offer = await offerFor('https://staging.acme.dev', {
        endpoints: async () => ['https://api.fruitback.test'],
        ensureAccess: async () => GRANTED,
        fetcher: worker(body, status).fetcher,
      });
      assert.equal(offer, undefined);
    }
  });

  it('parses the list field by field: a bad site costs that site', () => {
    assert.deepEqual(parseWorkspaceSites({ ...LISTED, sites: [...LISTED.sites, { id: 3 }, null] })?.sites.length, 2);
    assert.equal(parseWorkspaceSites({ sites: [] }), undefined);
  });
});

/** The list of an account's session (FRU-238), with the counts of FRU-237. */
const ACCOUNT = {
  account: true,
  workspaces: [
    { id: 'ws_1', name: 'Sakuga', role: 'owner' },
    { id: 'ws_2', name: 'Northwind', role: 'guest' },
  ],
  sites: [
    {
      id: 'site_1',
      origin: 'https://staging.acme.dev',
      visibility: 'members',
      workspace: 'ws_1',
      notes: { new: 3, todo: 2, progress: 4, done: 2, closed: 1 },
    },
    { id: 'site_2', origin: 'https://client.fr', visibility: 'everyone', workspace: 'ws_2' },
  ],
};

describe('where the notes of a site go, and the fixes to check (FRU-295)', () => {
  it('keeps a label and a whole count, and reads anything else as unknown, never as nothing', () => {
    const site = { ...ACCOUNT.sites[0], destination: { label: '  Linear ·  Northwind ' }, toCheck: 2 };
    const [read] = parseWorkspaceSites({ ...ACCOUNT, sites: [site] })?.sites ?? [];
    assert.deepEqual(read?.destination, { label: 'Linear · Northwind' });
    assert.equal(read?.toCheck, 2);

    const zero = parseWorkspaceSites({ ...ACCOUNT, sites: [{ ...site, toCheck: 0 }] })?.sites[0];
    assert.equal(zero?.toCheck, 0);
    for (const [destination, toCheck] of [
      [{ label: '' }, -1],
      [{ label: 3 }, 1.5],
      ['Linear', '2'],
      [null, null],
    ] as const) {
      const [odd] = parseWorkspaceSites({ ...ACCOUNT, sites: [{ ...site, destination, toCheck }] })?.sites ?? [];
      assert.equal(odd?.destination, undefined);
      assert.equal(odd?.toCheck, undefined);
    }
    // Absent on the wire: absent here, not zero.
    assert.equal('toCheck' in (parseWorkspaceSites(ACCOUNT)?.sites[0] ?? {}), false);
  });
});

describe('the sites of every workspace of an account (FRU-254)', () => {
  it('says which workspace each site is of, and the role held there', () => {
    const listed = parseWorkspaceSites(ACCOUNT);

    assert.equal(listed?.account, true);
    assert.deepEqual(
      listed?.workspaces.map((each) => each.role),
      ['owner', 'guest'],
    );
    assert.deepEqual(
      listed?.sites.map((site) => [site.origin, site.workspace.name]),
      [
        ['https://staging.acme.dev', 'Sakuga'],
        ['https://client.fr', 'Northwind'],
      ],
    );
  });

  it('keeps the counts of a site when they are five whole numbers, and only then', () => {
    const [first, second] = parseWorkspaceSites(ACCOUNT)?.sites ?? [];
    assert.deepEqual(first?.notes, { new: 3, todo: 2, progress: 4, done: 2, closed: 1 });
    assert.equal(second?.notes, undefined);
    for (const notes of [
      { new: 3, todo: 2, progress: 4, done: 2 },
      { new: -1, todo: 2, progress: 4, done: 2, closed: 1 },
      { new: 1.5, todo: 2, progress: 4, done: 2, closed: 1 },
      { new: '3', todo: 2, progress: 4, done: 2, closed: 1 },
    ]) {
      const site = { ...ACCOUNT.sites[0], notes };
      assert.equal(
        parseWorkspaceSites({ ...ACCOUNT, sites: [site] })?.sites[0]?.notes,
        undefined,
        JSON.stringify(notes),
      );
    }
  });

  it('drops a site of a workspace it does not list, and an account with none lists nothing', () => {
    const stray = { id: 'site_9', origin: 'https://other.fr', visibility: 'members', workspace: 'ws_9' };
    assert.equal(parseWorkspaceSites({ ...ACCOUNT, sites: [stray] })?.sites.length, 0);
    assert.deepEqual(parseWorkspaceSites({ account: true, workspaces: [], sites: [] }), {
      account: true,
      workspaces: [],
      sites: [],
    });
  });

  it('offers a site of the second workspace with that workspace', async () => {
    const { fetcher } = worker(ACCOUNT);
    const offer = await offerFor('https://client.fr', {
      endpoints: async () => ['https://api.fruitback.test'],
      ensureAccess: async () => GRANTED,
      fetcher,
    });

    assert.deepEqual(offer?.workspace, { id: 'ws_2', name: 'Northwind', role: 'guest' });
    assert.equal(offer?.site.id, 'site_2');
  });
});

describe('a site of the workspace, once on (FRU-101)', () => {
  const offer = {
    endpoint: 'https://api.fruitback.test',
    workspace: { id: 'ws_1', name: 'Acme' },
    site: {
      id: 'site_1',
      origin: 'https://staging.acme.dev',
      visibility: 'members' as const,
      workspace: { id: 'ws_1', name: 'Acme' },
    },
    pattern: 'https://staging.acme.dev',
  };

  it('is a team entry the extension mounts, and it survives a read from storage', () => {
    const entry = cloudEntry(offer);

    assert.deepEqual(entry, {
      endpoint: 'https://api.fruitback.test',
      enabled: true,
      mode: 'team',
      mount: { clientId: 'site_1', workspace: 'Acme' },
    });
    assert.deepEqual(parseSite(JSON.parse(JSON.stringify(entry))), entry);
  });

  it('mounts the widget relayed, with no label of ours, where a team entry without a mount only announces', async () => {
    const posts: BridgeMessage[] = [];
    await createApply({ readSite: async () => cloudEntry(offer), post: (message) => void posts.push(message) })();
    await createApply({
      readSite: async () => ({ mode: 'team', endpoint: 'https://api.fruitback.test', enabled: true }),
      post: (message) => void posts.push(message),
    })();

    assert.deepEqual(posts, [
      {
        channel: CHANNEL,
        kind: 'mount',
        endpoint: 'https://api.fruitback.test',
        clientId: 'site_1',
        relay: true,
      },
      { channel: CHANNEL, kind: 'announce' },
    ]);
  });

  it('carries the relay flag across the bridge as true, and nothing else as it', () => {
    const base = { channel: CHANNEL, kind: 'mount', endpoint: 'https://api.fruitback.test', clientId: 'site_1' };

    assert.equal(
      parseBridgeMessage({ ...base, relay: true })?.kind === 'mount' &&
        'relay' in (parseBridgeMessage({ ...base, relay: true }) ?? {}),
      true,
    );
    assert.equal('relay' in (parseBridgeMessage({ ...base, relay: 'yes' }) ?? {}), false);
    assert.equal('relay' in (parseBridgeMessage(base) ?? {}), false);
  });

  it('keeps no mount that names no client', () => {
    const site = parseSite({ mode: 'team', endpoint: 'https://api.fruitback.test', mount: { clientId: '  ' } });

    assert.deepEqual(site, { mode: 'team', endpoint: 'https://api.fruitback.test', enabled: true });
  });
});

/** A storage area a test can read. */
function area(initial: Record<string, unknown> = {}): LanguageArea & { values: Record<string, unknown> } {
  const values = { ...initial };

  return {
    values,
    get: async (key) => (key in values ? { [key]: values[key] } : {}),
    set: async (items) => void Object.assign(values, items),
    remove: async (key) => void delete values[key],
  };
}

const PAIRED = { endpoints: async () => ['https://api.fruitback.test'], ensureAccess: async () => GRANTED };

describe('the language of the account (FRU-131)', () => {
  it('is read from the answer of the worker, and a value that is no tag is left out', () => {
    assert.equal(parseWorkspaceSites({ ...LISTED, locale: 'fr' })?.locale, 'fr');
    assert.equal(parseWorkspaceSites({ ...LISTED, locale: 7 })?.locale, undefined);
    assert.equal(parseWorkspaceSites({ ...LISTED, locale: 'x'.repeat(36) })?.locale, undefined);
    assert.equal(parseWorkspaceSites(LISTED)?.locale, undefined);
  });

  it('comes from the first session whose worker says one', async () => {
    const { fetcher } = worker({ ...LISTED, locale: 'fr' });

    assert.deepEqual(await accountLanguage({ ...PAIRED, fetcher }), {
      locale: 'fr',
      from: 'https://api.fruitback.test',
    });
  });

  it('is asked over https only, like every call that carries the token', async () => {
    const { fetcher, asked } = worker({ ...LISTED, locale: 'fr' });
    const answer = await accountLanguage({ ...PAIRED, endpoints: async () => ['http://worker.acme.dev'], fetcher });

    assert.deepEqual(answer, {});
    assert.deepEqual(asked, []);
  });

  it('is kept for the next popup', async () => {
    const kept = area();
    await rememberLanguage(kept, { ...PAIRED, fetcher: worker({ ...LISTED, locale: 'fr' }).fetcher });

    assert.equal(await storedLanguage(kept), 'fr');
  });

  it('is removed when the account holds none, and when no session is left', async () => {
    const answered = area({ language: 'fr' });
    await rememberLanguage(answered, { ...PAIRED, fetcher: worker(LISTED).fetcher });
    assert.equal(await storedLanguage(answered), undefined);

    const loggedOut = area({ language: 'fr' });
    await rememberLanguage(loggedOut, { ...PAIRED, endpoints: async () => [], fetcher: worker().fetcher });
    assert.equal(await storedLanguage(loggedOut), undefined);
  });

  it('is not kept when the log out lands while the worker answers', async () => {
    const kept = area();
    let paired = ['https://api.fruitback.test'];
    const { fetcher } = worker({ ...LISTED, locale: 'fr' });
    await rememberLanguage(kept, {
      ...PAIRED,
      endpoints: async () => paired,
      fetcher: (async (...call: Parameters<typeof fetch>) => {
        const answer = await fetcher(...call);
        paired = [];

        return answer;
      }) as typeof fetch,
    });

    assert.equal(await storedLanguage(kept), undefined);
  });

  it('is removed when the only worker left keeps no accounts', async () => {
    // Logged out of the Cloud, still paired with a self-hosted worker: nobody speaks for a language.
    for (const status of [405]) {
      const kept = area({ language: 'fr' });
      await rememberLanguage(kept, { ...PAIRED, fetcher: worker({ error: 'no-route' }, status).fetcher });

      assert.equal(await storedLanguage(kept), undefined, `a ${status} is a worker with no accounts`);
    }
  });

  it('offers no site from a worker that keeps no accounts', async () => {
    const offer = await offerFor('https://staging.acme.dev', {
      ...PAIRED,
      fetcher: worker({ error: 'not-found' }, 404).fetcher,
    });

    assert.equal(offer, undefined);
  });

  it('is not kept from a session that ended while it answered, when another session is left', async () => {
    const kept = area();
    let paired = ['https://api.fruitback.test', 'https://self.hosted.test'];
    const fetcher = (async (url: string) => {
      if (!url.startsWith('https://api.fruitback.test')) return new Response('{}', { status: 405 });
      // The log out of this worker lands while it answers. The other session stays.
      paired = ['https://self.hosted.test'];

      return new Response(JSON.stringify({ ...LISTED, locale: 'fr' }), { status: 200 });
    }) as typeof fetch;
    await rememberLanguage(kept, { ...PAIRED, endpoints: async () => paired, fetcher });

    assert.equal(await storedLanguage(kept), undefined);
  });

  it('stays when the worker of the account is down and another worker keeps no accounts', async () => {
    // Paired with the Cloud, which is down, and with a self-hosted worker, which answers 405.
    for (const order of [
      ['https://api.fruitback.test', 'https://self.hosted.test'],
      ['https://self.hosted.test', 'https://api.fruitback.test'],
    ]) {
      const kept = area({ language: 'fr' });
      const fetcher = (async (url: string) =>
        url.startsWith('https://self.hosted.test')
          ? new Response('{}', { status: 405 })
          : new Response('{}', { status: 503 })) as typeof fetch;
      await rememberLanguage(kept, { ...PAIRED, endpoints: async () => order, fetcher });

      assert.equal(await storedLanguage(kept), 'fr', order.join(', then '));
    }
  });

  it('takes the language one worker says, when another one is down', async () => {
    const kept = area();
    const fetcher = (async (url: string) =>
      url.startsWith('https://down.test')
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ ...LISTED, locale: 'fr' }), { status: 200 })) as typeof fetch;
    await rememberLanguage(kept, {
      ...PAIRED,
      endpoints: async () => ['https://down.test', 'https://api.fruitback.test'],
      fetcher,
    });

    assert.equal(await storedLanguage(kept), 'fr');
  });

  it('stays when no worker answers: an outage does not change the language', async () => {
    const down = area({ language: 'fr' });
    await rememberLanguage(down, { ...PAIRED, fetcher: worker({}, 502).fetcher });
    assert.equal(await storedLanguage(down), 'fr');

    for (const status of [401, 404, 429]) {
      const later = area({ language: 'fr' });
      await rememberLanguage(later, { ...PAIRED, fetcher: worker({}, status).fetcher });
      assert.equal(await storedLanguage(later), 'fr', `a ${status} is no answer about a language`);
    }

    const refused = area({ language: 'fr' });
    await rememberLanguage(refused, {
      ...PAIRED,
      ensureAccess: async () => ({ ok: false, reason: 'unavailable' }) as AccessResult,
      fetcher: worker().fetcher,
    });
    assert.equal(await storedLanguage(refused), 'fr');
  });

  it('reads nothing from a stored value that is no tag, and nothing when storage throws', async () => {
    assert.equal(await storedLanguage(area({ language: { tag: 'fr' } })), undefined);
    assert.equal(
      await storedLanguage({ ...area(), get: async () => Promise.reject(new Error('no storage')) }),
      undefined,
    );
  });
});

describe('adding the site of the tab to a workspace (FRU-255)', () => {
  const SAKUGA = { id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true };
  const NORTHWIND = { id: 'ws_2', name: 'Northwind', role: 'guest' };
  const seamsWith = (fetcher: typeof fetch) => ({
    endpoints: async () => ['https://api.fruitback.test'],
    ensureAccess: async () => GRANTED,
    fetcher,
  });

  it('offers the workspaces where the account may add a site, and none to a pairing', async () => {
    const { fetcher } = worker({ ...ACCOUNT, workspaces: [SAKUGA, NORTHWIND] });
    assert.deepEqual(await addableWorkspaces('https://api.fruitback.test', seamsWith(fetcher)), [SAKUGA]);
    assert.deepEqual(await addableWorkspaces('https://api.fruitback.test', seamsWith(worker().fetcher)), []);
    assert.equal(await addableWorkspaces('https://api.fruitback.test', seamsWith(worker({}, 503).fetcher)), undefined);
  });

  it('posts the workspace and the origin, with the token, and gives the site back as an offer', async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      sent.push({ url, ...(init === undefined ? {} : { init }) });

      return new Response(
        JSON.stringify({
          site: { id: 'site_9', origin: 'https://preview.client.fr', visibility: 'members', workspace: 'ws_1' },
        }),
        { status: 201 },
      );
    }) as typeof fetch;

    const added = await addSite('https://api.fruitback.test', SAKUGA, 'https://preview.client.fr', seamsWith(fetcher));

    assert.deepEqual(added, {
      ok: true,
      offer: {
        endpoint: 'https://api.fruitback.test',
        workspace: SAKUGA,
        site: { id: 'site_9', origin: 'https://preview.client.fr', visibility: 'members', workspace: SAKUGA },
        pattern: 'https://preview.client.fr',
      },
    });
    assert.equal(sent[0]?.url, 'https://api.fruitback.test/session/sites');
    assert.equal(sent[0]?.init?.method, 'POST');
    assert.equal(new Headers(sent[0]?.init?.headers).get('Authorization'), 'Bearer tok');
    assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), {
      workspace: 'ws_1',
      origin: 'https://preview.client.fr',
    });
  });

  it('says why it added nothing, and believes no site of another address', async () => {
    for (const [status, body, reason] of [
      [403, { error: 'forbidden', role: 'member' }, 'forbidden'],
      [404, { error: 'not-found' }, 'forbidden'],
      [429, { error: 'rate-limited' }, 'rate-limited'],
      [401, { error: 'identity-required' }, 'signed-out'],
      // FRU-537: the worker does not add this origin from the popup: no outage, and no « Try again ».
      [400, { error: 'invalid-url' }, 'insecure-origin'],
      [400, { error: 'invalid-body' }, 'unavailable'],
      [502, {}, 'unavailable'],
      [
        201,
        { site: { id: 's', origin: 'https://elsewhere.fr', visibility: 'members', workspace: 'ws_1' } },
        'unavailable',
      ],
      [
        201,
        { site: { id: 's', origin: 'https://preview.client.fr', visibility: 'members', workspace: 'ws_9' } },
        'unavailable',
      ],
    ] as const) {
      const fetcher = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
      assert.deepEqual(
        await addSite('https://api.fruitback.test', SAKUGA, 'https://preview.client.fr', seamsWith(fetcher)),
        { ok: false, reason },
        `${status} ${JSON.stringify(body)}`,
      );
    }
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    assert.deepEqual(
      await addSite('https://api.fruitback.test', SAKUGA, 'https://preview.client.fr', seamsWith(down)),
      {
        ok: false,
        reason: 'unavailable',
      },
    );
  });
});

describe('the sites the popup may add (FRU-537)', () => {
  it('adds https, and the loopback over http, as the worker does', () => {
    for (const origin of [
      'https://preview.client.fr',
      'http://localhost:5177',
      'http://127.0.0.1:8080',
      'http://[::1]:3000',
    ]) {
      assert.equal(addableFromPopup(origin), true, origin);
    }
    for (const origin of [
      'http://staging.client.fr',
      'http://192.168.1.20:3000',
      'ftp://client.fr',
      'not an address',
    ]) {
      assert.equal(addableFromPopup(origin), false, origin);
    }
  });

  it('holds the same loopback hosts as the worker that adds the site (review of #754)', () => {
    const worker = readFileSync(new URL('../../worker/src/session-site-add.ts', import.meta.url), 'utf8');
    const listed = /const LOOPBACK = new Set\(\[(.*?)\]\);/.exec(worker)?.[1] ?? '';
    const hosts = [...listed.matchAll(/'([^']+)'/g)].map(([, host]) => host);

    assert.ok(hosts.length >= 3, `read ${hosts.length} hosts of LOOPBACK in session-site-add.ts`);
    assert.deepEqual([...ADDABLE_OVER_HTTP].sort(), hosts.sort());
  });

  it('asks nothing of the worker for an http site, and says why', async () => {
    let asked = 0;
    const fetcher = (async () => {
      asked += 1;

      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const added = await addSite(
      'https://api.fruitback.test',
      { id: 'ws_1', name: 'Sakuga' },
      'http://staging.client.fr',
      { ensureAccess: async () => GRANTED, fetcher },
    );
    assert.deepEqual(added, { ok: false, reason: 'insecure-origin' });
    assert.equal(asked, 0);
  });
});

describe('who sees the notes and where they go, from the popup (FRU-453)', () => {
  const PLACE = { connector: 'conn_1', teamId: 'team_1' };
  const SAKUGA = { id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true };
  const seamsWith = (fetcher: typeof fetch) => ({ ensureAccess: async () => GRANTED, fetcher });

  it('reads the sources of a workspace and where a site sends, and drops what is malformed', () => {
    const listed = parseWorkspaceSites({
      account: true,
      workspaces: [
        {
          id: 'ws_1',
          name: 'Sakuga',
          canAddSite: true,
          sources: [
            { id: 'conn_1', kind: 'linear', label: 'Linear · Acme' },
            { id: 'conn_2', kind: 'jira', label: 'Jira' },
            { id: 'conn_3', kind: 'rest' },
            { id: 'conn_4', kind: 'github', label: 'GitHub · acme' },
          ],
        },
        { id: 'ws_2', name: 'Northwind' },
      ],
      sites: [
        { id: 's1', origin: 'https://a.fr', visibility: 'members', workspace: 'ws_1', place: PLACE },
        { id: 's2', origin: 'https://b.fr', visibility: 'members', workspace: 'ws_1', place: null },
        { id: 's3', origin: 'https://c.fr', visibility: 'members', workspace: 'ws_1', place: { teamId: 'x' } },
      ],
    });
    assert.deepEqual(listed?.workspaces, [
      {
        id: 'ws_1',
        name: 'Sakuga',
        canAddSite: true,
        sources: [
          { id: 'conn_1', kind: 'linear', label: 'Linear · Acme' },
          { id: 'conn_4', kind: 'github', label: 'GitHub · acme' },
        ],
      },
      { id: 'ws_2', name: 'Northwind' },
    ]);
    assert.deepEqual(
      listed?.sites.map((site) => site.place),
      [PLACE, null, undefined],
    );
  });

  it('posts the site, the visibility and the ids of the place, and gives the site back', async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      sent.push({ url, ...(init === undefined ? {} : { init }) });

      return new Response(
        JSON.stringify({
          site: {
            id: 'site_9',
            origin: 'https://preview.client.fr',
            visibility: 'everyone',
            workspace: 'ws_1',
            destination: { label: 'Linear · Northwind' },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const set = await setSiteSettings(
      'https://api.fruitback.test',
      SAKUGA,
      'site_9',
      { visibility: 'everyone', place: { ...PLACE, projectId: 'proj_1' } },
      seamsWith(fetcher),
    );

    assert.equal(set.ok, true);
    assert.equal(sent[0]?.url, 'https://api.fruitback.test/session/sites/settings');
    assert.equal(sent[0]?.init?.method, 'POST');
    assert.equal(new Headers(sent[0]?.init?.headers).get('Authorization'), 'Bearer tok');
    assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), {
      workspace: 'ws_1',
      site: 'site_9',
      visibility: 'everyone',
      place: { connector: 'conn_1', teamId: 'team_1', projectId: 'proj_1' },
    });

    await setSiteSettings('https://api.fruitback.test', SAKUGA, 'site_9', { place: null }, seamsWith(fetcher));
    assert.deepEqual(JSON.parse(String(sent[1]?.init?.body)), { workspace: 'ws_1', site: 'site_9', place: null });
  });

  it('says why it changed nothing, and believes no answer about another site', async () => {
    for (const [status, body, reason] of [
      [403, { error: 'forbidden', role: 'member' }, 'forbidden'],
      [404, { error: 'not-found' }, 'forbidden'],
      [409, { error: 'site-has-destinations' }, 'several-places'],
      [400, { error: 'invalid-place' }, 'unknown-place'],
      [401, { error: 'identity-required' }, 'signed-out'],
      [502, {}, 'unavailable'],
      [200, { site: { id: 'other', origin: 'https://x.fr', visibility: 'members', workspace: 'ws_1' } }, 'unavailable'],
    ] as const) {
      const fetcher = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
      assert.deepEqual(
        await setSiteSettings(
          'https://api.fruitback.test',
          SAKUGA,
          'site_9',
          { visibility: 'members' },
          seamsWith(fetcher),
        ),
        { ok: false, reason },
        `${status} ${JSON.stringify(body)}`,
      );
    }
  });

  it('asks what a source offers with the token, and reads teams, repositories and an address', async () => {
    const asked: string[] = [];
    const answer = (body: unknown, status = 200) =>
      (async (url: string) => {
        asked.push(url);

        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;

    assert.deepEqual(
      await sourceOffer(
        'https://api.fruitback.test',
        'ws_1',
        'conn_1',
        seamsWith(
          answer({
            kind: 'linear',
            teams: [
              { id: 't1', name: 'Design', key: 'DES', projects: [{ id: 'p1', name: 'Site' }, { id: 7 }] },
              { name: 'no id' },
            ],
          }),
        ),
      ),
      { kind: 'linear', teams: [{ id: 't1', name: 'Design', key: 'DES', projects: [{ id: 'p1', name: 'Site' }] }] },
    );
    assert.equal(asked[0], 'https://api.fruitback.test/session/sites/places?workspace=ws_1&connector=conn_1');
    assert.deepEqual(
      await sourceOffer(
        'https://api.fruitback.test',
        'ws_1',
        'c',
        seamsWith(answer({ kind: 'github', repositories: [{ fullName: 'acme/web', private: true }, {}] })),
      ),
      { kind: 'github', repositories: [{ fullName: 'acme/web' }] },
    );
    assert.deepEqual(
      await sourceOffer('https://api.fruitback.test', 'ws_1', 'c', seamsWith(answer({ kind: 'rest' }))),
      { kind: 'rest' },
    );
    for (const failed of [answer({}, 502), answer({ kind: 'jira' })]) {
      assert.equal(await sourceOffer('https://api.fruitback.test', 'ws_1', 'c', seamsWith(failed)), undefined);
    }
  });
});

describe('an add that a permission prompt cut short, finished later (FRU-454)', () => {
  const INTENT = {
    endpoint: 'https://api.fruitback.test',
    workspace: { id: 'ws_1', name: 'Sakuga' },
    settings: { visibility: 'everyone' as const },
  };
  const SITE = { id: 'site_9', origin: 'https://preview.client.fr', visibility: 'members', workspace: 'ws_1' };
  const answering = (add: number, set: number, sent: string[] = []) =>
    (async (url: string) => {
      sent.push(url);
      const settings = url.endsWith('/settings');
      const status = settings ? set : add;

      return new Response(JSON.stringify({ site: { ...SITE, visibility: settings ? 'everyone' : 'members' } }), {
        status,
      });
    }) as unknown as typeof fetch;
  const seams = (fetcher: typeof fetch) => ({ ensureAccess: async () => GRANTED, fetcher });

  it('adds the site, writes what was chosen, and answers the entry of the one click', async () => {
    const sent: string[] = [];
    assert.deepEqual(await finishAdd('https://preview.client.fr', INTENT, seams(answering(201, 200, sent))), {
      endpoint: 'https://api.fruitback.test',
      enabled: true,
      mode: 'team',
      mount: { clientId: 'site_9', workspace: 'Sakuga' },
    });
    assert.deepEqual(sent, [
      'https://api.fruitback.test/session/sites',
      'https://api.fruitback.test/session/sites/settings',
    ]);
    // Nothing chosen: no write of the settings.
    const plain: string[] = [];
    await finishAdd('https://preview.client.fr', { ...INTENT, settings: {} }, seams(answering(201, 200, plain)));
    assert.deepEqual(plain, ['https://api.fruitback.test/session/sites']);
  });

  it('asks again after a worker that did not answer, never after a refusal', async () => {
    const at = 'https://preview.client.fr';
    assert.equal(await finishAdd(at, INTENT, seams(answering(502, 200))), 'again');
    assert.equal(await finishAdd(at, INTENT, seams(answering(403, 200))), 'never');
    assert.equal(await finishAdd(at, INTENT, seams(answering(401, 200))), 'never');
    assert.equal(await finishAdd(at, INTENT, seams(answering(201, 502))), 'again');
    assert.equal(await finishAdd(at, INTENT, seams(answering(201, 403))), 'never');
  });
});
