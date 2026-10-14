import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { envWith } from './auth-worker.fixture.ts';
import { REFUSED_SINCE_POSTGRES, readConfig, type WorkerEnv } from './env.ts';
import { fakeLinearDeprecationNotice, fakeLinearIgnoredReason, storeProviderFor } from './store-config.ts';

/**
 * `FRUITBACK_STORE` as an operator writes it: in a `.env` file or a compose file, where a value can
 * carry a space, and where a variable can be set to nothing (FRU-190).
 *
 * `stores.test.ts` holds what each store needs and the flag of before. This file holds the reading
 * of the variable itself. No test gave it a space before: the mutant that reads it as it is passed
 * every test, in each of the three functions that read it, and a mutation run counted the one of
 * `storeProviderFor` killed only when it ran out of time.
 */

/** A worker with its database and its console (FRU-225), and nothing said of its store. */
const deployed: WorkerEnv = { ...envWith(), FRUITBACK_STORE: undefined, ALLOWED_ORIGINS: 'https://acme.test' };

const linearEnv: WorkerEnv = { ...deployed, LINEAR_API_KEY: 'lin_api_key', LINEAR_TEAM_ID: 'team_1' };

/** The flag of before, alone. */
const sugar: WorkerEnv = { ALLOWED_ORIGINS: 'https://acme.test', FRUITBACK_FAKE_LINEAR: '1' };

function providerOf(env: WorkerEnv): string {
  const result = readConfig(env);
  assert.ok(result.ok, `expected a valid config, missing: ${result.ok ? '' : result.missing.join(', ')}`);

  return result.config.store.provider;
}

describe('FRUITBACK_STORE, as an operator writes it', () => {
  it('names the store without the spaces around it', () => {
    assert.equal(storeProviderFor({ FRUITBACK_STORE: ' memory ' }), 'memory');
    assert.equal(storeProviderFor({ FRUITBACK_STORE: '\tsqlite\n' }), 'sqlite');
    assert.equal(providerOf({ ...deployed, FRUITBACK_STORE: ' memory ' }), 'memory');
  });

  it('is not set when it holds only spaces', () => {
    // The default, `postgres` since FRU-225.
    assert.equal(storeProviderFor({ FRUITBACK_STORE: '   ' }), 'postgres');
    assert.equal(storeProviderFor({ FRUITBACK_STORE: '' }), 'postgres');
    assert.equal(storeProviderFor({}), 'postgres');
    // The flag of before still decides then, as with no variable at all.
    assert.equal(storeProviderFor({ FRUITBACK_STORE: '   ', FRUITBACK_FAKE_LINEAR: '1' }), 'memory');
    // A blank store beside the key of Linear is refused, and not moved to the default (FRU-225).
    assert.equal(providerOf({ ...deployed, FRUITBACK_STORE: '   ' }), 'postgres');
    const blank = readConfig({ ...linearEnv, FRUITBACK_STORE: '   ' });
    assert.deepEqual(blank.ok ? [] : blank.missing, [REFUSED_SINCE_POSTGRES.unnamedStore]);
  });

  it('is named without its spaces in what the boot says about the flag of before', () => {
    // The whole line, to its end: the name is trimmed, and nothing follows it.
    assert.equal(
      fakeLinearIgnoredReason({ ...sugar, FRUITBACK_STORE: ' linear ' }),
      'FRUITBACK_STORE=linear was set explicitly',
    );
    assert.equal(
      fakeLinearDeprecationNotice({ ...sugar, FRUITBACK_STORE: ' memory ' }),
      'FRUITBACK_STORE=memory is set explicitly, so the flag changed nothing and the line can go',
    );
  });

  it('decides nothing in what the boot says, when it holds only spaces', () => {
    // Production decided, or the flag did.
    assert.equal(
      fakeLinearIgnoredReason({ ...sugar, FRUITBACK_STORE: '   ', NODE_ENV: 'production' }),
      'this process runs with NODE_ENV=production',
    );
    for (const empty of ['   ', '']) {
      assert.equal(
        fakeLinearDeprecationNotice({ ...sugar, FRUITBACK_STORE: empty }),
        'it is what selected the in-memory store here. Set FRUITBACK_STORE=memory instead',
      );
    }
  });
});
