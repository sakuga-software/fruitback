import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApply } from './bridge.ts';
import { cloudEntry, offerFor, parseWorkspaceSites } from './cloud.ts';
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
    const token = (init?.headers as Record<string, string>).Authorization;

    return token === 'Bearer tok'
      ? new Response(JSON.stringify(body), { status })
      : new Response('{}', { status: 401 });
  }) as typeof fetch;

  return { asked, fetcher };
}

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
      site: { id: 'site_1', origin: 'https://staging.acme.dev', visibility: 'members' },
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

describe('a site of the workspace, once on (FRU-101)', () => {
  const offer = {
    endpoint: 'https://api.fruitback.test',
    workspace: { id: 'ws_1', name: 'Acme' },
    site: { id: 'site_1', origin: 'https://staging.acme.dev', visibility: 'members' as const },
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
