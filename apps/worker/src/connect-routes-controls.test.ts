import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Account, AccountStore } from './accounts.ts';
import { mutatedModule } from './conformance.fixture.ts';
import type { ConnectStore } from './connect.ts';
import { verifyIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';
import type { Database } from './postgres.ts';
import { createPgliteDatabase, rowsOf } from './postgres.fixture.ts';
import { digest } from './session.ts';
import { createPostgresConnectStore } from './session-postgres.ts';

/**
 * Each guard of the routes of FRU-238, taken out one at a time: the scenario that holds it fails on
 * the changed file, on an assertion, and passes on the real one.
 *
 * The routes are called as `app.ts` calls them, with a store on PGlite, a `Kv` in memory, and a
 * person of the cookie read from a header: what is under test is the file of the routes alone.
 * `connect-routes.test.ts` holds the same rules through `handleRequest` and better-auth.
 */

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const CONSOLE = 'https://app.fruitback.test';
const SECRET = 'a-worker-secret-of-exactly-enough';
const PEOPLE: Record<string, Account> = {
  acc_alice: { id: 'acc_alice', email: 'alice@acme.dev' },
  acc_mallory: { id: 'acc_mallory', email: 'mallory@evil.dev' },
};

type Routes = typeof import('./connect-routes.ts');
type World = {
  connect: ConnectStore;
  database: Database;
  extension(path: string, body: unknown, more?: { origin?: string | null; ip?: string }): Promise<Response>;
  console(
    path: string,
    more?: { as?: string; body?: unknown; method?: string; origin?: string | null },
  ): Promise<Response>;
  /** The interval of the extension, gone by. */
  waited(claim: string): Promise<void>;
  /** Moves the clock of the `Kv`. */
  advance(ms: number): void;
};

const opened: Database[] = [];
afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
});

async function worldOf(routes: Routes): Promise<World> {
  const database = await createPgliteDatabase();
  opened.push(database);
  const connect = createPostgresConnectStore(database);
  // The clock of the `Kv`: the time of this machine, and what a scenario moved it by.
  let ahead = 0;
  const kv = createMemoryKv({ now: () => Date.now() + ahead });
  const accounts = {
    account: async (id: string) => PEOPLE[id],
    memberships: async () => [],
  } as unknown as AccountStore;

  return {
    connect,
    database,
    advance(ms) {
      ahead += ms;
    },
    async extension(path, body, more = {}) {
      const origin = more.origin === undefined ? EXTENSION : more.origin;
      const request = new Request(`https://api.fruitback.test${path}`, {
        method: 'POST',
        headers: origin === null ? {} : { Origin: origin },
        body: JSON.stringify(body),
      });
      const answer = await routes.handleExtensionConnect(
        request,
        path,
        { connect, accounts, kv, clientIp: more.ip ?? '198.51.100.1', secret: SECRET, consoleUrl: CONSOLE },
        {},
      );
      assert.ok(answer !== undefined, path);

      return answer;
    },
    async console(path, more = {}) {
      const origin = more.origin === undefined ? CONSOLE : more.origin;
      const request = new Request(`https://api.fruitback.test${path}`, {
        method: more.method ?? (more.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(origin === null ? {} : { Origin: origin }),
          ...(more.as === undefined ? {} : { 'X-Person': more.as }),
        },
        ...(more.body === undefined ? {} : { body: JSON.stringify(more.body) }),
      });
      const answer = await routes.handleConsoleConnect(
        request,
        path,
        {
          connect,
          accounts,
          cookieSession: async (each) => each.headers.get('X-Person') ?? undefined,
          consoleUrl: CONSOLE,
        },
        {},
      );
      assert.ok(answer !== undefined, path);

      return answer;
    },
    async waited(claim) {
      await kv.set(`fruitback:connect-poll:${await digest(claim)}`, '0', 1);
      await new Promise((resolve) => setTimeout(resolve, 3));
    },
  };
}

type Asked = { request: string; claim: string; word: string };

async function asked(world: World): Promise<Asked> {
  const answer = await world.extension('/session/connect', { browser: 'Chrome on macOS' });
  assert.equal(answer.status, 201);

  return (await answer.json()) as Asked;
}

async function approved(world: World, as = 'acc_alice'): Promise<Asked> {
  const request = await asked(world);
  const answer = await world.console(`/console/connect/${request.request}/approve`, {
    as,
    body: { word: request.word, account: as },
  });
  assert.equal(answer.status, 200);

  return request;
}

async function claimed(world: World, claim: unknown): Promise<Response> {
  if (typeof claim === 'string') await world.waited(claim);

  return world.extension('/session/connect/claim', { claim });
}

type Guard = {
  /** What the scenario holds. */
  holds: string;
  /** The guard, taken out. */
  change: { after?: string; from: string; to: string };
  scenario(world: World): Promise<void>;
};

const GUARDS: Guard[] = [
  {
    holds: 'a page of a site starts no request',
    change: { from: 'if (origin !== null && !isExtensionOrigin(origin))', to: 'if (false)' },
    async scenario(world) {
      assert.equal((await world.extension('/session/connect', {}, { origin: 'https://evil.test' })).status, 403);
    },
  },
  {
    holds: 'one address starts so many requests in a window, and no more',
    change: { from: 'if (started > CONNECTS_PER_ADDRESS)', to: 'if (started < 0)' },
    async scenario(world) {
      for (let made = 0; made < 10; made += 1) {
        assert.equal((await world.extension('/session/connect', {}, { ip: '203.0.113.7' })).status, 201);
      }
      assert.equal((await world.extension('/session/connect', {}, { ip: '203.0.113.7' })).status, 429);
    },
  },
  {
    holds: 'the id of a request is no claim',
    change: { from: 'if (!isClaim(body.claim)) {', to: 'if (typeof body.claim !== "string") {' },
    async scenario(world) {
      // A request whose claim hash is the digest of its id: a store that looked the id up would find it.
      const request = await approved(world);
      await rowsOf(
        world.database,
        `UPDATE connect_requests SET claim_hash = '${await digest('A'.repeat(22))}' WHERE request_hash = '${await digest(request.request)}'`,
      );
      assert.equal((await claimed(world, 'A'.repeat(22))).status, 410);
    },
  },
  {
    holds: 'a claim asked again within the interval answers slow-down',
    change: { from: 'if (polls > 1) {', to: 'if (polls < 0) {' },
    async scenario(world) {
      const request = await asked(world);
      assert.equal((await world.extension('/session/connect/claim', { claim: request.claim })).status, 202);
      const soon = await world.extension('/session/connect/claim', { claim: request.claim });
      assert.equal(soon.status, 429);
    },
  },
  {
    holds: 'a claim polled on time, or a little early, is not paced',
    change: { from: 'POLL_WINDOW_SECONDS * 1000', to: 'CONNECT_INTERVAL_SECONDS * 1000' },
    async scenario(world) {
      const request = await asked(world);
      assert.equal((await world.extension('/session/connect/claim', { claim: request.claim })).status, 202);
      // Half a second before the interval announced: a first poll that took long on its way.
      world.advance(4_500);
      assert.equal((await world.extension('/session/connect/claim', { claim: request.claim })).status, 202);
    },
  },
  {
    holds: 'a request nobody answered gives no token',
    change: {
      from: "if (claimed.state === 'pending') return json(202,",
      to: "if (claimed.state === 'pending') return json(200,",
    },
    async scenario(world) {
      const request = await asked(world);
      const answer = await claimed(world, request.claim);
      assert.equal(answer.status, 202);
    },
  },
  {
    holds: 'the token of a claim names the account, and no workspace',
    change: { from: 'account: true as const };', to: '};' },
    async scenario(world) {
      const request = await approved(world);
      const session = (await (await claimed(world, request.claim)).json()) as { accessToken: string };
      const verified = await verifyIdentityToken(session.accessToken, SECRET);
      assert.ok(verified.ok);
      assert.deepEqual([verified.reporter.id, verified.account, verified.workspace], ['acc_alice', true, undefined]);
    },
  },
  {
    holds: 'the console names nobody without the cookie',
    change: {
      from: 'const subject = await context.cookieSession(request);',
      to: "const subject = (await context.cookieSession(request)) ?? 'acc_alice';",
    },
    async scenario(world) {
      const request = await asked(world);
      const answer = await world.console(`/console/connect/${request.request}/approve`, {
        body: { word: request.word, account: 'acc_alice' },
      });
      assert.equal(answer.status, 401);
    },
  },
  {
    holds: 'an approval comes from the console, and never from a request with no origin',
    change: {
      from: "request.method !== 'GET' && request.headers.get('Origin') !== new URL(context.consoleUrl).origin",
      to: 'false',
    },
    async scenario(world) {
      const request = await asked(world);
      for (const origin of [null, 'https://demo.fruitback.test', EXTENSION]) {
        const answer = await world.console(`/console/connect/${request.request}/approve`, {
          as: 'acc_alice',
          origin,
          body: { word: request.word, account: 'acc_alice' },
        });
        assert.equal(answer.status, 403, String(origin));
      }
    },
  },
  {
    holds: 'an approval is of the account the screen showed',
    change: { from: 'if (body.account !== account.id)', to: 'if (false)' },
    async scenario(world) {
      const request = await asked(world);
      const answer = await world.console(`/console/connect/${request.request}/approve`, {
        as: 'acc_mallory',
        body: { word: request.word, account: 'acc_alice' },
      });
      assert.equal(answer.status, 409);
    },
  },
  {
    holds: 'an approval names the word of the request',
    change: { from: 'normalizeWord(body.word) !== row.word', to: 'false' },
    async scenario(world) {
      const request = await asked(world);
      const answer = await world.console(`/console/connect/${request.request}/approve`, {
        as: 'acc_alice',
        body: { word: request.word === 'PLUM 47' ? 'PEAR 12' : 'PLUM 47', account: 'acc_alice' },
      });
      assert.equal(answer.status, 422);
    },
  },
  {
    holds: 'an answered request shows nothing to another account',
    change: { from: 'if (!answeredBy(row, account.id)) {', to: 'if (false) {' },
    async scenario(world) {
      const request = await approved(world);
      const answer = await world.console(`/console/connect/${request.request}`, { as: 'acc_mallory' });
      assert.equal(answer.status, 404);
      assert.equal(JSON.stringify(await answer.json()).includes('Chrome'), false);
    },
  },
  {
    holds: 'the browsers of an account end by their owner only',
    change: { from: 'await context.connect.endBrowser(account.id, id, now)', to: 'true' },
    async scenario(world) {
      const request = await approved(world);
      assert.equal((await claimed(world, request.claim)).status, 200);
      const [browser] = (
        (await (await world.console('/console/me/browsers', { as: 'acc_alice' })).json()) as {
          browsers: { id: string }[];
        }
      ).browsers;
      const answer = await world.console(`/console/me/browsers/${browser?.id}`, {
        as: 'acc_mallory',
        method: 'DELETE',
      });
      assert.equal(answer.status, 404);
    },
  },
];

describe('each guard of the routes of FRU-238, taken out, fails the scenario that holds it', () => {
  for (const guard of GUARDS) {
    it(`holds that ${guard.holds}`, async () => {
      await guard.scenario(await worldOf(await import('./connect-routes.ts')));
    });

    it(`fails « ${guard.holds} » when the guard is taken out`, async () => {
      const mutant = await mutatedModule('connect-routes.ts', guard.change);
      try {
        const failure = await guard.scenario(await worldOf(mutant.module as unknown as Routes)).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(failure !== undefined, 'the scenario passed with the guard taken out: it holds nothing');
        assert.ok(failure instanceof assert.AssertionError, `the changed file threw: ${String(failure)}`);
      } finally {
        mutant.remove();
      }
    });
  }
});

/**
 * The guard of `app.ts` that lets a session of an account reach a site: the membership, read at the
 * request. Taken out, an account of no workspace reads a site of the members of a workspace.
 */
describe('the membership that lets a session of an account read a site, taken out (FRU-238)', () => {
  const ACME_SITE = {
    workspace: 'ws_acme',
    origins: ['https://acme.test'],
    read: 'authenticated' as const,
  };
  const roles: Record<string, string> = { 'ws_acme acc_alice': 'member' };
  // Every other method of the accounts answers nothing: a read of a site with no place asks none.
  const accounts = new Proxy(
    {
      clientMap: async () => ({ site_acme: ACME_SITE }),
      role: async (workspace: string, account: string) => roles[`${workspace} ${account}`],
      reach: async (workspace: string, account: string) => {
        const role = roles[`${workspace} ${account}`];

        return role === undefined ? undefined : { role, sites: 'every' };
      },
      account: async (id: string) => PEOPLE[id],
    } as Record<string, unknown>,
    { get: (target, name: string) => target[name] ?? (async () => []) },
  ) as unknown as AccountStore;
  const env = {
    FRUITBACK_STORE: 'memory',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    // Port 1 of this machine: nothing listens there. The accounts are handed over.
    FRUITBACK_DATABASE_URL: 'postgres://fruitback:not-a-password@127.0.0.1:1/fruitback',
    FRUITBACK_CONSOLE_URL: CONSOLE,
    ALLOWED_ORIGINS: CONSOLE,
    FRUITBACK_PUBLIC_URL: 'https://api.fruitback.test',
    FRUITBACK_AUTH_SECRET: 'a-secret-of-better-auth-that-signs-nothing-here',
  };

  async function reads(handle: (request: Request, env: object, context: object) => Promise<Response>, who: string) {
    const now = Math.floor(Date.now() / 1000);
    const { signIdentityToken } = await import('./identity.ts');
    const token = await signIdentityToken({ sub: who, scope: 'account', iat: now, exp: now + 600 }, SECRET);
    const url = encodeURIComponent('https://acme.test/pricing');
    const answer = await handle(
      new Request(`https://api.fruitback.test/feedback?url=${url}&client=site_acme`, {
        headers: { Authorization: `Bearer ${token}`, Origin: EXTENSION },
      }),
      env,
      { clientIp: '198.51.100.9', accounts, kv: createMemoryKv() },
    );

    return answer.status;
  }

  const MEMBERSHIP = 'if (account === undefined || reaches === undefined || !(await reaches(account))) {';

  it('reads the site for a member, and refuses an account that is none', async () => {
    const { handleRequest } = await import('./app.ts');
    assert.equal(await reads(handleRequest as never, 'acc_alice'), 200);
    assert.equal(await reads(handleRequest as never, 'acc_mallory'), 401);
  });

  for (const [what, change] of [
    ['with no membership read', { from: MEMBERSHIP, to: 'if (account === undefined) {' }],
    [
      'with a membership that is always there',
      {
        from: 'readsSite(await reachIn(workspace, account), site),\n        }),',
        to: 'true,\n        }),',
      },
    ],
  ] as const) {
    it(`lets an account that is no member read the site ${what}`, async () => {
      const mutant = await mutatedModule('app.ts', change);
      try {
        const handle = mutant.module.handleRequest as never;
        assert.equal(await reads(handle, 'acc_mallory'), 200);
      } finally {
        mutant.remove();
      }
    });
  }
});
