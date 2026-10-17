import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { type WorkerEnv, readConfig } from './env.ts';
import { createPairing, type SessionStore } from './session.ts';
import { type RequestContext, handleRequest } from './app.ts';
import { verifyIdentityToken } from './identity.ts';
import { LOOPBACK, runPair } from './cli.ts';
import type { AccountStore } from './accounts.ts';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { envWith as workerEnv } from './auth-worker.fixture.ts';
import { createMemoryKv } from './kv.ts';
import { createPgDatabase } from './postgres.ts';
import { createPgliteDatabase } from './postgres.fixture.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { beforePostgres } from './before-postgres.fixture.ts';

/** 32 characters, because `readConfig` refuses a shorter HMAC secret. */
const SECRET = 'a-worker-secret-of-exactly-enough';
const ALICE = { subject: 'alice', name: 'Alice Martin', email: 'alice@acme.dev' };

/**
 * One database for the file, on PGlite: the accounts and the sessions of the worker. `postgres.fixture.ts`
 * closes it after the file. The limiter of the worker counts every test of this file together, in one `Kv`.
 */
let accounts: AccountStore;
let sessions: SessionStore;
const kv = createMemoryKv();

before(async () => {
  const database = await createPgliteDatabase();
  accounts = createPostgresAccountStore(database);
  sessions = createPostgresSessionStore(database);
});

/** A worker with a database. Its stores are the ones of the file: see `contextFor`. */
function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return workerEnv({ ALLOWED_ORIGINS: '*', FRUITBACK_IDENTITY_SECRET: SECRET, ...overrides });
}

/** What the transport hands a worker with a database. A worker with none gets no store. */
function contextFor(env: WorkerEnv, clientIp: string): Partial<RequestContext> & { clientIp: string } {
  return env.FRUITBACK_DATABASE_URL ? { clientIp, accounts, sessionStore: sessions, kv } : { clientIp };
}

async function call(
  env: WorkerEnv,
  path: string,
  body?: unknown,
  method = 'POST',
  ip = '203.0.113.7',
): Promise<Response> {
  return handleRequest(
    new Request(`https://worker.test${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    }),
    env,
    contextFor(env, ip),
  );
}

/** Mints a code straight against the store the routes use. */
async function codeFor(): Promise<string> {
  return (await createPairing(sessions, ALICE)).code;
}

describe('POST /session/pair', () => {
  it('answers a session the read path already knows how to verify', async () => {
    const env = envWith();
    const response = await call(env, '/session/pair', { code: await codeFor() });

    assert.equal(response.status, 200);
    const session = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };

    const verified = await verifyIdentityToken(session.accessToken, SECRET);
    assert.ok(verified.ok);
    assert.deepEqual(verified.reporter, { id: 'alice', name: 'Alice Martin', email: 'alice@acme.dev', verified: true });
    assert.ok(session.refreshToken.length > 0);
  });

  it('refuses a code that was never minted', async () => {
    const response = await call(envWith(), '/session/pair', { code: 'ZZZZ-ZZZZ-ZZZZ' });

    assert.equal(response.status, 401);
  });

  it('refuses a body that is not an object with a code', async () => {
    const env = envWith();

    assert.equal((await call(env, '/session/pair', { code: 42 })).status, 400);
    assert.equal((await call(env, '/session/pair', ['a-code'])).status, 400);
  });

  it('refuses a method other than POST', async () => {
    assert.equal((await call(envWith(), '/session/pair', undefined, 'GET')).status, 405);
  });
});

describe('POST /session/refresh', () => {
  it('mints a fresh access token for a live session', async () => {
    const env = envWith();
    const paired = (await (await call(env, '/session/pair', { code: await codeFor() })).json()) as {
      refreshToken: string;
    };

    const response = await call(env, '/session/refresh', { refreshToken: paired.refreshToken });

    assert.equal(response.status, 200);
    const refreshed = (await response.json()) as { accessToken: string; identity: unknown };
    assert.ok((await verifyIdentityToken(refreshed.accessToken, SECRET)).ok);
    assert.deepEqual(refreshed.identity, ALICE);
  });

  /**
   * The answer carries a **new** refresh token, and the route is the half that can silently not
   * (FRU-61).
   *
   * `app.ts` builds this body field by field, so omitting the rotated token is what it would do by
   * default: the rotation would work perfectly, the store would hold the successor, and the client
   * would go on sending a token the worker had already retired. `tsc` cannot see that, and the
   * extension's own tests cannot either — they fake the worker.
   */
  it('hands back the rotated refresh token, and it is the one that works next', async () => {
    const env = envWith();
    // Its own address: the rate limiter is per process and shared by every test in this file, so a
    // case that makes several calls would otherwise push a later one into a `429`.
    const ip = '198.51.100.60';
    const paired = (await (await call(env, '/session/pair', { code: await codeFor() }, 'POST', ip)).json()) as {
      refreshToken: string;
    };

    const refreshed = (await (
      await call(env, '/session/refresh', { refreshToken: paired.refreshToken }, 'POST', ip)
    ).json()) as { refreshToken?: string };

    assert.ok(typeof refreshed.refreshToken === 'string', 'the route dropped the rotated token');
    assert.notEqual(refreshed.refreshToken, paired.refreshToken);
    const next = await call(env, '/session/refresh', { refreshToken: refreshed.refreshToken }, 'POST', ip);
    assert.equal(next.status, 200);
  });

  /**
   * The token that was **spent** never comes back, which is what the old version of this test meant
   * before rotation existed. Echoing it would undo the rotation in the one place a client reads.
   */
  it('never echoes the token it was given', async () => {
    const env = envWith();
    const ip = '198.51.100.61';
    const paired = (await (await call(env, '/session/pair', { code: await codeFor() }, 'POST', ip)).json()) as {
      refreshToken: string;
    };

    const body = await (await call(env, '/session/refresh', { refreshToken: paired.refreshToken }, 'POST', ip)).text();

    assert.equal(body.includes(paired.refreshToken), false);
  });

  /** A token replayed after its successor was used is a copy, and the answer says nothing about it. */
  it('answers a replayed token the same 401 as one that never existed', async () => {
    const env = envWith();
    const ip = '198.51.100.62';
    const paired = (await (await call(env, '/session/pair', { code: await codeFor() }, 'POST', ip)).json()) as {
      refreshToken: string;
    };
    const first = (await (
      await call(env, '/session/refresh', { refreshToken: paired.refreshToken }, 'POST', ip)
    ).json()) as { refreshToken: string };
    await call(env, '/session/refresh', { refreshToken: first.refreshToken }, 'POST', ip);

    const replayed = await call(env, '/session/refresh', { refreshToken: paired.refreshToken }, 'POST', ip);
    const invented = await call(env, '/session/refresh', { refreshToken: 'invented' }, 'POST', ip);

    assert.equal(replayed.status, 401);
    assert.deepEqual(await replayed.json(), await invented.json());
  });

  it('refuses a token this worker never issued', async () => {
    const response = await call(envWith(), '/session/refresh', { refreshToken: 'invented' });

    assert.equal(response.status, 401);
  });
});

describe('POST /session/revoke', () => {
  it('ends the session on the worker, not only in the extension', async () => {
    const env = envWith();
    const paired = (await (await call(env, '/session/pair', { code: await codeFor() })).json()) as {
      refreshToken: string;
    };

    assert.equal((await call(env, '/session/revoke', { refreshToken: paired.refreshToken })).status, 204);
    assert.equal((await call(env, '/session/refresh', { refreshToken: paired.refreshToken })).status, 401);
  });

  /** A logout that reported "nothing to revoke" would tell a caller which refresh tokens are live. */
  it('answers the same way for a token that was never issued', async () => {
    const env = envWith();

    assert.equal((await call(env, '/session/revoke', { refreshToken: 'invented' })).status, 204);
  });
});

describe('GET /pair, the page a pairing link opens (FRU-92)', () => {
  const page = (env: WorkerEnv, path = '/pair', init: RequestInit = {}) =>
    // An address of its own: the limiter of this process counts every test of this file together.
    handleRequest(new Request(`https://worker.test${path}`, init), env, contextFor(env, '198.51.100.92'));

  it('answers a page with no script, that nothing keeps and that says nothing of where it came from', async () => {
    const response = await page(envWith());
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type') ?? '', /^text\/html/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.match(response.headers.get('Content-Security-Policy') ?? '', /default-src 'none'/);
    assert.doesNotMatch(response.headers.get('Content-Security-Policy') ?? '', /script-src/);
    assert.doesNotMatch(html, /<script|javascript:|\son\w+=/i);
    assert.match(html, /Pair with this worker/);
  });

  /**
   * The code belongs in the fragment, which never reaches here. A link written with a query by
   * mistake must not have its code read, echoed or stored: the page is the same bytes.
   */
  it('reads nothing from the address it was asked for', async () => {
    const env = envWith();
    const plain = await (await page(env)).text();
    const withQuery = await (await page(env, '/pair?code=ABCD-EFGH-JKMN&name=%3Cb%3EMallory')).text();

    assert.equal(withQuery, plain);
    assert.doesNotMatch(withQuery, /ABCD-EFGH-JKMN|Mallory/);
  });

  it('says how long a code lives, from the constant the worker uses', async () => {
    assert.match(await (await page(envWith())).text(), /works once, for 15 minutes/);
  });

  it('does not exist on a worker that keeps no sessions', async () => {
    const response = await page(beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' }));

    assert.equal(response.status, 404);
  });

  it('is a page to open, and nothing to post to', async () => {
    assert.equal((await page(envWith(), '/pair', { method: 'POST', body: '{}' })).status, 405);
  });

  it('opens whatever sites the worker serves, because a link is not a site', async () => {
    // A navigation can carry an Origin. The list of client sites must not turn the page away.
    const response = await page(envWith({ ALLOWED_ORIGINS: 'https://app.acme.dev' }), '/pair', {
      headers: { Origin: 'https://mail.example.com' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  });

  it('is metered like every other route', async () => {
    const env = envWith({ RATE_LIMIT_PER_MINUTE: '2' });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push(
        (await handleRequest(new Request('https://worker.test/pair'), env, contextFor(env, '198.51.100.44'))).status,
      );
    }

    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

describe('a worker with no session store', () => {
  it('does not advertise that these routes exist', async () => {
    const env = beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' });

    assert.equal((await call(env, '/session/pair', { code: 'ZZZZ-ZZZZ-ZZZZ' })).status, 404);
    assert.equal((await call(env, '/session/refresh', { refreshToken: 'x' })).status, 404);
  });

  it('leaves /health exactly as it was', async () => {
    const env = beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' });
    const response = await handleRequest(new Request('https://worker.test/health'), env, { clientIp: '203.0.113.7' });

    assert.deepEqual(await response.json(), { ok: true, store: 'memory', openRead: 1 });
  });
});

describe('the boot guards', () => {
  it('refuses sessions with no key to sign an access token with', () => {
    const result = readConfig(envWith({ FRUITBACK_IDENTITY_SECRET: undefined }));

    assert.equal(result.ok, false);
    assert.ok(
      result.ok === false && result.missing.some((name) => name.startsWith('FRUITBACK_IDENTITY_SECRET')),
      `expected the identity secret to be named, got ${result.ok === false ? result.missing.join(', ') : ''}`,
    );
  });
});

describe('the pair command', () => {
  it('mints a code the pair route then accepts', async () => {
    const env = envWith();
    const outcome = await runPair(['--subject', 'alice', '--name', 'Alice Martin'], env, sessions);

    assert.ok(outcome.ok, outcome.lines.join('\n'));
    const code = outcome.lines.find((line) => /^ {4}[0-9A-Z]{4}-/.test(line))?.trim();
    assert.ok(code !== undefined, `no code in:\n${outcome.lines.join('\n')}`);

    const response = await call(env, '/session/pair', { code });
    assert.equal(response.status, 200);

    const session = (await response.json()) as { identity: unknown };
    assert.deepEqual(session.identity, { subject: 'alice', name: 'Alice Martin' });
  });

  it('prints a link when it is told where the worker answers, with the code after the # (FRU-92)', async () => {
    const env = envWith();
    const outcome = await runPair(
      ['--subject', 'alice', '--endpoint', 'https://feedback.acme.dev/fruitback/?x=1#y'],
      env,
      sessions,
    );

    assert.ok(outcome.ok, outcome.lines.join('\n'));
    const code = outcome.lines.find((line) => /^ {4}[0-9A-Z]{4}-/.test(line))?.trim();
    const link = outcome.lines.find((line) => line.includes('/pair#'))?.trim();
    assert.equal(link, `https://feedback.acme.dev/fruitback/pair#${code}`);
    // The code is after the #, so no server on the way receives it.
    assert.equal(new URL(link ?? '').search, '');
    assert.equal((await call(env, '/session/pair', { code }, 'POST', '198.51.100.93')).status, 200);
  });

  it('prints the code alone, and how to get a link, when it is not told where the worker answers', async () => {
    const outcome = await runPair(['--subject', 'alice'], envWith(), sessions);

    assert.ok(outcome.ok);
    assert.equal(
      outcome.lines.some((line) => line.includes('/pair#')),
      false,
    );
    assert.ok(outcome.lines.join('\n').includes('--endpoint'));
  });

  /**
   * The command prints a link, and the extension decides whether it pairs there. Two lists of the
   * hosts where plain http is allowed, in two packages, with nothing else to hold them together.
   */
  it('prints a link over plain http for the hosts the extension pairs with, and for no other', async () => {
    const source = readFileSync(new URL('../../extension/src/endpoint.ts', import.meta.url), 'utf8');
    const declared = /const LOOPBACK = \[(.+)\];/.exec(source)?.[1] ?? '';
    const ofTheExtension = [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');

    assert.ok(ofTheExtension.length >= 3, 'the list of the extension was not read: this check compares nothing');
    // The extension also names `::1` without brackets, a spelling `new URL` never answers.
    assert.deepEqual([...LOOPBACK].sort(), ofTheExtension.filter((host) => host !== '::1').sort());

    for (const host of LOOPBACK) {
      const outcome = await runPair(['--subject', 'alice', '--endpoint', `http://${host}:8789`], envWith(), sessions);
      assert.ok(outcome.ok && outcome.lines.some((line) => line.includes(`http://${host}:8789/pair#`)), host);
    }
  });

  it('refuses an address a pairing code must not cross, and mints nothing', async () => {
    for (const endpoint of ['http://feedback.acme.dev', 'ftp://acme.dev', 'not a url', 'https://user:pw@acme.dev']) {
      const outcome = await runPair(['--subject', 'alice', '--endpoint', endpoint], envWith(), sessions);

      assert.equal(outcome.ok, false, endpoint);
      assert.equal(
        outcome.lines.some((line) => /^ {4}[0-9A-Z]{4}-/.test(line)),
        false,
        endpoint,
      );
    }
    // Loopback is the dev loop, and it is not on a wire.
    assert.ok((await runPair(['--subject', 'alice', '--endpoint', 'http://localhost:8789'], envWith(), sessions)).ok);
  });

  /**
   * A worker of before with no database is valid for `readConfig` in a test, and the command is what
   * cannot run. It has to name the variable.
   */
  it('names the variable when this worker keeps no sessions', async () => {
    const outcome = await runPair(
      ['--subject', 'alice'],
      beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' }),
    );

    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.lines, ['FRUITBACK_DATABASE_URL is not set, so this worker keeps no sessions']);
  });

  it('reports a misconfigured worker rather than minting against it', async () => {
    const outcome = await runPair(['--subject', 'alice'], envWith({ FRUITBACK_IDENTITY_SECRET: undefined }), sessions);

    assert.equal(outcome.ok, false);
    // The boot guard: sessions with no key to sign with. Named, not discovered at runtime.
    assert.ok(outcome.lines.join(' ').includes('FRUITBACK_IDENTITY_SECRET'), outcome.lines.join('\n'));
  });

  it('requires a subject, because that is what lands in reporter.id', async () => {
    const outcome = await runPair(['--name', 'Alice Martin'], envWith(), sessions);

    assert.equal(outcome.ok, false);
    assert.ok(outcome.lines.join(' ').includes('--subject'), outcome.lines.join('\n'));
  });

  /** `--name=Alice Martin` is the spelling that silently drops the surname, so it is refused. */
  it('refuses --flag=value rather than half-supporting it', async () => {
    const outcome = await runPair(['--subject=alice'], envWith(), sessions);

    assert.equal(outcome.ok, false);
  });
});

describe('the rate limit', () => {
  /**
   * The reason `checkRateLimit` moved above the path dispatch (FRU-42).
   *
   * A pairing code is 60 bits, which is plenty on its own — but an unmetered endpoint that answers
   * "yes or no" to a guess is an oracle, and this check used to sit *below* the `404` that rejected
   * every path but `/feedback`. A route added there would have been unmetered by default, with
   * nothing to notice.
   */
  it('meters the pairing endpoint, not only /feedback', async () => {
    const env = envWith({ RATE_LIMIT_PER_MINUTE: '2' });
    const guess = { code: 'ZZZZ-ZZZZ-ZZZZ' };
    const ip = '198.51.100.11';

    assert.equal((await call(env, '/session/pair', guess, 'POST', ip)).status, 401);
    assert.equal((await call(env, '/session/pair', guess, 'POST', ip)).status, 401);
    assert.equal((await call(env, '/session/pair', guess, 'POST', ip)).status, 429);
  });

  /** An unknown path costs quota now too, which is the right answer for something being probed. */
  it('meters a path that matches nothing', async () => {
    const env = envWith({ RATE_LIMIT_PER_MINUTE: '1' });
    const ip = '198.51.100.12';

    assert.equal((await call(env, '/nothing-here', undefined, 'GET', ip)).status, 404);
    assert.equal((await call(env, '/nothing-here', undefined, 'GET', ip)).status, 429);
  });

  /** `/health` stays free: a readiness probe that can be rate-limited takes the container out. */
  it('leaves /health unmetered', async () => {
    const env = envWith({ RATE_LIMIT_PER_MINUTE: '1' });
    const ip = '198.51.100.13';

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await handleRequest(new Request('https://worker.test/health'), env, contextFor(env, ip));
      assert.equal(response.status, 200, `attempt ${attempt} answered ${response.status}`);
    }
  });
});

describe('who may call these routes', () => {
  /**
   * The extension is not a site on `ALLOWED_ORIGINS` and cannot be put on one: its origin carries an
   * id that differs between an unpacked build and a store build. Measured before `openCors` existed
   * — an MV3 service worker posting JSON sends that origin, triggers a preflight, and both answered
   * `403` against a normal allowlist.
   */
  it('answers an extension origin that is on no allowlist', async () => {
    const env = envWith({ ALLOWED_ORIGINS: 'https://staging.acme.dev' });
    const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

    const response = await handleRequest(
      new Request('https://worker.test/session/pair', {
        method: 'POST',
        body: JSON.stringify({ code: await codeFor() }),
        headers: { 'Content-Type': 'application/json', Origin: extension },
      }),
      env,
      contextFor(env, '198.51.100.21'),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), extension);
  });

  it('lets the preflight through, or the POST never happens', async () => {
    const env = envWith({ ALLOWED_ORIGINS: 'https://staging.acme.dev' });
    const response = await handleRequest(
      new Request('https://worker.test/session/pair', {
        method: 'OPTIONS',
        headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
      }),
      env,
      contextFor(env, '198.51.100.22'),
    );

    assert.equal(response.status, 204);
    assert.ok(response.headers.get('Access-Control-Allow-Headers')?.includes('Content-Type'));
  });

  /**
   * The allowlist still governs `/feedback`, and it governs **sites** (FRU-57).
   *
   * This test used to assert that an extension origin was refused here, and that was true until the
   * relay existed: team mode has the extension call `/feedback` from its own service worker, which
   * sends `chrome-extension://<id>` — an id no operator can put on an allowlist. So the scheme is
   * admitted, and what the list still refuses is a site nobody named. `SECURITY.md` says the same in
   * prose, in the same change.
   */
  it('leaves the allowlist in force on /feedback for sites, and admits the extension', async () => {
    const env = envWith({ ALLOWED_ORIGINS: 'https://staging.acme.dev' });
    const from = async (origin: string) =>
      handleRequest(
        new Request('https://worker.test/feedback?url=https://staging.acme.dev/', { headers: { Origin: origin } }),
        env,
        contextFor(env, '198.51.100.23'),
      );

    assert.equal((await from('https://evil.test')).status, 403);
    assert.notEqual((await from('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).status, 403);
  });

  it('answers 413 on an oversized body, which is what the failure codes promise', async () => {
    const env = envWith();
    const response = await call(env, '/session/pair', { code: 'x'.repeat(70 * 1024) }, 'POST', '198.51.100.24');

    assert.equal(response.status, 413);
  });
});

describe('a session store that cannot be opened', () => {
  /**
   * A database that does not answer.
   *
   * Answered like the seed path's outage rather than as a bare `500`, so the extension can tell
   * "retry later" from "this request was wrong" — and so the answer carries the CORS headers it
   * needs to read it at all. Raised in review: the session connector threw a plain `Error`, which
   * `handleSession` had nothing to map. It raises `StoreError` now, like the seed connector.
   */
  it('answers 502 store-unavailable, with the headers the extension can read', async () => {
    const env = envWith();
    const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    // Port 1 of this machine: nothing listens there.
    const down = createPgDatabase('postgres://fruitback:not-a-password@127.0.0.1:1/fruitback', 'public');

    try {
      const response = await handleRequest(
        new Request('https://worker.test/session/pair', {
          method: 'POST',
          body: JSON.stringify({ code: 'ZZZZ-ZZZZ-ZZZZ' }),
          headers: { 'Content-Type': 'application/json', Origin: extension },
        }),
        env,
        { ...contextFor(env, '198.51.100.31'), sessionStore: createPostgresSessionStore(down) },
      );

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'store-unavailable' });
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), extension);
    } finally {
      await down.close();
    }
  });
});

describe('the body cap', () => {
  /**
   * The first version of this handler called `request.text()` and then measured `text.length`.
   *
   * Two defects in one line: the whole upload was buffered before anything was checked, and
   * `.length` counts UTF-16 units rather than bytes — so a multibyte body passed a cap it had
   * already crossed. `readBoundedText` refuses a declared length before a byte is read and cancels
   * the stream once a chunked upload crosses it. Raised in review.
   */
  it('refuses a declared length over the cap before reading the body', async () => {
    const env = envWith();
    const response = await handleRequest(
      new Request('https://worker.test/session/pair', {
        method: 'POST',
        body: 'x'.repeat(100),
        // What an attacker declares. The body never has to match it for the cap to apply.
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(70 * 1024) },
      }),
      env,
      contextFor(env, '198.51.100.32'),
    );

    assert.equal(response.status, 413);
  });

  /** Counted in bytes, not UTF-16 units: 40k of three-byte characters is over a 64 KiB cap. */
  it('counts bytes rather than characters', async () => {
    const env = envWith();
    const response = await call(env, '/session/pair', { code: '€'.repeat(40 * 1024) }, 'POST', '198.51.100.33');

    assert.equal(response.status, 413);
  });
});

describe('the pair command, on a typo', () => {
  /** `--emali alice@acme.dev` used to mint a code whose session carried no address, silently. */
  it('refuses an unknown flag rather than dropping it', async () => {
    const outcome = await runPair(['--subject', 'alice', '--emali', 'alice@acme.dev'], envWith(), sessions);

    assert.equal(outcome.ok, false);
    assert.ok(outcome.lines.join(' ').includes('--emali'), outcome.lines.join('\n'));
  });

  it('still accepts the three it knows', async () => {
    const outcome = await runPair(
      ['--subject', 'alice', '--name', 'Alice Martin', '--email', 'alice@acme.dev'],
      envWith(),
      sessions,
    );

    assert.ok(outcome.ok, outcome.lines.join('\n'));
  });
});
