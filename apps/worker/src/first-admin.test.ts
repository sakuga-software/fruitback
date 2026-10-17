import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { cookieOf } from './auth-worker.fixture.ts';
import { ORGANIZATION_PATHS } from './organization-paths.ts';
import { AUTH_BASE_PATH, SERVED_PATHS } from './auth.ts';
import { parseAdminLinkArgs, runAdminLink } from './cli.ts';
import { CONSOLE, type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { DATABASE_REQUIRED, REFUSED_SINCE_POSTGRES, REQUIRED_WITH_DATABASE, readConfig } from './env.ts';
import { beforePostgres } from './before-postgres.fixture.ts';
import {
  ADMIN_LINK_TTL_SECONDS,
  type AdminLinks,
  adminLinkFor,
  firstAdminLines,
  readFirstAdmin,
} from './first-admin.ts';
import type { Kv } from './kv.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The sign-in link of the first administrator (FRU-221): `first-admin.ts`, through the routes of the
 * console, on PostgreSQL (PGlite), with better-auth on, and a worker that sends no e-mail.
 *
 * The threats this file holds, each by a case:
 *
 * - whoever reads the log in the window becomes the owner of an empty instance: the window is ten
 *   minutes, the link is spent once, and its use is written in the log;
 * - two replicas that start together: one link;
 * - a link played again; a link kept after an owner signed up by e-mail; a link that a newer one
 *   replaced;
 * - the token in the log: one line, and nowhere else;
 * - a request that makes a link: none does.
 */

const ADMIN = 'ana@acme.dev';
const envOf = worlds();

/** What `first-admin.ts` needs of a world, as `adminLinksFor` gives it to the worker. */
function linksOf(world: World, kv: Kv = world.kv): AdminLinks {
  return { auth: world.auth, kv, owners: () => world.accounts.owners(), consoleUrl: CONSOLE };
}

/** The token of the link in these lines: after the `#`, as the console reads it. */
function tokenIn(lines: readonly string[]): string {
  const holding = lines.filter((line) => line.includes('/sign-in#'));
  assert.equal(holding.length, 1, `the link is on ${holding.length} lines:\n${lines.join('\n')}`);
  const link = /https?:\/\/\S+/.exec(holding[0] ?? '')?.[0] ?? '';
  assert.ok(link.startsWith(`${CONSOLE}/sign-in#`), link);

  return link.slice(link.indexOf('#') + 1);
}

/** The console spends a link: the answer, and the cookie when it signed in. */
async function open(world: World, token: string, kv?: Kv) {
  const answer = await callOn(
    world,
    'POST',
    '/console/auth/email/redeem',
    { body: { token } },
    kv === undefined ? {} : { kv },
  );

  return { status: answer.status, cookie: cookieOf(answer), body: (await answer.json()) as Record<string, unknown> };
}

const me = async (world: World, cookie: string): Promise<number> =>
  (await callOn(world, 'GET', '/console/me', { token: cookie })).status;

const people = async (world: World): Promise<string[]> =>
  (await rowsOf(world.database, 'SELECT email FROM "user" ORDER BY email')).map((row) => String(row.email));

/** Everything written with `console`, while `work` runs. */
async function saidDuring(t: { mock: { method: (...input: never[]) => unknown } }, work: () => Promise<void>) {
  const said: string[] = [];
  const mock = t.mock as unknown as {
    method(target: object, name: string, replacement: (...input: unknown[]) => void): { mock: { restore(): void } };
  };
  const spies = ['log', 'warn', 'error', 'info'].map((name) =>
    mock.method(console, name, (...input: unknown[]) => void said.push(input.map(String).join(' '))),
  );
  try {
    await work();
  } finally {
    for (const spy of spies) spy.mock.restore();
  }

  return said;
}

describe('the link of the first administrator, when the worker starts (FRU-221)', () => {
  it('signs that person in to the console with no e-mail sent, and they make the first workspace', async () => {
    const world = await envOf();

    const lines = await firstAdminLines(linksOf(world), ADMIN);

    assert.match(lines[0] ?? '', /has no owner yet\. Sign-in link for ana@acme\.dev \(FRUITBACK_FIRST_ADMIN\)/);
    assert.match(lines.at(-1) ?? '', /Valid for 10 minutes, and usable once\. Whoever reads this log can use it/);
    assert.equal(ADMIN_LINK_TTL_SECONDS, 600);
    const opened = await open(world, tokenIn(lines));
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal((opened.body.account as { email: string }).email, ADMIN);
    assert.deepEqual(world.mail.sent, [], 'a message was sent');

    assert.equal(await me(world, opened.cookie), 200);
    assert.deepEqual(await world.accounts.owners(), []);
    const workspace = await workspaceIn(world, opened.cookie);
    assert.deepEqual(await world.accounts.owners(), [ADMIN]);
    assert.equal(await world.accounts.role(workspace, (opened.body.account as { id: string }).id), 'owner');
  });

  it('writes nothing once a workspace has an owner: the variable left in the environment opens nothing', async () => {
    const world = await envOf();
    const first = await open(world, tokenIn(await firstAdminLines(linksOf(world), ADMIN)));
    await workspaceIn(world, first.cookie);
    const written: string[] = [];
    const watched: Kv = { ...world.kv, set: (key, value, ttl) => (written.push(key), world.kv.set(key, value, ttl)) };

    // Another start, and another one after the window, for the same address and for another.
    assert.deepEqual(await firstAdminLines(linksOf(world, watched), ADMIN), []);
    assert.deepEqual(
      await firstAdminLines(linksOf(world, watched), 'eve@elsewhere.example', Date.now() + 3_600_000),
      [],
    );

    assert.deepEqual(written, []);
    assert.deepEqual(await people(world), [ADMIN]);
  });

  it('is spent once: the same link opened again is refused', async () => {
    const world = await envOf();
    const token = tokenIn(await firstAdminLines(linksOf(world), ADMIN));

    assert.equal((await open(world, token)).status, 200);
    const again = await open(world, token);

    assert.equal(again.status, 401);
    assert.deepEqual(again.body, { error: 'link-spent-or-expired' });
    assert.equal(again.cookie, '');
  });

  it('is refused after ten minutes, where the link of an e-mail lives fifteen', async () => {
    const world = await envOf();
    const made = Date.now() - (ADMIN_LINK_TTL_SECONDS * 1000 + 1_000);
    // Made eleven minutes ago: better-auth still holds the link, for four more minutes.
    const old = tokenIn(await firstAdminLines(linksOf(world), ADMIN, made));

    const late = await open(world, old);

    assert.equal(late.status, 401);
    assert.deepEqual(await people(world), [], 'the link made an account');
    // The control: the same age less two minutes is spent.
    const fresh = tokenIn(
      (await adminLinkFor(linksOf(world), ADMIN, Date.now() - (ADMIN_LINK_TTL_SECONDS - 120) * 1000)).lines,
    );
    assert.equal((await open(world, fresh)).status, 200);
  });

  it('is one link when two replicas start together, and the other one says that it was written', async () => {
    const world = await envOf();

    const starts = await Promise.all([firstAdminLines(linksOf(world), ADMIN), firstAdminLines(linksOf(world), ADMIN)]);

    const withLink = starts.filter((lines) => lines.some((line) => line.includes('/sign-in#')));
    assert.equal(withLink.length, 1, JSON.stringify(starts));
    const other = starts.find((lines) => !lines.some((line) => line.includes('/sign-in#'))) ?? [];
    assert.match(other.join('\n'), /was written less than 10 minutes ago, by this worker or by another one/);
    assert.doesNotMatch(other.join('\n'), /#/);
    assert.equal((await open(world, tokenIn(withLink[0] ?? []))).status, 200);
  });

  it('does not say that a link was written when the start that should have written it failed', async () => {
    const world = await envOf();
    // better-auth that does not start: a database that is not there yet, at the first start.
    const failing = { ...linksOf(world), auth: Promise.reject(new Error('better-auth did not start')) };

    await assert.rejects(firstAdminLines(failing, ADMIN), /better-auth did not start/);
    // The memory `Kv` of a test ends a key at its instant, and not before.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = await firstAdminLines(linksOf(world), ADMIN);

    assert.equal((await open(world, tokenIn(next))).status, 200);
  });

  it('is refused once somebody else owns a workspace, however they signed in', async () => {
    const world = await envOf();
    const token = tokenIn(await firstAdminLines(linksOf(world), ADMIN));
    // The link is in a log that somebody kept. Meanwhile the instance got its mail, and an owner.
    const bob = await signInTo(world, 'bob@globex.dev');
    await workspaceIn(world, bob.token, 'Globex');
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...input: unknown[]) => void said.push(input.map(String).join(' '));

    let late: Awaited<ReturnType<typeof open>>;
    try {
      late = await open(world, token);
    } finally {
      console.warn = warn;
    }

    assert.equal(late.status, 401);
    assert.equal(late.cookie, '');
    assert.deepEqual(await people(world), ['bob@globex.dev'], 'the link made an account beside the owner');
    assert.match(
      said.join('\n'),
      /a sign-in link made for an administrator was refused: this Fruitback has an owner now/,
    );
    assert.ok(!said.join('\n').includes(token));
    // And it is gone for good: the owner leaving does not bring it back.
    await rowsOf(world.database, 'DELETE FROM member');
    assert.equal((await open(world, token)).status, 401);
  });

  it('writes its token on one line of the log, and nothing else of the worker ever writes it', async (t) => {
    const world = await envOf();
    const lines = await firstAdminLines(linksOf(world), ADMIN);
    const token = tokenIn(lines);
    assert.equal(lines.filter((line) => line.includes(token)).length, 1);
    // A link that a newer one replaces, to see a refusal too.
    const replaced = tokenIn((await adminLinkFor(linksOf(world), ADMIN)).lines);
    const last = tokenIn((await adminLinkFor(linksOf(world), ADMIN)).lines);

    const said = await saidDuring(t as never, async () => {
      assert.equal((await open(world, token)).status, 401);
      assert.equal((await open(world, replaced)).status, 401);
      assert.equal((await open(world, last)).status, 200);
      assert.equal((await open(world, last)).status, 401);
      // A request that puts a token where a log could take it: in the address.
      await callOn(world, 'GET', `/console/auth/email/redeem?token=${last}`);
    });

    // The control: the worker did write, about each of them.
    assert.match(said.join('\n'), /was refused: a link was made after it/);
    assert.match(said.join('\n'), /the sign-in link made for ana@acme\.dev was used/);
    for (const each of [token, replaced, last]) {
      assert.ok(!said.join('\n').includes(each), 'a token is in what the worker wrote');
    }
    // Nor in the database: better-auth keeps a digest, and the marks hold a digest too.
    const tables = await rowsOf(world.database, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    for (const { tablename } of tables) {
      const rows = JSON.stringify(await rowsOf(world.database, `SELECT * FROM "${String(tablename)}"`));
      for (const each of [token, replaced, last]) assert.ok(!rows.includes(each), `a token is in ${String(tablename)}`);
    }
  });
});

describe('no request makes a link for an administrator (FRU-221)', () => {
  /** Every path that a source of the routes spells, and the ones of better-auth. */
  function everyPath(): string[] {
    const spelled = ['app.ts', 'console-api.ts', 'auth-routes.ts', 'auth-organization.ts', 'pair-page.ts'].flatMap(
      (file) =>
        [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/'(\/[a-z0-9/_-]*)'/g)].map(
          (m) => m[1] ?? '',
        ),
    );
    const ofAuth = [
      ...Object.keys(SERVED_PATHS),
      ...Object.keys(ORGANIZATION_PATHS),
      '/sign-in/magic-link',
      '/magic-link/verify',
      '/email',
      '/email/redeem',
    ].map((path) => `${AUTH_BASE_PATH}${path}`);

    return [
      ...new Set([...spelled, ...ofAuth, '/admin-link', '/console/admin-link', '/console/auth/admin-link']),
    ].sort();
  }

  it('whatever the path, the method and the body, on a worker that names a first administrator', async () => {
    const world = await envOf({ env: { FRUITBACK_FIRST_ADMIN: ADMIN } });
    assert.ok(readConfig(world.env).ok);
    const written: string[] = [];
    const watched: Kv = { ...world.kv, set: (key, value, ttl) => (written.push(key), world.kv.set(key, value, ttl)) };
    const paths = everyPath();
    assert.ok(paths.length > 40, `only ${paths.length} paths were found`);
    assert.ok(paths.includes('/console/auth/sign-out') && paths.includes('/feedback') && paths.includes('/console/me'));
    const said: string[] = [];
    const log = console.log;
    console.log = (...input: unknown[]) => void said.push(input.map(String).join(' '));

    try {
      for (const path of paths) {
        for (const method of ['GET', 'POST']) {
          const body = method === 'POST' ? { email: ADMIN, kind: 'first', admin: true } : undefined;
          for (const origin of [CONSOLE, null]) {
            await callOn(world, method, path, { origin, ...(body === undefined ? {} : { body }) }, { kv: watched });
          }
        }
      }
    } finally {
      console.log = log;
    }

    assert.deepEqual(
      written.filter((key) => key.includes('admin-link')),
      [],
    );
    assert.ok(!said.join('\n').includes('/sign-in#'), 'a link is in the log');
    assert.deepEqual(await people(world), []);
    // The control: the start does write those marks, through the same watched store.
    await firstAdminLines(linksOf(world, watched), ADMIN);
    assert.equal(written.filter((key) => key.includes('admin-link')).length, 2);
  });
});

describe('the command admin-link (FRU-221)', () => {
  it('makes the link of an instance with no owner, and leaves a line with the address and no token', async () => {
    const world = await envOf();
    const left: string[] = [];

    const outcome = await runAdminLink(['--email', ` ${ADMIN.toUpperCase()} `], world.env, linksOf(world), (line) => {
      left.push(line);

      return true;
    });

    assert.equal(outcome.ok, true, outcome.lines.join('\n'));
    const token = tokenIn(outcome.lines);
    assert.equal(left.length, 1);
    assert.match(
      left[0] ?? '',
      /^\[fruitback\] \d{4}-\d\d-\d\dT[\d:.]+Z a sign-in link was made by the command admin-link for ana@acme\.dev \(no owner yet\)/,
    );
    assert.ok(!(left[0] ?? '').includes(token) && !(left[0] ?? '').includes('#'));
    assert.match(outcome.lines.at(-1) ?? '', /A line in the log of the worker says that this link was made/);
    assert.equal((await open(world, token)).status, 200);
  });

  it('says so when it could not write in the log of the worker', async () => {
    const world = await envOf();

    const outcome = await runAdminLink(['--email', ADMIN], world.env, linksOf(world), () => false);

    assert.equal(outcome.ok, true);
    assert.match(
      outcome.lines.at(-1) ?? '',
      /could not be written from here: nothing there says that this link was made/,
    );
  });

  it('gives an owner who lost their session a link, and ends no session that is open', async () => {
    const world = await envOf();
    const owner = await signInTo(world, ADMIN);
    const workspace = await workspaceIn(world, owner.token);

    const outcome = await adminLinkFor(linksOf(world), ADMIN);

    assert.equal(outcome.ok, true, outcome.lines.join('\n'));
    assert.match(outcome.lines[0] ?? '', /sign-in link for ana@acme\.dev, an owner of this Fruitback/);
    assert.match(outcome.log ?? '', /for ana@acme\.dev \(an owner\)/);
    // The browser that was signed in still is, before the link is opened and after.
    assert.equal(await me(world, owner.token), 200);
    const elsewhere = await open(world, tokenIn(outcome.lines));
    assert.equal(elsewhere.status, 200);
    assert.equal((elsewhere.body.account as { id: string }).id, owner.id, 'the link made another account');
    assert.equal(await me(world, owner.token), 200);
    assert.equal(await me(world, elsewhere.cookie), 200);
    // And nobody changed: one person, the owner of one workspace.
    assert.deepEqual(await people(world), [ADMIN]);
    assert.equal(await world.accounts.role(workspace, owner.id), 'owner');
  });

  it('refuses every other address once there is an owner: no second owner, and nobody promoted', async () => {
    const world = await envOf();
    const owner = await signInTo(world, ADMIN);
    const workspace = await workspaceIn(world, owner.token);
    const admin = await signInTo(world, 'adele@acme.dev');
    const member = await signInTo(world, 'marc@acme.dev');
    await memberOf(world, workspace, admin.id, 'admin');
    await memberOf(world, workspace, member.id, 'member');
    // A role that better-auth would read as two is no owner here, as everywhere in the worker.
    const both = await signInTo(world, 'both@acme.dev');
    await memberOf(world, workspace, both.id, 'owner,admin');
    const written: string[] = [];
    const watched: Kv = { ...world.kv, set: (key, value, ttl) => (written.push(key), world.kv.set(key, value, ttl)) };

    for (const address of ['adele@acme.dev', 'marc@acme.dev', 'both@acme.dev', 'eve@elsewhere.example']) {
      const outcome = await adminLinkFor(linksOf(world, watched), address);

      assert.equal(outcome.ok, false, address);
      assert.match(outcome.lines.join('\n'), /is not one: .* never makes another owner/, address);
      assert.equal(outcome.log, undefined);
      assert.ok(!outcome.lines.join('\n').includes('#'));
    }

    assert.deepEqual(written, []);
    assert.equal(await world.accounts.role(workspace, admin.id), 'admin');
    assert.equal(await world.accounts.role(workspace, member.id), 'member');
    assert.deepEqual(await world.accounts.owners(), [ADMIN]);
  });

  it('cancels the link before with each new one, whoever asked for each', async () => {
    const world = await envOf();
    const first = tokenIn(await firstAdminLines(linksOf(world), ADMIN));
    const second = tokenIn((await adminLinkFor(linksOf(world), ADMIN)).lines);
    const third = tokenIn((await adminLinkFor(linksOf(world), 'lea@acme.dev')).lines);

    assert.equal((await open(world, first)).status, 401);
    assert.equal((await open(world, second)).status, 401);
    assert.deepEqual(await people(world), []);
    const opened = await open(world, third);
    assert.equal(opened.status, 200);
    assert.equal((opened.body.account as { email: string }).email, 'lea@acme.dev');
  });

  it('refuses the link of an owner who is no owner any more when it is opened', async () => {
    const world = await envOf();
    const owner = await signInTo(world, ADMIN);
    const workspace = await workspaceIn(world, owner.token);
    const other = await signInTo(world, 'lea@acme.dev');
    await memberOf(world, workspace, other.id, 'owner');
    const token = tokenIn((await adminLinkFor(linksOf(world), ADMIN)).lines);

    await rowsOf(world.database, `UPDATE member SET role = 'member' WHERE "userId" = '${owner.id}'`);

    assert.equal((await open(world, token)).status, 401);
  });

  it('makes no link when the store of the marks does not answer, and spends none', async () => {
    const world = await envOf();
    const down: Kv = { ...world.kv, set: () => Promise.reject(new Error('the Kv is down')) };

    await assert.rejects(firstAdminLines(linksOf(world, down), ADMIN), /the Kv is down/);
    const outcome = await runAdminLink(['--email', ADMIN], world.env, linksOf(world, down), () => true);
    assert.equal(outcome.ok, false);
    assert.match(outcome.lines.join('\n'), /No link was made\.$/);
    assert.ok(!outcome.lines.join('\n').includes('#'));
  });

  it('takes one flag and one address', () => {
    assert.deepEqual(parseAdminLinkArgs(['--email', ADMIN]), { ok: true, email: ADMIN });
    for (const argv of [
      [],
      ['--email'],
      ['--email', '--dry-run'],
      [ADMIN],
      ['--email', ADMIN, '--owner'],
      ['--mail', ADMIN],
    ]) {
      assert.equal(parseAdminLinkArgs(argv).ok, false, argv.join(' '));
    }
  });
});

describe('FRUITBACK_FIRST_ADMIN in the configuration (FRU-221)', () => {
  const missing = (env: Record<string, string>): string[] => {
    const config = readConfig(env);

    return config.ok ? [] : config.missing;
  };

  it('is one address, and needs the sign-in of the console, whose secret the worker does not make', async () => {
    const world = await envOf();
    const env = world.env as Record<string, string>;

    assert.deepEqual(missing({ ...env, FRUITBACK_FIRST_ADMIN: ADMIN }), []);
    assert.equal(readFirstAdmin(` ${ADMIN.toUpperCase()} `), ADMIN);
    assert.deepEqual(missing({ ...env, FRUITBACK_FIRST_ADMIN: '  ' }), []);
    for (const value of ['Ana', 'Ana <ana@acme.dev>', 'ana@acme.dev, lea@acme.dev']) {
      assert.match(
        missing({ ...env, FRUITBACK_FIRST_ADMIN: value }).join(' | '),
        /^FRUITBACK_FIRST_ADMIN \(the address of one person\)$/,
      );
    }
    const { FRUITBACK_AUTH_SECRET: _secret, ...withoutSecret } = env;
    // FRU-225: the secret is asked for beside any database, with or without this variable.
    assert.deepEqual(missing({ ...withoutSecret, FRUITBACK_FIRST_ADMIN: ADMIN }), [
      REQUIRED_WITH_DATABASE.FRUITBACK_AUTH_SECRET,
    ]);
    assert.match(REQUIRED_WITH_DATABASE.FRUITBACK_AUTH_SECRET, /which the worker does not make/);
    const alone = { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://a.test', FRUITBACK_FIRST_ADMIN: ADMIN };
    assert.equal(missing(alone)[0], DATABASE_REQUIRED);
    // The worker of before, which started with no database or no secret, said it of this variable.
    assert.match(
      missing(beforePostgres({ ...withoutSecret, FRUITBACK_FIRST_ADMIN: ADMIN })).join(' | '),
      /FRUITBACK_AUTH_SECRET \(FRUITBACK_FIRST_ADMIN is set.*which the worker does not make\)/,
    );
    assert.match(missing(beforePostgres(alone)).join(' | '), /FRUITBACK_DATABASE_URL \(FRUITBACK_FIRST_ADMIN is set/);
  });

  it('leaves FRUITBACK_FIRST_REVIEWER refused on a worker with workspaces, with what to do', async () => {
    const world = await envOf();

    const env = { ...(world.env as Record<string, string>), FRUITBACK_FIRST_REVIEWER: 'Ana <ana@acme.dev>' };
    // FRU-225: every worker has workspaces, so the variable is refused by its own sentence.
    assert.deepEqual(missing(env), [REFUSED_SINCE_POSTGRES.FRUITBACK_FIRST_REVIEWER]);
    assert.match(REFUSED_SINCE_POSTGRES.FRUITBACK_FIRST_REVIEWER, /FRUITBACK_FIRST_ADMIN/);
    // FRU-226: the code of the variable is gone, so the worker of before says the same sentence.
    assert.ok(missing(beforePostgres(env)).includes(REFUSED_SINCE_POSTGRES.FRUITBACK_FIRST_REVIEWER));
  });
});
