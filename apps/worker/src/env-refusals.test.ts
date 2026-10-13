import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUTH_SECRET } from './auth.fixture.ts';
import { IDENTITY_SECRET, envWith } from './auth-worker.fixture.ts';
import { ACCOUNTS_FILE_REFUSED, GITHUB_APP_REFUSED, type WorkerEnv, readConfig } from './env.ts';

/**
 * What `readConfig` refuses, and how it says it (FRU-217).
 */

function missing(env: WorkerEnv): string[] {
  const config = readConfig(env);

  return config.ok ? [] : config.missing;
}

const SECRETS_KEY = 'a-key-that-opens-the-connectors-0123456789';

describe('the two variables of before are refused with the rest, in one start (FRU-150, FRU-217)', () => {
  const BEFORE = { FRUITBACK_ACCOUNTS_PATH: '/data/accounts.db', FRUITBACK_GITHUB_OAUTH: 'one-app:a-secret' };

  it('says both, and what else is wrong, together', () => {
    assert.deepEqual(missing(envWith(BEFORE)), [ACCOUNTS_FILE_REFUSED, GITHUB_APP_REFUSED]);
    // An operator who upgrades with a secret that is too short reads the three at once.
    const three = missing(envWith({ ...BEFORE, FRUITBACK_IDENTITY_SECRET: 'too-short' }));
    assert.deepEqual(
      [...three].sort(),
      ['FRUITBACK_IDENTITY_SECRET', ACCOUNTS_FILE_REFUSED, GITHUB_APP_REFUSED].sort(),
    );
    // On a worker with no accounts too.
    assert.deepEqual(missing({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://a.test', ...BEFORE }), [
      ACCOUNTS_FILE_REFUSED,
      GITHUB_APP_REFUSED,
    ]);
  });

  it('says each one alone, and nothing for an empty value', () => {
    assert.deepEqual(missing(envWith({ FRUITBACK_ACCOUNTS_PATH: '/data/accounts.db' })), [ACCOUNTS_FILE_REFUSED]);
    assert.deepEqual(missing(envWith({ FRUITBACK_GITHUB_OAUTH: 'one-app:a-secret' })), [GITHUB_APP_REFUSED]);
    assert.deepEqual(missing(envWith({ FRUITBACK_ACCOUNTS_PATH: '', FRUITBACK_GITHUB_OAUTH: '' })), []);
  });
});

describe('a secret is not white space, and white space does not tell two secrets apart (FRU-217)', () => {
  const NAMES = ['FRUITBACK_IDENTITY_SECRET', 'FRUITBACK_SECRETS_KEY', 'FRUITBACK_AUTH_SECRET'] as const;
  const GOOD: Record<(typeof NAMES)[number], string> = {
    FRUITBACK_IDENTITY_SECRET: IDENTITY_SECRET,
    FRUITBACK_SECRETS_KEY: SECRETS_KEY,
    FRUITBACK_AUTH_SECRET: AUTH_SECRET,
  };
  const all = (overrides: Partial<WorkerEnv> = {}): WorkerEnv => envWith({ ...GOOD, ...overrides });

  it('starts with the three secrets these cases change', () => {
    assert.deepEqual(missing(all()), []);
  });

  for (const name of NAMES) {
    it(`refuses ${name} made of spaces, or with white space around it, and never quotes it`, () => {
      for (const [why, value] of [
        ['32 spaces', ' '.repeat(32)],
        ['40 tabs', '\t'.repeat(40)],
        ['a space after it', `${GOOD[name]} `],
        ['a space before it', ` ${GOOD[name]}`],
        ['the end of a line after it', `${GOOD[name]}\n`],
      ] as const) {
        const said = missing(all({ [name]: value }));
        assert.equal(said.length, 1, why);
        assert.match(said[0] ?? '', new RegExp(`^${name} \\(no white space at its start or at its end`), why);
        assert.equal((said[0] ?? '').includes(GOOD[name]), false, why);
      }
    });
  }

  it('reads two secrets that differ by white space only as one secret', () => {
    const spaced = (value: string): string => `${value.slice(0, 5)} ${value.slice(5)}`;

    // The secret of the cookie, against each of the two others.
    assert.match(
      missing(all({ FRUITBACK_AUTH_SECRET: spaced(IDENTITY_SECRET) })).join(),
      /^FRUITBACK_AUTH_SECRET \(it must differ from FRUITBACK_IDENTITY_SECRET and from FRUITBACK_SECRETS_KEY\)$/,
    );
    assert.match(
      missing(all({ FRUITBACK_AUTH_SECRET: spaced(SECRETS_KEY) })).join(),
      /^FRUITBACK_AUTH_SECRET \(it must differ/,
    );
    // The key of the connectors, against the secret of the identities.
    assert.match(
      missing(all({ FRUITBACK_SECRETS_KEY: spaced(IDENTITY_SECRET) })).join(),
      /^FRUITBACK_SECRETS_KEY \(it must differ from FRUITBACK_IDENTITY_SECRET\)$/,
    );
    // The control: a space inside a secret is not refused by itself.
    assert.deepEqual(missing(all({ FRUITBACK_AUTH_SECRET: spaced(AUTH_SECRET) })), []);
  });
});
