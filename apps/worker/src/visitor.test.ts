import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Seed, canonicalizePageUrl } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { type World, callOn, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresSeedStore } from './seeds-postgres.ts';

/**
 * A visitor leaves a note with no account (FRU-224), on a worker that has accounts.
 *
 * Mathieu, 2026-10-13: « on peut créer un compte quoiqu'il arrive aussi pour la partie admin, par
 * contre pas forcément besoin de compte pour laisser des notes côté user ». The code was there: a
 * site that everyone reads takes a note from a page with no session and no token. No test held the
 * whole path on a worker whose sites come from the console: the ones that did ran on
 * `FRUITBACK_CLIENTS`, which is going (FRU-184).
 *
 * Each case goes through `handleRequest`, on PostgreSQL (PGlite), with better-auth on. An admin
 * signs in and makes the site through the route of the console. The visitor then sends what the
 * `<script>` of the site sends: the id of the site, the `Origin` of the page, and nothing else. The
 * notes are in the store of the database (FRU-218).
 */

const SITE = 'https://staging.acme.test';
/** The origin of a site of another workspace of the worker, and one that is no site of anybody. */
const SERVED = 'https://staging.globex.test';
const NOWHERE = 'https://elsewhere.example';
const PAGE = canonicalizePageUrl(`${SITE}/pricing`);

const envOf = worlds();

function noteFor(site: string, more: Partial<Seed> = {}): Seed {
  const seed = seedFixture({ id: 'sd_visitor', page: { url: PAGE, path: '/pricing', title: 'Pricing' } });
  const { client: _own, ...rest } = seed;

  return { ...rest, client: { id: site, name: 'Acme' }, ...more };
}

/** A worker with one workspace, and the site that its admin made in the console. */
async function workerWithASite(visibility: 'everyone' | 'members') {
  const world = await envOf({ env: { FRUITBACK_STORE: 'postgres' } });
  const admin = await signInTo(world, 'ana@acme.dev');
  const workspace = await workspaceIn(world, admin.token);
  const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
    token: admin.token,
    body: { url: `${SITE}/pricing?tab=annual`, visibility },
  });
  assert.equal(made.status, 201, await made.clone().text());
  const site = ((await made.json()) as { id: string }).id;
  const store = createPostgresSeedStore(world.database);

  /** What a page sends: an `Origin`, and no `Authorization` and no `Cookie`. `null` is no `Origin` at all. */
  const visitor = {
    send: (origin: string | null, note: Seed = noteFor(site)) =>
      callOn(world, 'POST', '/feedback', { origin, body: note }, { store }),
    read: (origin: string | null, client = site) =>
      callOn(world, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${client}`, { origin }, { store }),
  };

  return { world, admin, workspace, site, store, visitor };
}

async function notesOf(answer: Response): Promise<{ note: string; verified: unknown; name: unknown }[]> {
  assert.equal(answer.status, 200, await answer.clone().text());
  const { issues } = (await answer.json()) as {
    issues: { seed: { note: string; reporter?: { verified?: boolean; name?: string } } }[];
  };

  return issues.map((issue) => ({
    note: issue.seed.note,
    verified: issue.seed.reporter?.verified,
    name: issue.seed.reporter?.name,
  }));
}

const rowsIn = async (world: World): Promise<number> =>
  Number((await rowsOf(world.database, 'SELECT count(*)::int AS n FROM seeds'))[0]?.n);

describe('a visitor with no account, on a site that everyone reads (FRU-224)', () => {
  it('leaves a note and reads it again, with no session, no token and no cookie', async () => {
    const { world, visitor } = await workerWithASite('everyone');

    const sent = await visitor.send(SITE, noteFor('ignored', { note: 'The button is too small.' }));
    // The note names a site that is not one: the control of the next lines, which name the right one.
    assert.equal(sent.status, 400, await sent.clone().text());
    assert.equal(await rowsIn(world), 0);

    const { site } = { site: (await rowsOf(world.database, 'SELECT id FROM sites'))[0]?.id as string };
    const kept = await visitor.send(SITE, noteFor(site, { note: 'The button is too small.' }));
    assert.equal(kept.status, 201, await kept.clone().text());
    assert.deepEqual(await kept.json(), { issue: { id: '1', identifier: 'FB-1' } });

    assert.deepEqual(
      (await notesOf(await visitor.read(SITE))).map((read) => read.note),
      ['The button is too small.'],
    );
    assert.equal(await rowsIn(world), 1);
  });

  it('keeps the name the visitor typed, and never says the worker verified it', async () => {
    const { site, visitor } = await workerWithASite('everyone');
    // A visitor can type anything, a `verified` of their own included.
    const typed = noteFor(site, {
      reporter: { name: 'Alice', email: 'alice@acme.dev', verified: true } as Seed['reporter'],
    });

    assert.equal((await visitor.send(SITE, typed)).status, 201);

    const [read] = await notesOf(await visitor.read(SITE));
    assert.equal(read?.name, 'Alice');
    assert.notEqual(read?.verified, true);
  });

  it('refuses a note and a read that name the site from the page of another site', async () => {
    const { world, site, visitor } = await workerWithASite('everyone');
    assert.equal((await visitor.send(SITE)).status, 201);
    // Another workspace of the same worker has a site too: its origin is one the worker serves.
    const other = await signInTo(world, 'bob@globex.dev');
    const made = await callOn(
      world,
      'POST',
      `/console/workspaces/${await workspaceIn(world, other.token, 'Globex')}/sites`,
      {
        token: other.token,
        body: { url: SERVED, visibility: 'everyone' },
      },
    );
    assert.equal(made.status, 201);

    // Two refusals, by two checks. The origin of no site is refused before the site is looked for,
    // and the origin of another site is refused for this one.
    for (const [origin, error] of [
      [NOWHERE, 'origin-not-allowed'],
      [SERVED, 'origin-not-allowed-for-client'],
    ] as const) {
      for (const answer of [await visitor.send(origin), await visitor.read(origin)]) {
        assert.equal(answer.status, 403, origin);
        assert.deepEqual(await answer.json(), { error }, origin);
      }
    }
    assert.equal(await rowsIn(world), 1);
    // The site is not served under a name the worker does not know either.
    assert.deepEqual(await (await visitor.read(SITE, `${site}x`)).json(), { error: 'unknown-client' });
  });

  it('serves the site at its origin alone: the address the admin pasted had a path and a query', async () => {
    const { visitor } = await workerWithASite('everyone');

    for (const origin of [`${SITE}:8443`, SITE.replace('https:', 'http:'), 'https://acme.test']) {
      assert.equal((await visitor.read(origin)).status, 403, origin);
    }
    assert.equal((await visitor.read(SITE)).status, 200);
  });
});

describe('a visitor with no account, on a site that its members read (FRU-224)', () => {
  it('reads no note: the worker asks for a session, and says so', async () => {
    const { world, admin, workspace, store, visitor } = await workerWithASite('members');

    const read = await visitor.read(SITE);

    assert.equal(read.status, 401, await read.clone().text());
    assert.deepEqual(await read.json(), { error: 'identity-required', reason: 'identity-required' });
    // The control, in the same world (one PGlite database for a process at a time, raised in
    // review): the same read, from a page of a site of the same workspace that everyone reads.
    const docs = 'https://docs.acme.test';
    const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: admin.token,
      body: { url: docs, visibility: 'everyone' },
    });
    const open = ((await made.json()) as { id: string }).id;
    const page = encodeURIComponent(canonicalizePageUrl(`${docs}/start`));
    const control = await callOn(world, 'GET', `/feedback?url=${page}&client=${open}`, { origin: docs }, { store });
    assert.equal(control.status, 200, await control.clone().text());
  });

  /**
   * WARNING: this case holds what the worker does, and it is not a promise of the product.
   * « Who reads » is what the visibility of a site decides (`read` of `clientOf`, `authorizeRead`).
   * A note that comes with no token is a claim on every site (`attributionFor`), and is kept: a
   * visitor of a site for members writes a note that they cannot read back. Whether such a site
   * should refuse it is a question for Mathieu (FRU-224, FRU-184). The day it does, this case
   * changes with `SECURITY.md`.
   */
  it('still takes a note sent with no session, which its sender cannot read back', async () => {
    const { world, visitor } = await workerWithASite('members');

    const sent = await visitor.send(SITE);

    assert.equal(sent.status, 201, await sent.clone().text());
    assert.equal(await rowsIn(world), 1);
    assert.equal((await visitor.read(SITE)).status, 401);
    // The note is one that nobody vouched for.
    assert.notEqual(
      (JSON.parse(String((await rowsOf(world.database, 'SELECT seed FROM seeds'))[0]?.seed)) as Seed).reporter
        ?.verified,
      true,
    );
  });

  it('is the default of a site that the console makes with no visibility named', async () => {
    const world = await envOf({ env: { FRUITBACK_STORE: 'postgres' } });
    const admin = await signInTo(world, 'ana@acme.dev');
    const workspace = await workspaceIn(world, admin.token);

    const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
      token: admin.token,
      body: { url: SITE },
    });

    assert.equal(((await made.json()) as { visibility: string }).visibility, 'members');
  });
});
