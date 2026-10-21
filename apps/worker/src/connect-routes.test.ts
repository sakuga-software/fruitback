import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import type { Role } from './accounts.ts';
import { MIGRATED_DATABASES, databasesOfACase } from './auth.fixture.ts';
import { type Call, workerOf } from './auth-worker.fixture.ts';
import {
  CONNECTS_PER_ADDRESS,
  CONNECT_INTERVAL_SECONDS,
  CONNECT_TTL_SECONDS,
  MAX_LIVE_REQUESTS,
  MAX_WORD_MISSES,
  SLOW_DOWN_SECONDS,
} from './connect.ts';
import { signIdentityToken, verifyIdentityToken } from './identity.ts';
import { verifyForClient } from './app.ts';
import { mutatedModule } from './conformance.fixture.ts';
import type { PgDatabase } from './postgres.ts';
import { createPgliteDatabase, rowsOf } from './postgres.fixture.ts';
import { StoreError } from './store.ts';
import { digest } from './session.ts';

/**
 * The extension asks, the console approves (FRU-238): every route through `handleRequest`, as the
 * extension and the console call them, with the cookie of a person who signed in by a link, on PGlite
 * and on a real server when the run has one.
 *
 * The cases go by threat, and each says what would let it through. `connect-postgres.test.ts` holds
 * the store, state by state, with a planted violation for each case.
 */

const { opening } = databasesOfACase();
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SECRET = 'an-identity-secret-of-exactly-enough-x';

type Worker = Awaited<ReturnType<typeof workerOf>>;
type Person = { email: string; cookie: string; id: string };
type Asked = {
  request: string;
  claim: string;
  word: string;
  browser: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};
type Session = { refreshToken: string; accessToken: string; expiresIn: number; identity: Record<string, unknown> };

async function workerOn(open: () => Promise<PgDatabase>): Promise<Worker> {
  return workerOf(await opening(open));
}

async function person(worker: Worker, email: string): Promise<Person> {
  const cookie = await worker.signIn(email);
  const me = (await (await worker.call('/console/me', { headers: { Cookie: cookie } })).json()) as {
    account: { id: string };
  };

  return { email, cookie, id: me.account.id };
}

function as(worker: Worker, who: Person, path: string, init: Call = {}): Promise<Response> {
  return worker.call(path, { ...init, headers: { ...init.headers, Cookie: who.cookie } });
}

/** A workspace made by `owner`, with a site of each visibility. */
async function workspaceOf(worker: Worker, owner: Person, name: string) {
  const made = await as(worker, owner, '/console/workspaces', { body: { name } });
  assert.equal(made.status, 201, await made.clone().text());
  const id = ((await made.json()) as { id: string }).id;
  const site = async (url: string, visibility: string) => {
    const added = await as(worker, owner, `/console/workspaces/${id}/sites`, { body: { url, visibility } });
    assert.equal(added.status, 201, await added.clone().text());

    return ((await added.json()) as { id: string }).id;
  };

  return {
    id,
    members: await site(`https://${name}.test`, 'members'),
    everyone: await site(`https://www.${name}.test`, 'everyone'),
  };
}

/** Adds somebody to a workspace with a role, through the plugin. Their member id. */
async function added(worker: Worker, workspace: string, who: Person, role: Role): Promise<string> {
  const api = worker.auth.api as unknown as Record<string, (input: object) => Promise<Record<string, unknown>>>;
  const member = await api.addMember?.({ body: { userId: who.id, role, organizationId: workspace } });
  assert.equal(typeof member?.id, 'string');

  return member?.id as string;
}

/** The sites of a workspace shared with a guest, as the acceptance of their invitation leaves them (FRU-250). */
async function shared(worker: Worker, workspace: string, who: Person, sites: readonly string[]): Promise<void> {
  for (const site of sites) {
    await rowsOf(
      worker.database,
      `INSERT INTO site_shares (workspace_id, account_id, site_id, created_at) VALUES ('${workspace}', '${who.id}', '${site}', 1)`,
    );
  }
}

/** The extension asks. */
async function asks(worker: Worker, init: Call = {}): Promise<Asked> {
  const answer = await worker.call('/session/connect', {
    body: { browser: 'Chrome on macOS' },
    origin: EXTENSION,
    ...init,
  });
  assert.equal(answer.status, 201, await answer.clone().text());

  return (await answer.json()) as Asked;
}

/** The interval of the extension, gone by: the next claim is not too soon. */
async function waited(worker: Worker, claim: string): Promise<void> {
  await worker.kv.set(`fruitback:connect-poll:${await digest(claim)}`, '0', 1);
  await new Promise((resolve) => setTimeout(resolve, 3));
}

/** The extension asks whether it was answered, once the interval went by. */
async function claims(worker: Worker, claim: unknown, origin: string | null = EXTENSION): Promise<Response> {
  if (typeof claim === 'string') await waited(worker, claim);

  return worker.call('/session/connect/claim', { body: { claim }, origin });
}

const look = (worker: Worker, who: Person, request: string) => as(worker, who, `/console/connect/${request}`);

/** What the console shows for a request, as `who` reads it. */
async function shown(worker: Worker, who: Person, request: string) {
  const answer = await look(worker, who, request);
  assert.equal(answer.status, 200, await answer.clone().text());

  return (await answer.json()) as { word: string; account: { id: string }; state: string };
}

function approves(worker: Worker, who: Person, request: string, body: Record<string, unknown>, init: Call = {}) {
  return as(worker, who, `/console/connect/${request}/approve`, { body, ...init });
}

function refuses(worker: Worker, who: Person, request: string, body: Record<string, unknown> = { account: who.id }) {
  return as(worker, who, `/console/connect/${request}/refuse`, { body });
}

/** The whole way: the extension asks, `who` approves what the console showed, the extension claims. */
async function connected(worker: Worker, who: Person): Promise<Session & { asked: Asked }> {
  const asked = await asks(worker);
  const { word, account } = await shown(worker, who, asked.request);
  const approved = await approves(worker, who, asked.request, { word, account: account.id });
  assert.equal(approved.status, 200, await approved.clone().text());
  const answer = await claims(worker, asked.claim);
  assert.equal(answer.status, 200, await answer.clone().text());

  return { ...((await answer.json()) as Session), asked };
}

const refresh = (worker: Worker, refreshToken: string) =>
  worker.call('/session/refresh', { body: { refreshToken }, origin: EXTENSION });
const sitesOf = (worker: Worker, accessToken: string) =>
  worker.call('/session/sites', { origin: EXTENSION, headers: { Authorization: `Bearer ${accessToken}` } });

/** A read of the notes of a page of a site, as the relay of the extension asks it. */
function read(worker: Worker, site: string, origin: string, token?: string): Promise<Response> {
  const url = encodeURIComponent(`${origin}/pricing`);

  return worker.call(`/feedback?url=${url}&client=${site}`, {
    origin: EXTENSION,
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

/** A note on a page of a site, as the relay sends it. */
function write(worker: Worker, site: string, origin: string, token: string): Promise<Response> {
  const seed = seedFixture();

  return worker.call('/feedback', {
    body: { ...seed, page: { ...seed.page, url: `${origin}/pricing` }, client: { id: site } },
    origin: EXTENSION,
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Every value of every row of every table: a secret in clear is found wherever it is. */
async function everyValue(database: PgDatabase): Promise<string[]> {
  const tables = await rowsOf(
    database,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  const values: string[] = [];
  for (const { table_name: table } of tables) {
    for (const row of await rowsOf(database, `SELECT * FROM "${String(table)}"`)) {
      for (const value of Object.values(row)) if (value !== null) values.push(String(value));
    }
  }

  return values;
}

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`the extension asks, the console approves, on ${label} (FRU-238)`, { skip }, () => {
    it('connects an account of two workspaces: one request, one approval, one claim, and the sites of both', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const bob = await person(worker, 'bob@globex.dev');
      const acme = await workspaceOf(worker, alice, 'acme');
      const globex = await workspaceOf(worker, bob, 'globex');
      await added(worker, globex.id, alice, 'guest');
      await shared(worker, globex.id, alice, [globex.members, globex.everyone]);

      const asked = await asks(worker);
      assert.match(asked.request, /^[A-Za-z0-9_-]{22}$/);
      assert.match(asked.claim, /^[A-Za-z0-9_-]{43}$/);
      assert.match(asked.word, /^[A-Z]{3,6} [0-9]{2}$/);
      assert.deepEqual(
        [asked.browser, asked.verificationUri, asked.expiresIn, asked.interval],
        [
          'Chrome on macOS',
          `https://app.fruitback.test/connect/${asked.request}`,
          CONNECT_TTL_SECONDS,
          CONNECT_INTERVAL_SECONDS,
        ],
      );
      // Before anybody answers: the extension waits, with no token.
      const waiting = await claims(worker, asked.claim);
      assert.equal(waiting.status, 202);
      assert.deepEqual(await waiting.json(), { state: 'pending', interval: CONNECT_INTERVAL_SECONDS });

      const screen = await look(worker, alice, asked.request);
      assert.equal(screen.status, 200);
      const onScreen = (await screen.json()) as Record<string, unknown>;
      assert.deepEqual(
        { ...onScreen, createdAt: typeof onScreen.createdAt, expiresAt: typeof onScreen.expiresAt },
        {
          request: asked.request,
          state: 'pending',
          word: asked.word,
          browser: 'Chrome on macOS',
          createdAt: 'string',
          expiresAt: 'string',
          account: { id: alice.id, email: 'alice@acme.dev' },
          workspaces: onScreen.workspaces,
        },
      );
      assert.deepEqual(
        (onScreen.workspaces as { id: string }[]).toSorted((a, b) => a.id.localeCompare(b.id)),
        [
          { id: acme.id, name: 'acme', role: 'owner' },
          { id: globex.id, name: 'globex', role: 'guest' },
        ].toSorted((a, b) => a.id.localeCompare(b.id)),
      );

      const approved = await approves(worker, alice, asked.request, { word: asked.word, account: alice.id });
      assert.equal(approved.status, 200);
      assert.equal(((await approved.json()) as { state: string }).state, 'approved');

      const session = await claims(worker, asked.claim);
      assert.equal(session.status, 200);
      const { refreshToken, accessToken, expiresIn, identity } = (await session.json()) as Session;
      assert.deepEqual(identity, { subject: alice.id, email: 'alice@acme.dev', account: true });
      assert.equal(expiresIn, 600);
      // The token names the account, and no workspace.
      const verified = await verifyIdentityToken(accessToken, SECRET);
      assert.ok(verified.ok);
      assert.deepEqual([verified.reporter.id, verified.workspace, verified.account], [alice.id, undefined, true]);

      const sites = await sitesOf(worker, accessToken);
      assert.equal(sites.status, 200);
      const listed = (await sites.json()) as {
        account: boolean;
        workspaces: { id: string; role: string }[];
        sites: { id: string; workspace: string; visibility: string }[];
      };
      assert.equal(listed.account, true);
      assert.deepEqual(
        listed.workspaces.map(({ id, role }) => [id, role]).sort(),
        [
          [acme.id, 'owner'],
          [globex.id, 'guest'],
        ].sort(),
      );
      assert.deepEqual(
        listed.sites.map(({ id, workspace, visibility }) => [id, workspace, visibility]).sort(),
        [
          [acme.members, acme.id, 'members'],
          [acme.everyone, acme.id, 'everyone'],
          [globex.members, globex.id, 'members'],
          [globex.everyone, globex.id, 'everyone'],
        ].sort(),
      );
      assert.equal('workspace' in listed, false, 'an account session names no one workspace');

      // A members site of each workspace reads with this one token.
      assert.equal((await read(worker, acme.members, 'https://acme.test', accessToken)).status, 200);
      assert.equal((await read(worker, globex.members, 'https://globex.test', accessToken)).status, 200);
      // The control: no token reads neither.
      assert.equal((await read(worker, acme.members, 'https://acme.test')).status, 401);

      // It refreshes, and stays a session of the account.
      const refreshed = await refresh(worker, refreshToken);
      assert.equal(refreshed.status, 200);
      const again = (await refreshed.json()) as Session;
      assert.deepEqual(again.identity, identity);
      assert.equal((await sitesOf(worker, again.accessToken)).status, 200);
    });

    it('answers each state of a request on each route, as the table says', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const mallory = await person(worker, 'mallory@evil.dev');
      await workspaceOf(worker, alice, 'acme');

      /** A request in a state: its values. */
      const states: Record<string, () => Promise<Asked>> = {
        pending: () => asks(worker),
        approved: async () => {
          const asked = await asks(worker);
          await approves(worker, alice, asked.request, { word: asked.word, account: alice.id });

          return asked;
        },
        refused: async () => {
          const asked = await asks(worker);
          await refuses(worker, alice, asked.request);

          return asked;
        },
        claimed: async () => {
          const asked = await asks(worker);
          await approves(worker, alice, asked.request, { word: asked.word, account: alice.id });
          assert.equal((await claims(worker, asked.claim)).status, 200);

          return asked;
        },
        expired: async () => {
          const asked = await asks(worker);
          await rowsOf(
            worker.database,
            `UPDATE connect_requests SET expires_at = 1 WHERE request_hash = '${await digest(asked.request)}'`,
          );

          return asked;
        },
        unknown: async () => ({ ...(await asks(worker)), request: 'A'.repeat(22), claim: 'B'.repeat(43) }),
      };
      /** Each route, and what it answers: a status, and the error or the state. */
      const routes: Record<string, (asked: Asked) => Promise<Response>> = {
        'GET by the one who answered': (asked) => look(worker, alice, asked.request),
        'GET by another account': (asked) => look(worker, mallory, asked.request),
        approve: (asked) => approves(worker, alice, asked.request, { word: asked.word, account: alice.id }),
        refuse: (asked) => refuses(worker, alice, asked.request),
        claim: (asked) => claims(worker, asked.claim),
      };
      const table: Record<string, Record<string, string>> = {
        pending: {
          'GET by the one who answered': '200 pending',
          'GET by another account': '200 pending',
          approve: '200 approved',
          refuse: '200 refused',
          claim: '202 pending',
        },
        approved: {
          'GET by the one who answered': '200 approved',
          'GET by another account': '404 connect-unknown',
          approve: '409 connect-already',
          refuse: '409 connect-already',
          claim: '200 session',
        },
        refused: {
          'GET by the one who answered': '200 refused',
          'GET by another account': '404 connect-unknown',
          approve: '409 connect-already',
          refuse: '409 connect-already',
          claim: '410 connect-refused',
        },
        claimed: {
          'GET by the one who answered': '200 claimed',
          'GET by another account': '404 connect-unknown',
          approve: '409 connect-already',
          refuse: '409 connect-already',
          claim: '410 connect-expired',
        },
        expired: {
          'GET by the one who answered': '410 connect-expired',
          'GET by another account': '410 connect-expired',
          approve: '410 connect-expired',
          refuse: '410 connect-expired',
          claim: '410 connect-expired',
        },
        unknown: {
          'GET by the one who answered': '404 connect-unknown',
          'GET by another account': '404 connect-unknown',
          approve: '404 connect-unknown',
          refuse: '404 connect-unknown',
          claim: '410 connect-expired',
        },
      };

      const seen: Record<string, Record<string, string>> = {};
      for (const [state, make] of Object.entries(states)) {
        seen[state] = {};
        for (const [route, call] of Object.entries(routes)) {
          const answer = await call(await make());
          const body = (await answer.json()) as { error?: string; state?: string; refreshToken?: string };
          (seen[state] as Record<string, string>)[route] =
            `${answer.status} ${body.error ?? body.state ?? (body.refreshToken === undefined ? '?' : 'session')}`;
        }
      }

      assert.deepEqual(seen, table);
    });

    it('lets each role approve, and gives the session what a session of the workspace gets, and no more', async () => {
      const worker = await workerOn(open);
      const owner = await person(worker, 'owner@acme.dev');
      const acme = await workspaceOf(worker, owner, 'acme');
      const other = await person(worker, 'owner@globex.dev');
      const globex = await workspaceOf(worker, other, 'globex');

      for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
        const who = role === 'owner' ? owner : await person(worker, `${role}@acme.dev`);
        if (role !== 'owner') await added(worker, acme.id, who, role);
        if (role === 'guest') await shared(worker, acme.id, who, [acme.members, acme.everyone]);

        // A session of the workspace, paired with a code of the console, as before.
        const minted = await as(worker, who, `/console/workspaces/${acme.id}/connect`, { body: {} });
        assert.equal(minted.status, 201, `${role}: ${await minted.clone().text()}`);
        const { code } = (await minted.json()) as { code: string };
        const paired = (await (await worker.call('/session/pair', { body: { code }, origin: null })).json()) as Session;
        const account = await connected(worker, who);

        for (const [what, ask] of [
          ['reads a members site', (token: string) => read(worker, acme.members, 'https://acme.test', token)],
          ['reads a site for everyone', (token: string) => read(worker, acme.everyone, 'https://www.acme.test', token)],
          [
            'reads a site of another workspace',
            (token: string) => read(worker, globex.members, 'https://globex.test', token),
          ],
        ] as const) {
          const [byPairing, byAccount] = [await ask(paired.accessToken), await ask(account.accessToken)];
          assert.deepEqual(
            [byAccount.status, await byAccount.json()],
            [byPairing.status, await byPairing.json()],
            `${role} ${what}`,
          );
        }
        // A note is signed with the account, verified, as the session of the workspace signs it.
        const byPairing = await write(worker, acme.members, 'https://acme.test', paired.accessToken);
        const byAccount = await write(worker, acme.members, 'https://acme.test', account.accessToken);
        assert.deepEqual([byAccount.status, byPairing.status], [201, 201], role);
        // The role, as the session of the workspace reads it.
        const listed = (await (await sitesOf(worker, account.accessToken)).json()) as {
          workspaces: { role: string }[];
        };
        assert.deepEqual(
          listed.workspaces.map((each) => each.role),
          [role],
        );
        // And a note on a site of another workspace is refused, as it is to the session of the workspace.
        const elsewhere = await write(worker, globex.members, 'https://globex.test', account.accessToken);
        assert.equal(elsewhere.status, 401, role);
      }
    });

    it('lets an account of no workspace approve: its session lives, and reads nothing', async () => {
      const worker = await workerOn(open);
      const lone = await person(worker, 'lone@acme.dev');
      const owner = await person(worker, 'owner@acme.dev');
      const acme = await workspaceOf(worker, owner, 'acme');

      const session = await connected(worker, lone);

      const sites = await sitesOf(worker, session.accessToken);
      assert.equal(sites.status, 200);
      assert.deepEqual(await sites.json(), { account: true, workspaces: [], sites: [] });
      assert.equal((await read(worker, acme.members, 'https://acme.test', session.accessToken)).status, 401);
      assert.equal((await refresh(worker, session.refreshToken)).status, 200);
    });

    it('refuses an approval with no cookie, from another origin, with no origin, or with the token of an extension (CSRF)', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      await workspaceOf(worker, alice, 'acme');
      const theirs = await connected(worker, alice);
      const asked = await asks(worker);
      const body = { word: asked.word, account: alice.id };

      const attempts: [string, Promise<Response>, number][] = [
        ['no cookie', worker.call(`/console/connect/${asked.request}/approve`, { body }), 401],
        ['another origin', approves(worker, alice, asked.request, body, { origin: 'https://evil.test' }), 403],
        [
          'a page of the same site',
          approves(worker, alice, asked.request, body, { origin: 'https://demo.fruitback.test' }),
          403,
        ],
        ['no origin', approves(worker, alice, asked.request, body, { origin: null }), 403],
        ['the origin of the extension', approves(worker, alice, asked.request, body, { origin: EXTENSION }), 403],
        [
          'the token of an extension, and no cookie',
          worker.call(`/console/connect/${asked.request}/approve`, {
            body,
            headers: { Authorization: `Bearer ${theirs.accessToken}` },
          }),
          401,
        ],
        ['a read with GET', as(worker, alice, `/console/connect/${asked.request}/approve`), 405],
      ];
      for (const [what, attempt, status] of attempts) assert.equal((await attempt).status, status, what);
      // Same for a refusal, which ends a request somebody else may want.
      assert.equal(
        (
          await as(worker, alice, `/console/connect/${asked.request}/refuse`, {
            body: { account: alice.id },
            origin: null,
          })
        ).status,
        403,
      );

      // Nothing answered it: it still waits, and the console approves it.
      assert.equal((await claims(worker, asked.claim)).status, 202);
      assert.equal((await approves(worker, alice, asked.request, body)).status, 200);
      assert.equal((await claims(worker, asked.claim)).status, 200);
    });

    it('connects the account the screen showed: an approval of another account in the cookie is refused', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const mallory = await person(worker, 'mallory@evil.dev');
      const asked = await asks(worker);
      const screen = await shown(worker, alice, asked.request);

      // The console changed account between the read and the click: the cookie is Mallory's now.
      const switched = await approves(worker, mallory, asked.request, {
        word: screen.word,
        account: screen.account.id,
      });
      assert.equal(switched.status, 409);
      assert.deepEqual(await switched.json(), { error: 'account-changed' });
      assert.equal((await claims(worker, asked.claim)).status, 202);
      // And with no account named, nothing is approved.
      assert.equal((await approves(worker, alice, asked.request, { word: screen.word })).status, 400);

      // The control: the account of the screen approves, and the session is of that account.
      assert.equal(
        (await approves(worker, alice, asked.request, { word: screen.word, account: alice.id })).status,
        200,
      );
      const session = (await (await claims(worker, asked.claim)).json()) as Session;
      assert.equal(session.identity.subject, alice.id);
    });

    it('refuses a word that is not the one shown, and refuses the request after five', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const asked = await asks(worker);
      const other = asked.word === 'PLUM 47' ? 'PEAR 12' : 'PLUM 47';

      // The word as a person may type it is the word.
      const typed = await asks(worker);
      const loose = typed.word.toLowerCase().replace(' ', '  ');
      assert.equal((await approves(worker, alice, typed.request, { word: loose, account: alice.id })).status, 200);

      for (let left = MAX_WORD_MISSES - 1; left >= 0; left -= 1) {
        const answer = await approves(worker, alice, asked.request, { word: other, account: alice.id });
        assert.equal(answer.status, 422);
        assert.deepEqual(await answer.json(), { error: 'word-mismatch', attemptsLeft: left });
      }
      // The right word comes too late: the request is refused, and the extension hears so.
      const late = await approves(worker, alice, asked.request, { word: asked.word, account: alice.id });
      assert.equal(late.status, 409);
      const answer = await claims(worker, asked.claim);
      assert.equal(answer.status, 410);
      assert.deepEqual(await answer.json(), { error: 'connect-refused' });
    });

    it('gives no token for the id of a request: only the claim, whole, of that request, opens a session', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const asked = await asks(worker);
      const second = await asks(worker);
      for (const each of [asked, second]) {
        assert.equal((await approves(worker, alice, each.request, { word: each.word, account: alice.id })).status, 200);
      }

      const tries: [string, unknown, number][] = [
        ['the id of the request', asked.request, 410],
        ['the claim, truncated', asked.claim.slice(0, -1), 410],
        ['the claim, with one more letter', `${asked.claim}A`, 410],
        [
          'the claim, with one letter changed',
          `${asked.claim.slice(0, -1)}${asked.claim.endsWith('A') ? 'B' : 'A'}`,
          410,
        ],
        ['the word', asked.word, 410],
        ['no claim', undefined, 400],
        ['a number', 42, 410],
      ];
      for (const [what, claim, status] of tries) {
        const answer = await claims(worker, claim);
        assert.equal(answer.status, status, what);
        assert.equal(((await answer.json()) as { refreshToken?: string }).refreshToken, undefined, what);
      }
      // The claim of another request opens that one, and not this one.
      const theirs = (await (await claims(worker, second.claim)).json()) as Session;
      assert.equal(typeof theirs.refreshToken, 'string');
      assert.equal((await claims(worker, asked.claim)).status, 200);
    });

    it('never makes a word from the request, the claim or the instant', async () => {
      const worker = await workerOn(open);
      const asked = await Promise.all(Array.from({ length: 40 }, () => asks(worker)));

      // Forty requests of one instant: one word for all would be a word of the hour.
      assert.ok(new Set(asked.map((each) => each.word)).size > 20, JSON.stringify(asked.map((each) => each.word)));
      for (const each of asked) {
        assert.equal(each.request.includes(each.word.replace(' ', '')), false);
        assert.equal(each.claim.includes(each.word.replace(' ', '')), false);
      }
      // And the word is not kept beside a value it could be read from: the row holds digests only.
      const rows = await rowsOf(worker.database, 'SELECT request_hash, claim_hash FROM connect_requests');
      assert.equal(rows.length, 40);
    });

    it('refuses a second claim, a second answer, and an answer of the other kind', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const bob = await person(worker, 'bob@acme.dev');
      const asked = await asks(worker);
      const body = { word: asked.word, account: alice.id };

      assert.equal((await approves(worker, alice, asked.request, body)).status, 200);
      assert.equal((await approves(worker, alice, asked.request, body)).status, 409);
      assert.equal((await approves(worker, bob, asked.request, { word: asked.word, account: bob.id })).status, 409);
      assert.equal((await refuses(worker, alice, asked.request)).status, 409);
      const first = await claims(worker, asked.claim);
      assert.equal(first.status, 200);
      const replay = await claims(worker, asked.claim);
      assert.equal(replay.status, 410);
      assert.deepEqual(await replay.json(), { error: 'connect-expired' });
      // One session, of Alice.
      assert.deepEqual(await rowsOf(worker.database, 'SELECT subject FROM sessions'), [{ subject: alice.id }]);
    });

    it('never brings back a request that expired or was refused', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const approved = await asks(worker);
      const refused = await asks(worker);
      assert.equal(
        (await approves(worker, alice, approved.request, { word: approved.word, account: alice.id })).status,
        200,
      );
      assert.equal((await refuses(worker, alice, refused.request)).status, 200);
      // Fifteen minutes on, for both: the approved one was never claimed.
      await rowsOf(worker.database, 'UPDATE connect_requests SET expires_at = 1');

      assert.equal((await claims(worker, approved.claim)).status, 410);
      assert.equal((await claims(worker, refused.claim)).status, 410);
      // A new request purges what expired: the rows are gone, and nothing answers for them.
      await asks(worker);
      assert.equal((await rowsOf(worker.database, 'SELECT 1 FROM connect_requests')).length, 1);
      for (const each of [approved, refused]) {
        assert.equal((await claims(worker, each.claim)).status, 410);
        assert.equal((await look(worker, alice, each.request)).status, 404);
        assert.equal((await approves(worker, alice, each.request, { word: each.word, account: alice.id })).status, 404);
      }
      assert.deepEqual(await rowsOf(worker.database, 'SELECT 1 FROM sessions'), []);
    });

    it('paces the claim: asked again within the interval, it answers slow-down and opens nothing', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const asked = await asks(worker);
      await approves(worker, alice, asked.request, { word: asked.word, account: alice.id });

      const first = await worker.call('/session/connect/claim', { body: { claim: asked.claim }, origin: EXTENSION });
      assert.equal(first.status, 200);
      const soon = await worker.call('/session/connect/claim', { body: { claim: asked.claim }, origin: EXTENSION });
      assert.equal(soon.status, 429);
      assert.deepEqual(await soon.json(), {
        error: 'slow-down',
        interval: CONNECT_INTERVAL_SECONDS + SLOW_DOWN_SECONDS,
      });
      // Before an answer too.
      const waiting = await asks(worker);
      assert.equal(
        (await worker.call('/session/connect/claim', { body: { claim: waiting.claim }, origin: EXTENSION })).status,
        202,
      );
      assert.equal(
        (await worker.call('/session/connect/claim', { body: { claim: waiting.claim }, origin: EXTENSION })).status,
        429,
      );
    });

    it('limits the requests of one address, and the requests that wait on the instance', async () => {
      const worker = await workerOn(open);
      for (let made = 0; made < CONNECTS_PER_ADDRESS; made += 1) await asks(worker, { ip: '203.0.113.7' });
      const more = await worker.call('/session/connect', { body: {}, origin: EXTENSION, ip: '203.0.113.7' });
      assert.equal(more.status, 429);
      assert.deepEqual(await more.json(), { error: 'rate-limited' });
      // Another address still asks.
      await asks(worker, { ip: '203.0.113.8' });

      // The instance holds as many waiting requests as it allows, and no more, whoever asks.
      await rowsOf(
        worker.database,
        `INSERT INTO connect_requests (request_hash, claim_hash, word, browser, created_at, expires_at)
           SELECT 'request-' || n, 'claim-' || n, 'PLUM 47', 'A browser', 0, 9007199254740991
             FROM generate_series(1, ${MAX_LIVE_REQUESTS - CONNECTS_PER_ADDRESS - 1}) AS n`,
      );
      const busy = await worker.call('/session/connect', { body: {}, origin: EXTENSION, ip: '203.0.113.9' });
      assert.equal(busy.status, 429);
      assert.deepEqual(await busy.json(), { error: 'connect-busy' });
    });

    it('refuses a request that a page of a site starts, and takes one from the extension or from no browser', async () => {
      const worker = await workerOn(open);

      for (const origin of ['https://evil.test', 'https://app.fruitback.test', 'null']) {
        const answer = await worker.call('/session/connect', { body: {}, origin });
        assert.equal(answer.status, 403, origin);
      }
      for (const origin of [EXTENSION, 'moz-extension://0d4b1c2a-1111-2222-3333-444455556666', null]) {
        assert.equal((await worker.call('/session/connect', { body: {}, origin })).status, 201, String(origin));
      }
      // A claim from a page is refused too: a page holds no claim, and must not try one.
      const asked = await asks(worker);
      assert.equal((await claims(worker, asked.claim, 'https://evil.test')).status, 403);
    });

    it('keeps the label of the browser as one short line, and shows it as it was kept', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const cases: [unknown, string][] = [
        ['Chrome on macOS', 'Chrome on macOS'],
        ['  Firefox\n\ton   Linux  ', 'Firefox on Linux'],
        // A mark that turns the line around would show « Chrome » reversed as something else.
        ['\u202eSOcam no emorhC', 'SOcam no emorhC'],
        ['Edge\u0000 on\u200b Windows', 'Edge on Windows'],
        ['x'.repeat(200), 'x'.repeat(60)],
        ['', 'A browser'],
        [42, 'A browser'],
        [undefined, 'A browser'],
      ];
      for (const [given, kept] of cases) {
        const answer = await worker.call('/session/connect', { body: { browser: given }, origin: EXTENSION });
        const asked = (await answer.json()) as Asked;
        assert.equal(asked.browser, kept, JSON.stringify(given));
        const screen = (await (await look(worker, alice, asked.request)).json()) as { browser: string };
        assert.equal(screen.browser, kept, JSON.stringify(given));
      }
    });

    it('cuts a member who is removed or demoted at the next use, and keeps the rest', async () => {
      const worker = await workerOn(open);
      const owner = await person(worker, 'owner@acme.dev');
      const alice = await person(worker, 'alice@acme.dev');
      const acme = await workspaceOf(worker, owner, 'acme');
      const globex = await workspaceOf(worker, alice, 'globex');
      const member = await added(worker, acme.id, alice, 'member');
      const session = await connected(worker, alice);
      assert.equal((await read(worker, acme.members, 'https://acme.test', session.accessToken)).status, 200);

      // Demoted to guest: the role is read at the next call.
      const api = worker.auth.api as unknown as Record<string, (input: object) => Promise<unknown>>;
      await api.updateMemberRole?.({
        body: { memberId: member, role: 'guest', organizationId: acme.id },
        headers: new Headers({ Cookie: owner.cookie }),
      });
      const demoted = (await (await sitesOf(worker, session.accessToken)).json()) as {
        workspaces: { id: string; role: string }[];
      };
      assert.equal(demoted.workspaces.find((each) => each.id === acme.id)?.role, 'guest');

      // Removed: the same access token, still signed and not expired, reads no site of the workspace.
      const removed = await as(worker, owner, '/console/auth/organization/remove-member', {
        body: { organizationId: acme.id, memberIdOrEmail: member },
      });
      assert.equal(removed.status, 200, await removed.clone().text());
      assert.equal((await read(worker, acme.members, 'https://acme.test', session.accessToken)).status, 401);
      assert.equal((await write(worker, acme.members, 'https://acme.test', session.accessToken)).status, 401);
      const left = (await (await sitesOf(worker, session.accessToken)).json()) as { workspaces: { id: string }[] };
      assert.deepEqual(
        left.workspaces.map((each) => each.id),
        [globex.id],
      );
      // The session of the account lives on: it reads its own workspace, and refreshes.
      assert.equal((await read(worker, globex.members, 'https://globex.test', session.accessToken)).status, 200);
      assert.equal((await refresh(worker, session.refreshToken)).status, 200);
    });

    it('leaves the extension connected through « Sign out everywhere » and the sign-out of a browser, and ends it from My account', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const mallory = await person(worker, 'mallory@evil.dev');
      const session = await connected(worker, alice);
      let token = session.refreshToken;
      const refreshes = async (): Promise<number> => {
        const answer = await refresh(worker, token);
        if (answer.status === 200) token = ((await answer.json()) as Session).refreshToken;

        return answer.status;
      };

      // The sign-out of one browser of the console, from My account.
      const other = await worker.signIn('alice@acme.dev');
      const listed = (await (await as(worker, alice, '/console/sessions')).json()) as {
        sessions: { id: string; current: boolean }[];
      };
      const elsewhere = listed.sessions.find((each) => !each.current);
      assert.equal((await as(worker, alice, `/console/sessions/${elsewhere?.id}`, { method: 'DELETE' })).status, 204);
      assert.equal((await worker.call('/console/me', { headers: { Cookie: other } })).status, 401);
      assert.equal(await refreshes(), 200);
      // « Sign out everywhere »: the console is signed out, the extension stays connected.
      assert.equal((await as(worker, alice, '/console/auth/revoke-sessions', { body: {} })).status, 200);
      assert.equal((await as(worker, alice, '/console/me')).status, 401);
      assert.equal(await refreshes(), 200);

      // My account lists it, to the person, and ends it.
      const back = await person(worker, 'alice@acme.dev');
      const browsers = await as(worker, back, '/console/me/browsers');
      assert.equal(browsers.status, 200);
      const { browsers: list } = (await browsers.json()) as {
        browsers: { id: string; browser: string; connectedAt: string; usedAt: string }[];
      };
      assert.equal(list.length, 1);
      assert.equal(list[0]?.browser, 'Chrome on macOS');
      assert.ok(Date.parse(list[0]?.usedAt ?? '') >= Date.parse(list[0]?.connectedAt ?? ''));
      assert.deepEqual((await (await as(worker, mallory, '/console/me/browsers')).json()) as unknown, { browsers: [] });
      // Somebody else cannot end it, and learns nothing of it.
      assert.equal(
        (await as(worker, mallory, `/console/me/browsers/${list[0]?.id}`, { method: 'DELETE' })).status,
        404,
      );
      assert.equal(
        (await as(worker, back, `/console/me/browsers/${list[0]?.id}`, { method: 'DELETE', origin: null })).status,
        403,
      );
      assert.equal(await refreshes(), 200);

      assert.equal((await as(worker, back, `/console/me/browsers/${list[0]?.id}`, { method: 'DELETE' })).status, 204);
      assert.equal(await refreshes(), 401);
      assert.deepEqual((await (await as(worker, back, '/console/me/browsers')).json()) as unknown, { browsers: [] });
      assert.equal((await as(worker, back, `/console/me/browsers/${list[0]?.id}`, { method: 'DELETE' })).status, 404);
    });

    it('writes nothing for a session that ended, a note or a picture, with the access token it still holds, and reads in its window', async () => {
      await endedWritesNothing(await workerOn(open));
    });

    it('is refused by the console: the token of an account session names nobody there (FRU-202)', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const session = await connected(worker, alice);
      const bearer = { Authorization: `Bearer ${session.accessToken}` };

      for (const path of [
        '/console/me',
        '/console/me/browsers',
        '/console/sessions',
        `/console/connect/${session.asked.request}`,
      ]) {
        assert.equal((await worker.call(path, { headers: bearer })).status, 401, path);
      }
    });

    it('ends the session of an account that is deleted, and opens none for a claim after it', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const session = await connected(worker, alice);
      const asked = await asks(worker);
      assert.equal((await approves(worker, alice, asked.request, { word: asked.word, account: alice.id })).status, 200);

      const context = (await worker.auth.$context) as unknown as {
        internalAdapter: { deleteUser(id: string): Promise<void> };
      };
      await context.internalAdapter.deleteUser(alice.id);

      assert.equal((await refresh(worker, session.refreshToken)).status, 401);
      const late = await claims(worker, asked.claim);
      assert.equal(late.status, 410);
      assert.deepEqual(await rowsOf(worker.database, 'SELECT 1 FROM sessions WHERE revoked_at IS NULL'), []);
    });

    it('ends the session at the next refresh when the account went by another way', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const session = await connected(worker, alice);
      // A row deleted by hand: nothing ended the sessions of the account.
      await rowsOf(worker.database, `DELETE FROM "session" WHERE "userId" = '${alice.id}'`);
      await rowsOf(worker.database, `DELETE FROM "account" WHERE "userId" = '${alice.id}'`);
      await rowsOf(worker.database, `DELETE FROM "user" WHERE id = '${alice.id}'`);

      const answer = await refresh(worker, session.refreshToken);
      assert.equal(answer.status, 401);
      assert.deepEqual(await answer.json(), { error: 'session-revoked-or-expired' });
    });

    it('keeps no request, claim or token in clear in any row, and writes none of them in the log', async () => {
      const lines: string[] = [];
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        mock.method(console, method, (...values: unknown[]) => void lines.push(values.map(String).join(' ')));
      }
      try {
        const worker = await workerOn(open);
        const alice = await person(worker, 'alice@acme.dev');
        const session = await connected(worker, alice);
        const refreshed = (await (await refresh(worker, session.refreshToken)).json()) as Session;
        const secrets = [
          session.asked.request,
          session.asked.claim,
          session.refreshToken,
          session.accessToken,
          refreshed.refreshToken,
          refreshed.accessToken,
        ];

        const values = await everyValue(worker.database);
        for (const secret of secrets) {
          assert.equal(
            values.some((value) => value.includes(secret)),
            false,
            'a secret is in a row',
          );
          assert.equal(
            lines.some((line) => line.includes(secret)),
            false,
            'a secret is in the log',
          );
        }
        // The control: the digest of the claim is there, so the scan reads the table.
        assert.ok(values.includes(await digest(session.asked.claim)));
        // The address the worker was asked carries the request, and never the claim or a token.
        for (const url of worker.received) {
          for (const secret of secrets.slice(1)) assert.equal(url.includes(secret), false, url);
        }
      } finally {
        mock.restoreAll();
      }
    });

    it('leaves the pairing by code as it was: a session of one workspace, read with the answer of before', async () => {
      const worker = await workerOn(open);
      const alice = await person(worker, 'alice@acme.dev');
      const acme = await workspaceOf(worker, alice, 'acme');
      const minted = await as(worker, alice, `/console/workspaces/${acme.id}/connect`, { body: {} });
      const { code } = (await minted.json()) as { code: string };

      const paired = (await (await worker.call('/session/pair', { body: { code }, origin: null })).json()) as Session;

      assert.deepEqual(paired.identity, { subject: alice.id, email: 'alice@acme.dev', workspace: acme.id });
      const sites = (await (await sitesOf(worker, paired.accessToken)).json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(sites).sort(), ['sites', 'workspace']);
      assert.deepEqual(sites.workspace, { id: acme.id, name: 'acme' });
      // And it is no browser of My account: that list is of the sessions of the account.
      assert.deepEqual((await (await as(worker, alice, '/console/me/browsers')).json()) as unknown, { browsers: [] });
    });
  });
}

/**
 * A session of an account ended in My account, while its access token is still signed and not
 * expired: a note, a batch, a note to a chosen place and a file are refused; a read is not (FRU-238).
 * The scenario of a route test, and of its planted violations below.
 */
async function endedWritesNothing(worker: Worker): Promise<void> {
  const alice = await person(worker, 'alice@acme.dev');
  const acme = await workspaceOf(worker, alice, 'acme');
  const session = await connected(worker, alice);
  const seed = seedFixture();
  const note = { ...seed, page: { ...seed.page, url: 'https://acme.test/pricing' }, client: { id: acme.members } };
  const bearer = { Authorization: `Bearer ${session.accessToken}` };
  const picture = () =>
    worker.call(`/attachments?client=${acme.members}`, {
      method: 'POST',
      origin: EXTENSION,
      headers: { ...bearer, 'Content-Type': 'image/png' },
      body: 'not a picture',
    });
  const writes = {
    'a note': () => worker.call('/feedback', { body: note, origin: EXTENSION, headers: bearer }),
    'a batch': () => worker.call('/feedback', { body: [note], origin: EXTENSION, headers: bearer }),
    'a note to a chosen place': () =>
      worker.call('/feedback?destination=a-place', { body: note, origin: EXTENSION, headers: bearer }),
  };
  // The session writes: a note goes, and the file is read up to its bytes, which are no PNG.
  assert.equal((await writes['a note']()).status, 201);
  assert.equal((await picture()).status, 400);

  const { browsers } = (await (await as(worker, alice, '/console/me/browsers')).json()) as {
    browsers: { id: string }[];
  };
  assert.equal((await as(worker, alice, `/console/me/browsers/${browsers[0]?.id}`, { method: 'DELETE' })).status, 204);

  // The same access token, signed and not expired: each write reads the session again, and refuses.
  for (const [what, call] of Object.entries(writes)) {
    const refused = await call();
    assert.equal(refused.status, 401, what);
    assert.deepEqual(await refused.json(), { error: 'invalid-identity', reason: 'session-ended' }, what);
  }
  const refused = await picture();
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: 'identity-required' });
  // A read keeps the window of the token (SECURITY.md): ten minutes at most.
  assert.equal((await read(worker, acme.members, 'https://acme.test', session.accessToken)).status, 200);
}

/** Each check of `app.ts` that a write makes, taken out: the scenario fails (FRU-238). */
describe('the writes of an ended session, with a check of app.ts taken out (FRU-238)', () => {
  for (const [what, change] of [
    [
      'the note',
      {
        from: 'const ended = identity.account ? await endedSession(stillWrites, corsHeaders) : undefined;',
        to: 'const ended = undefined;',
      },
    ],
    [
      'the batch',
      {
        from: 'const ended = account ? await endedSession(stillWrites, corsHeaders) : undefined;',
        to: 'const ended = undefined;',
      },
    ],
    [
      'the picture',
      {
        from: '  return session?.subject === account ? account : undefined;',
        to: '  return account;',
      },
    ],
  ] as const) {
    it(`writes ${what} of an ended session when its check is taken out`, async () => {
      const mutant = await mutatedModule('app.ts', change);
      try {
        const worker = await workerOf(await opening(createPgliteDatabase), {
          handle: mutant.module.handleRequest as never,
        });
        const failure = await endedWritesNothing(worker).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(
          failure instanceof assert.AssertionError,
          `the scenario did not fail on an assertion: ${String(failure)}`,
        );
      } finally {
        mutant.remove();
      }
    });
  }
});

/** A token signed with the key of a site says nothing of a session of the worker (FRU-238). */
describe('a token of a site, and the claims of a session of the worker (FRU-238)', () => {
  const policy = {
    identitySecret: 'the-own-key-of-a-site-of-enough-length',
    showComments: false,
    read: 'authenticated' as const,
    write: 'public' as const,
    locale: 'en',
    sessions: { secret: SECRET, workspace: 'ws_acme', reaches: async () => true },
  };
  const token = async () => {
    const now = Math.floor(Date.now() / 1000);

    return signIdentityToken(
      { sub: 'visitor-42', scope: 'account', sid: 'a-chain', iat: now, exp: now + 600 },
      policy.identitySecret,
    );
  };

  it('never carries account or chain on a token that the key of a site verified', async () => {
    const verified = await verifyForClient(await token(), policy);
    assert.ok(verified?.ok === true);
    assert.deepEqual(
      [verified.reporter.id, verified.account, verified.chain, verified.session],
      ['visitor-42', undefined, undefined, undefined],
    );
  });

  it('carries them when the token of a site is not stripped', async () => {
    const mutant = await mutatedModule('app.ts', {
      from: 'if (asSite?.ok === true) return ofASite(asSite);',
      to: 'if (asSite?.ok === true) return asSite;',
    });
    try {
      const verify = mutant.module.verifyForClient as typeof verifyForClient;
      const verified = await verify(await token(), policy);
      assert.ok(verified?.ok === true);
      assert.deepEqual([verified.account, verified.chain], [true, 'a-chain']);
    } finally {
      mutant.remove();
    }
  });
});

/**
 * The store of the sessions does not answer while a note of a session of an account is checked
 * (FRU-238): `502 store-unavailable`, which the widget reads as « keep the note, try again », and
 * nothing written. Raised in review.
 */
async function storeDownKeepsTheNote(worker: Worker): Promise<void> {
  const alice = await person(worker, 'alice@acme.dev');
  const acme = await workspaceOf(worker, alice, 'acme');
  const session = await connected(worker, alice);
  const seed = seedFixture();
  const note = { ...seed, page: { ...seed.page, url: 'https://acme.test/pricing' }, client: { id: acme.members } };
  const bearer = { Authorization: `Bearer ${session.accessToken}` };
  const down = mock.method(worker.sessions, 'liveIdentity', async () => {
    throw new StoreError('the sessions did not answer');
  });
  try {
    for (const body of [note, [note]]) {
      const answer = await worker.call('/feedback', { body, origin: EXTENSION, headers: bearer });
      assert.equal(answer.status, 502, JSON.stringify(body).slice(0, 1));
      assert.deepEqual(await answer.json(), { error: 'store-unavailable' });
    }
  } finally {
    down.mock.restore();
  }
  const issues = (await (await read(worker, acme.members, 'https://acme.test', session.accessToken)).json()) as {
    issues: unknown[];
  };
  assert.deepEqual(issues.issues, [], 'a note was written while its session could not be read');
  // The control: the store answers again, and the note goes.
  assert.equal((await worker.call('/feedback', { body: note, origin: EXTENSION, headers: bearer })).status, 201);
}

describe('a note of a session of an account while the store of the sessions is down (FRU-238)', () => {
  it('answers 502 store-unavailable, for a note and a batch, and writes nothing', async () => {
    await storeDownKeepsTheNote(await workerOf(await opening(createPgliteDatabase)));
  });

  it('does not answer 502 when the failure of the store is not caught', async () => {
    const mutant = await mutatedModule('app.ts', {
      after: 'async function endedSession(',
      from: "    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);\n",
      to: '',
    });
    try {
      const worker = await workerOf(await opening(createPgliteDatabase), {
        handle: mutant.module.handleRequest as never,
      });
      const failure = await storeDownKeepsTheNote(worker).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(failure !== undefined, 'the scenario passed with the failure not caught');
    } finally {
      mutant.remove();
    }
  });
});
