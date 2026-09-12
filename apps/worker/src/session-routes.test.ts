import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WorkerEnv, readConfig } from './env.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { createPairing } from './session.ts';
import { handleRequest } from './app.ts';
import { verifyIdentityToken } from './identity.ts';
import { runPair } from './cli.ts';
import { sessionConnectionsOpened } from './session-sqlite.ts';

/** 32 characters, because `readConfig` refuses a shorter HMAC secret. */
const SECRET = 'a-worker-secret-of-exactly-enough';
const ALICE = { subject: 'alice', name: 'Alice Martin', email: 'alice@acme.dev' };

const directories: string[] = [];

function sessionPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-routes-'));
  directories.push(directory);

  return join(directory, 'sessions.db');
}

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: '*',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: sessionPath(),
    ...overrides,
  };
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
    { clientIp: ip },
  );
}

/** Mints a code straight against the same file the routes will use. */
async function codeFor(env: WorkerEnv): Promise<string> {
  const store = createSqliteSessionStore(env.FRUITBACK_SESSION_PATH as string);

  return (await createPairing(store, ALICE)).code;
}

afterEach(() => {
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('POST /session/pair', () => {
  it('answers a session the read path already knows how to verify', async () => {
    const env = envWith();
    const response = await call(env, '/session/pair', { code: await codeFor(env) });

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
    const paired = (await (await call(env, '/session/pair', { code: await codeFor(env) })).json()) as {
      refreshToken: string;
    };

    const response = await call(env, '/session/refresh', { refreshToken: paired.refreshToken });

    assert.equal(response.status, 200);
    const refreshed = (await response.json()) as { accessToken: string; identity: unknown };
    assert.ok((await verifyIdentityToken(refreshed.accessToken, SECRET)).ok);
    assert.deepEqual(refreshed.identity, ALICE);
  });

  /** The refresh token is what the extension keeps for weeks. It must never come back in an answer. */
  it('does not hand the refresh token back', async () => {
    const env = envWith();
    const paired = (await (await call(env, '/session/pair', { code: await codeFor(env) })).json()) as {
      refreshToken: string;
    };

    const body = await (await call(env, '/session/refresh', { refreshToken: paired.refreshToken })).text();

    assert.equal(body.includes(paired.refreshToken), false);
  });

  it('refuses a token this worker never issued', async () => {
    const response = await call(envWith(), '/session/refresh', { refreshToken: 'invented' });

    assert.equal(response.status, 401);
  });
});

describe('POST /session/revoke', () => {
  it('ends the session on the worker, not only in the extension', async () => {
    const env = envWith();
    const paired = (await (await call(env, '/session/pair', { code: await codeFor(env) })).json()) as {
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

describe('a worker with no session store', () => {
  it('does not advertise that these routes exist', async () => {
    const env = { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' } satisfies WorkerEnv;

    assert.equal((await call(env, '/session/pair', { code: 'ZZZZ-ZZZZ-ZZZZ' })).status, 404);
    assert.equal((await call(env, '/session/refresh', { refreshToken: 'x' })).status, 404);
  });

  it('leaves /health exactly as it was', async () => {
    const env = { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' } satisfies WorkerEnv;
    const response = await handleRequest(new Request('https://worker.test/health'), env, { clientIp: '203.0.113.7' });

    assert.deepEqual(await response.json(), { ok: true, store: 'memory', openRead: 1 });
  });
});

describe('the boot guards', () => {
  it('refuses a session path with no key to sign an access token with', () => {
    const result = readConfig({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*', FRUITBACK_SESSION_PATH: '/tmp/s.db' });

    assert.equal(result.ok, false);
    assert.ok(
      result.ok === false && result.missing.some((name) => name.startsWith('FRUITBACK_IDENTITY_SECRET')),
      `expected the identity secret to be named, got ${result.ok === false ? result.missing.join(', ') : ''}`,
    );
  });

  /**
   * A session signs with the worker-wide key, and a mapped worker ignores it — each client brings
   * its own. Pairing would work, the reviewer would look logged in, and every read would answer 401.
   */
  it('refuses sessions on a worker that routes by client', () => {
    const result = readConfig({
      FRUITBACK_STORE: 'memory',
      ALLOWED_ORIGINS: '*',
      FRUITBACK_IDENTITY_SECRET: SECRET,
      FRUITBACK_SESSION_PATH: '/tmp/s.db',
      FRUITBACK_CLIENTS: '{"acme":{"teamId":"team_1","projectId":"proj_1","origins":["https://acme.test"]}}',
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.ok === false && result.missing.some((name) => name.startsWith('FRUITBACK_SESSION_PATH')),
      `expected the session path to be named, got ${result.ok === false ? result.missing.join(', ') : ''}`,
    );
  });
});

describe('the pair command', () => {
  it('mints a code the pair route then accepts', async () => {
    const env = envWith();
    const outcome = await runPair(['--subject', 'alice', '--name', 'Alice Martin'], env);

    assert.ok(outcome.ok, outcome.lines.join('\n'));
    const code = outcome.lines.find((line) => /^ {4}[0-9A-Z]{4}-/.test(line))?.trim();
    assert.ok(code !== undefined, `no code in:\n${outcome.lines.join('\n')}`);

    const response = await call(env, '/session/pair', { code });
    assert.equal(response.status, 200);

    const session = (await response.json()) as { identity: unknown };
    assert.deepEqual(session.identity, { subject: 'alice', name: 'Alice Martin' });
  });

  /**
   * A worker with no session path is a perfectly valid worker, so `readConfig` passes it — the
   * command is what cannot run. It has to name the variable rather than fail on the database file.
   */
  it('names the variable when this worker keeps no sessions', async () => {
    const outcome = await runPair(['--subject', 'alice'], { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' });

    assert.equal(outcome.ok, false);
    assert.ok(outcome.lines.join(' ').includes('FRUITBACK_SESSION_PATH'), outcome.lines.join('\n'));
  });

  it('reports a misconfigured worker rather than minting against it', async () => {
    const outcome = await runPair(['--subject', 'alice'], {
      FRUITBACK_STORE: 'memory',
      ALLOWED_ORIGINS: '*',
      FRUITBACK_SESSION_PATH: '/tmp/never-opened.db',
    });

    assert.equal(outcome.ok, false);
    // The boot guard: a session path with no key to sign with. Named, not discovered at runtime.
    assert.ok(outcome.lines.join(' ').includes('FRUITBACK_IDENTITY_SECRET'), outcome.lines.join('\n'));
  });

  it('requires a subject, because that is what lands in reporter.id', async () => {
    const outcome = await runPair(['--name', 'Alice Martin'], envWith());

    assert.equal(outcome.ok, false);
    assert.ok(outcome.lines.join(' ').includes('--subject'), outcome.lines.join('\n'));
  });

  /** `--name=Alice Martin` is the spelling that silently drops the surname, so it is refused. */
  it('refuses --flag=value rather than half-supporting it', async () => {
    const outcome = await runPair(['--subject=alice'], envWith());

    assert.equal(outcome.ok, false);
  });
});

describe('the rate limit', () => {
  /**
   * The reason `checkRateLimit` moved above the path dispatch (SKG-535).
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
      const response = await handleRequest(new Request('https://worker.test/health'), env, { clientIp: ip });
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
        body: JSON.stringify({ code: await codeFor(env) }),
        headers: { 'Content-Type': 'application/json', Origin: extension },
      }),
      env,
      { clientIp: '198.51.100.21' },
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
      { clientIp: '198.51.100.22' },
    );

    assert.equal(response.status, 204);
    assert.ok(response.headers.get('Access-Control-Allow-Headers')?.includes('Content-Type'));
  });

  /**
   * The allowlist still governs `/feedback`, and it governs **sites** (SKG-596).
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
        { clientIp: '198.51.100.23' },
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

describe('the session connection', () => {
  /**
   * `handleSession` builds a store per request wherever the transport did not hand one over, which
   * is production. Without the map that opens a database handle per call — the hazard SKG-522 was
   * written to prevent, and one nothing observable reports.
   *
   * The assertion is on the counter and not `connections.size`: the map is keyed by path, so a
   * `connect` that stopped reusing would overwrite the one entry and leave the size at one.
   */
  it('opens one handle however many requests arrive', async () => {
    const env = envWith();
    const before = sessionConnectionsOpened();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await call(env, '/session/refresh', { refreshToken: 'invented' }, 'POST', '198.51.100.25');
    }

    assert.equal(sessionConnectionsOpened() - before, 1);
  });
});

describe('a session store that cannot be opened', () => {
  /**
   * A volume nobody mounted, a read-only disk, a file that is not a database.
   *
   * Answered like the seed path's outage rather than as a bare `500`, so the extension can tell
   * "retry later" from "this request was wrong" — and so the answer carries the CORS headers it
   * needs to read it at all. Raised in review: the session connector threw a plain `Error`, which
   * `handleSession` had nothing to map. It raises `StoreError` now, like the seed connector.
   */
  it('answers 502 store-unavailable, with the headers the extension can read', async () => {
    // A path whose parent does not exist: `new DatabaseSync` cannot create the file.
    const env = envWith({ FRUITBACK_SESSION_PATH: '/nonexistent-directory-for-this-test/sessions.db' });
    const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

    const response = await handleRequest(
      new Request('https://worker.test/session/pair', {
        method: 'POST',
        body: JSON.stringify({ code: 'ZZZZ-ZZZZ-ZZZZ' }),
        headers: { 'Content-Type': 'application/json', Origin: extension },
      }),
      env,
      { clientIp: '198.51.100.31' },
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'store-unavailable' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), extension);
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
      { clientIp: '198.51.100.32' },
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
    const outcome = await runPair(['--subject', 'alice', '--emali', 'alice@acme.dev'], envWith());

    assert.equal(outcome.ok, false);
    assert.ok(outcome.lines.join(' ').includes('--emali'), outcome.lines.join('\n'));
  });

  it('still accepts the three it knows', async () => {
    const outcome = await runPair(
      ['--subject', 'alice', '--name', 'Alice Martin', '--email', 'alice@acme.dev'],
      envWith(),
    );

    assert.ok(outcome.ok, outcome.lines.join('\n'));
  });
});
