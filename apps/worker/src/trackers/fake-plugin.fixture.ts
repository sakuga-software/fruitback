import { StoreError } from '../store.ts';
import {
  type Http,
  type OAuthTokens,
  type TrackerAccess,
  TrackerInputRefused,
  TrackerKeyForbidden,
  TrackerKeyRefused,
  type TrackerPlugin,
} from './plugin.ts';

/**
 * A plugin and its service, for the tests of the socle (FRU-621). The service answers at
 * `https://fake.test`, through the `http` a test hands the worker (`trackerHttp`): no port, no
 * network. It takes the kind `asana`: `useTestPlugin` puts it in the place of the plugin of that kind.
 */

export const FAKE = 'https://fake.test';
export const FAKE_CLIENT = { clientId: 'fake-client', clientSecret: 'the-fake-client-secret' };

export function fakeService() {
  const state = {
    /** The tokens the service takes now. A token taken away is a token revoked. */
    valid: new Set<string>(['typed-token']),
    /** Tokens that it knows and that may not list the places. */
    limited: new Set<string>(),
    /** The refresh tokens it would refresh. */
    refreshable: new Set<string>(),
    /** The codes it gave at its consent. */
    codes: new Set<string>(),
    /** How long the access tokens it gives last, in seconds. */
    lasts: 3_600,
    generation: 0,
    places: [
      { id: 'P1', name: 'Design' },
      { id: 'P2', name: 'Platform' },
    ],
    issues: [] as { place: string; title: string; token: string }[],
    revoked: [] as string[],
    calls: [] as string[],
    /** Runs when a refresh is asked, before the answer: another process of the worker, for a test. */
    beforeRefresh: undefined as (() => Promise<void>) | undefined,
    /** The list of the places answers a body that is not JSON. */
    garbled: false,
  };
  const mint = () => {
    state.generation += 1;
    const access = `access-${state.generation}`;
    const refresh = `refresh-${state.generation}`;
    state.valid.add(access);
    state.refreshable.add(refresh);

    return { access_token: access, refresh_token: refresh, expires_in: state.lasts };
  };
  const bearer = (init: RequestInit | undefined) =>
    String(new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '');

  const http: Http = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== FAKE) throw new TypeError(`fetch failed: ${url.origin} is not the fake service`);
    state.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/token') {
      const form = JSON.parse(String(init?.body)) as Record<string, string>;
      if (form.client_id !== FAKE_CLIENT.clientId || form.client_secret !== FAKE_CLIENT.clientSecret) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      if (form.grant_type === 'authorization_code' && state.codes.delete(form.code ?? '')) return Response.json(mint());
      if (form.grant_type === 'refresh_token') await state.beforeRefresh?.();
      if (form.grant_type === 'refresh_token' && state.refreshable.delete(form.refresh_token ?? '')) {
        return Response.json(mint());
      }

      return Response.json({ error: 'invalid_grant' }, { status: 403 });
    }
    if (url.pathname === '/revoke') {
      state.revoked.push(bearer(init));

      return new Response(null, { status: 204 });
    }
    const token = bearer(init);
    if (!state.valid.has(token)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (url.pathname === '/me') return Response.json({ name: 'Acme' });
    if (url.pathname === '/places') {
      if (state.limited.has(token)) return Response.json({ error: 'forbidden' }, { status: 403 });
      if (state.garbled) return new Response('<html>maintenance</html>', { status: 200 });
      const search = (url.searchParams.get('q') ?? '').toLowerCase();

      return Response.json(state.places.filter((each) => each.name.toLowerCase().includes(search)));
    }
    if (url.pathname === '/issues' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { place: string; title: string };
      state.issues.push({ ...body, token });

      return Response.json({ key: `FAKE-${state.issues.length}` }, { status: 201 });
    }

    return Response.json({ error: 'not-found' }, { status: 404 });
  };

  return { state, http };
}

async function call(access: TrackerAccess, path: string, init: RequestInit = {}): Promise<unknown> {
  const credential = await access.credential();
  const token = credential.via === 'token' ? credential.token : credential.accessToken;
  const response = await access
    .http(`${FAKE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    .catch(() => {
      throw new StoreError('The fake service could not be reached');
    });
  if (response.status === 401) throw new TrackerKeyRefused('The fake service refuses this token');
  if (response.status === 403) throw new TrackerKeyForbidden('The fake service refuses this place');
  if (!response.ok) throw new StoreError(`The fake service answered ${response.status}`);

  return response.json();
}

async function tokens(http: Http, form: Record<string, string>, now: number): Promise<OAuthTokens | undefined> {
  const response = await http(`${FAKE}/token`, { method: 'POST', body: JSON.stringify(form) });
  if (!response.ok) return undefined;
  const answer = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };

  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token,
    expiresAt: now + answer.expires_in * 1_000,
  };
}

export const fakePlugin: TrackerPlugin = {
  kind: 'asana',
  name: 'Fake',
  envNames: { oauth: 'FRUITBACK_ASANA_OAUTH' },
  async connect(body, { http }) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (token === '') throw new TrackerInputRefused('invalid-token');
    const response = await http(`${FAKE}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401) throw new TrackerKeyRefused('The fake service refuses this token');
    if (!response.ok) throw new StoreError('The fake service did not answer');
    const { name } = (await response.json()) as { name: string };

    return { label: `Fake · ${name}`, token };
  },
  oauth: {
    authorize: ({ clientId, redirectUri, state, challenge }) =>
      `${FAKE}/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, challenge })}`,
    exchange: ({ code, client }, http, now) =>
      tokens(
        http,
        { grant_type: 'authorization_code', code, client_id: client.clientId, client_secret: client.clientSecret },
        now,
      ),
    async refresh(refreshToken, client, http, now) {
      const response = await http(`${FAKE}/token`, {
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        }),
      }).catch(() => {
        throw new StoreError('The fake service could not be reached');
      });
      if (response.status === 403) return 'ended';
      if (!response.ok) throw new StoreError('The fake service did not refresh');
      const answer = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };

      return {
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token,
        expiresAt: now + answer.expires_in * 1_000,
      };
    },
    async identify(given, http) {
      const response = await http(`${FAKE}/me`, { headers: { Authorization: `Bearer ${given.accessToken}` } });
      if (!response.ok) return undefined;
      const { name } = (await response.json()) as { name: string };

      return { label: `Fake OAuth · ${name}`, extra: { site: 'one' } };
    },
  },
  async places(access, { search }) {
    const listed = (await call(access, `/places?q=${encodeURIComponent(search ?? '')}`)) as {
      id: string;
      name: string;
    }[];

    return { places: listed };
  },
  readPlace: (value) => (typeof value === 'string' && /^P\d{1,6}$/.test(value) ? value : undefined),
  async placeName(access, place) {
    const listed = (await call(access, '/places')) as { id: string; name: string }[];
    const found = listed.find((each) => each.id === place);

    return found === undefined ? undefined : { name: found.name };
  },
  store(access, { connector }) {
    return {
      name: 'fake',
      scope: (client) => `${connector}:${client?.teamId ?? ''}`,
      async create(note, client) {
        const { key } = (await call(access, '/issues', {
          method: 'POST',
          body: JSON.stringify({ place: client?.teamId, title: note.text }),
        })) as { key: string };

        return { id: key, identifier: key, url: `${FAKE}/i/${key}` };
      },
      findForPage: async () => [],
      trackerStates: async () => [{ id: 'open', name: 'Open', stage: 'todo' }],
    };
  },
  async disconnect(access) {
    const credential = await access.credential();
    await access.http(`${FAKE}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.via === 'token' ? credential.token : credential.accessToken}` },
    });
  },
};
