import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { announceFirstReviewer } from './app.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { firstReviewerLines, readFirstReviewer } from './first-reviewer.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { PAIRING_TTL_SECONDS, createPairing, redeemPairing } from './session.ts';
import { beforePostgres } from './before-postgres.fixture.ts';

/** The pairing code of the first reviewer, in the log of a worker that starts (FRU-108). */

const SECRET = 'a-worker-secret-of-exactly-enough';
const directories: string[] = [];

afterEach(() => {
  closeSessionConnections();
  mock.restoreAll();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sessionsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-first-reviewer-'));
  directories.push(directory);

  return join(directory, 'sessions.db');
}

function envWith(extra: Partial<WorkerEnv> = {}): WorkerEnv {
  return beforePostgres({
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: 'https://staging.acme.test',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: sessionsPath(),
    FRUITBACK_FIRST_REVIEWER: 'Alice Martin',
    ...extra,
  });
}

/** The code or the link of the second line, as a person copies it from the log. */
const copied = (lines: readonly string[]) => (lines[1] ?? '').trim();

describe('the person the operator names', () => {
  it('is a name, or a name and an address, and the id of their notes comes from it', () => {
    assert.deepEqual(readFirstReviewer('Alice Martin'), { subject: 'alice-martin', name: 'Alice Martin' });
    assert.deepEqual(readFirstReviewer('  Élodie   Dupré '), { subject: 'elodie-dupre', name: 'Élodie Dupré' });
    assert.deepEqual(readFirstReviewer('Alice Martin <Alice@Acme.dev>'), {
      subject: 'alice@acme.dev',
      name: 'Alice Martin',
      email: 'alice@acme.dev',
    });
    assert.equal(readFirstReviewer('李雷')?.subject, 'first-reviewer');
  });

  it('is nobody for an empty value, an address alone, or a name too long', () => {
    for (const value of [undefined, '', '   ', '<alice@acme.dev>', 'Alice <not an address>', 'a'.repeat(81)]) {
      assert.equal(readFirstReviewer(value), undefined, String(value));
    }
  });
});

describe('a worker that starts with FRUITBACK_FIRST_REVIEWER (FRU-108)', () => {
  it('mints a code that pairs as the person named, on a store that holds no session', async () => {
    const store = createSqliteSessionStore(sessionsPath());
    const reviewer = readFirstReviewer('Alice Martin <alice@acme.dev>');
    assert.ok(reviewer !== undefined);

    const lines = await firstReviewerLines(store, reviewer, undefined);

    assert.match(lines[0] ?? '', /^no reviewer paired with this worker yet\. Pairing code for Alice Martin/);
    assert.match(lines.at(-1) ?? '', new RegExp(`^Valid for ${PAIRING_TTL_SECONDS / 60} minutes, and usable once\\.`));
    assert.match(lines.at(-1) ?? '', /Whoever reads this log can use it/);
    const redeemed = await redeemPairing(store, copied(lines), SECRET);
    assert.ok(redeemed.ok, 'the code in the log pairs nobody');
    const claims = JSON.parse(Buffer.from(redeemed.session.accessToken.split('.')[1] ?? '', 'base64url').toString());
    assert.deepEqual(
      { sub: claims.sub, name: claims.name, email: claims.email },
      { sub: 'alice@acme.dev', name: 'Alice Martin', email: 'alice@acme.dev' },
    );
  });

  it('writes a link to open when the worker knows its public address', async () => {
    const store = createSqliteSessionStore(sessionsPath());
    const reviewer = readFirstReviewer('Alice Martin');
    assert.ok(reviewer !== undefined);

    const lines = await firstReviewerLines(store, reviewer, 'https://feedback.acme.dev');

    assert.match(copied(lines), /^https:\/\/feedback\.acme\.dev\/pair#[0-9A-Z-]+$/);
    const redeemed = await redeemPairing(store, copied(lines).split('#')[1] ?? '', SECRET);
    assert.ok(redeemed.ok);
  });

  it('mints nothing on a store that already holds a session, live or ended', async () => {
    const store = createSqliteSessionStore(sessionsPath());
    const reviewer = readFirstReviewer('Alice Martin');
    assert.ok(reviewer !== undefined);
    const { code } = await createPairing(store, { subject: 'bob' });
    const paired = await redeemPairing(store, code, SECRET);
    assert.ok(paired.ok);

    assert.deepEqual(await firstReviewerLines(store, reviewer, undefined), []);

    await store.endSessionsOf({ subject: 'bob' }, Date.now());
    assert.deepEqual(await firstReviewerLines(store, reviewer, undefined), []);
  });

  it('mints another code at the next start while nobody paired, and the code of before still expires', async () => {
    const store = createSqliteSessionStore(sessionsPath());
    const reviewer = readFirstReviewer('Alice Martin');
    assert.ok(reviewer !== undefined);
    const at = Date.now();

    const first = copied(await firstReviewerLines(store, reviewer, undefined, at));
    const later = at + PAIRING_TTL_SECONDS * 1000 + 1;
    const second = copied(await firstReviewerLines(store, reviewer, undefined, later));

    assert.notEqual(second, first);
    assert.equal(
      (await redeemPairing(store, first, SECRET, later)).ok,
      false,
      'the first code outlived its ten minutes',
    );
    assert.ok((await redeemPairing(store, second, SECRET, later)).ok);
  });

  it('writes the lines in the log through the configuration, and nothing with no variable', async () => {
    const logged: string[] = [];
    const named = readConfig(envWith());
    assert.ok(named.ok, named.ok ? '' : named.missing.join(', '));

    await announceFirstReviewer(named.config, (line) => logged.push(line));
    assert.equal(logged.length, 4);

    const silent = readConfig(envWith({ FRUITBACK_FIRST_REVIEWER: '' }));
    assert.ok(silent.ok);
    const before = logged.length;
    await announceFirstReviewer(silent.config, (line) => logged.push(line));
    assert.equal(logged.length, before);
    // And the file of that worker holds no code: nothing was minted in silence.
    closeSessionConnections();
    assert.throws(() => readFileSync(silent.config.sessionPath as string), /ENOENT/);
  });

  it('does not stop a worker whose store cannot open, and writes no code', async () => {
    const config = readConfig(envWith({ FRUITBACK_SESSION_PATH: '/nowhere/that/exists/sessions.db' }));
    assert.ok(config.ok);
    const logged: string[] = [];
    const failed = mock.method(console, 'error', () => {});

    await announceFirstReviewer(config.config, (line) => logged.push(line));

    assert.deepEqual(logged, []);
    assert.equal(failed.mock.callCount(), 1);
    assert.match(String(failed.mock.calls[0]?.arguments[0]), /FRUITBACK_FIRST_REVIEWER was not minted/);
  });
});

describe('FRUITBACK_FIRST_REVIEWER, refused at boot when it would do nothing', () => {
  const missing = (env: WorkerEnv): string => {
    const config = readConfig(env);

    return config.ok ? '' : config.missing.join(', ');
  };

  it('needs sessions, a value that names somebody, and a worker with no workspace', () => {
    assert.equal(missing(envWith()), '');
    assert.match(
      missing(envWith({ FRUITBACK_SESSION_PATH: '' })),
      /FRUITBACK_SESSION_PATH \(FRUITBACK_FIRST_REVIEWER is set/,
    );
    assert.match(
      missing(envWith({ FRUITBACK_FIRST_REVIEWER: '<alice@acme.dev>' })),
      /FRUITBACK_FIRST_REVIEWER \(a name/,
    );
    assert.match(
      missing(
        envWith({
          FRUITBACK_CLIENTS: JSON.stringify({ acme: { origins: ['https://staging.acme.test'], workspace: 'acme' } }),
        }),
      ),
      /FRUITBACK_FIRST_REVIEWER \(it names no workspace/,
    );
  });
});
