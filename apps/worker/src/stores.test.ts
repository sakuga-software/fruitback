import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfig, type WorkerEnv } from './env.ts';
import { STORE_SPECS, isDevOnlyProvider, readStoreConfig, storeProviders } from './stores.ts';
import { fakeLinearDeprecationNotice, fakeLinearIgnoredReason } from './store-config.ts';

/**
 * `FRUITBACK_STORE` selects the connector, and each connector validates its own environment
 * (SKG-526).
 *
 * These drive `readConfig` rather than `handleRequest`, because what changed is what a worker will
 * agree to boot with. `/health` reporting the store's name is asserted in `app.test.ts`, where the
 * rest of that endpoint's contract lives.
 */

const origins = { ALLOWED_ORIGINS: 'https://acme.test' };

/** A Linear worker with everything it needs — the shape every deployment had before this ticket. */
const linearEnv: WorkerEnv = {
  ALLOWED_ORIGINS: 'https://acme.test',
  LINEAR_API_KEY: 'lin_api_key',
  LINEAR_TEAM_ID: 'team_1',
};

function missingOf(env: WorkerEnv): string[] {
  const result = readConfig(env);

  return result.ok ? [] : result.missing;
}

function providerOf(env: WorkerEnv): string {
  const result = readConfig(env);
  assert.ok(result.ok, `expected a valid config, missing: ${result.ok ? '' : result.missing.join(', ')}`);

  return result.config.store.provider;
}

describe('selecting the store', () => {
  it('runs on Linear when nothing says otherwise', () => {
    // The default is compatibility, not preference: every worker deployed before SKG-526 sets none
    // of these variables and must keep booting onto exactly the store it had.
    assert.equal(providerOf(linearEnv), 'linear');
  });

  it('runs on the named store', () => {
    assert.equal(providerOf({ ALLOWED_ORIGINS: 'https://acme.test', FRUITBACK_STORE: 'memory' }), 'memory');
  });

  it('refuses a store it does not have, rather than falling back to the default', () => {
    // A typo must not send a worker configured for SQLite to an API it has no key for. That would be
    // an opaque failure on every request instead of one line at boot — the same reasoning as
    // FRUITBACK_READ and TRUSTED_PROXY_HOPS.
    // `postgres` and not `sqlite`: this test named a store that has since been built (SKG-524), and
    // an example that can stop being an example is how a guard quietly starts testing nothing.
    const missing = missingOf({ ...linearEnv, FRUITBACK_STORE: 'postgres' });

    assert.equal(missing.length, 1);
    assert.match(missing[0] ?? '', /^FRUITBACK_STORE \(unknown store "postgres"/);
    // Named, so an operator can see what they could have written instead of guessing. Asked of the
    // registry rather than spelled out, so adding a provider does not have to be remembered here.
    for (const provider of storeProviders()) assert.match(missing[0] ?? '', new RegExp(provider));
  });

  it('asks only the selected store for its configuration', () => {
    // The point of the ticket. Before it, `readConfig` validated LINEAR_API_KEY and LINEAR_TEAM_ID
    // for every deployment, and the dev loop was handed stand-in credentials to satisfy them — which
    // is why a SQLite worker (SKG-524) would have been refused at boot for a missing Linear key.
    const result = readConfig({ ALLOWED_ORIGINS: 'https://acme.test', FRUITBACK_STORE: 'memory' });

    assert.ok(result.ok, `expected no Linear credentials to be required, missing: ${result.ok ? '' : result.missing}`);
  });

  it('names the environment variable an operator forgot, not the field inside the connector', () => {
    // `apiKey` is what the schema calls it and nobody can act on that. The whole reason `envNames`
    // is required per field is that this diagnostic used to come from the worker's own config, and
    // moving the fields into the connector is exactly where the names could have been lost.
    const missing = missingOf({ ALLOWED_ORIGINS: 'https://acme.test' });

    assert.deepEqual(missing, ['LINEAR_API_KEY', 'LINEAR_TEAM_ID']);
  });

  it('never reports a field name from any store', () => {
    // Asked of every spec rather than of Linear, so a provider added later cannot answer a boot
    // failure with `apiKey`. `checked` is what stops an empty registry from passing for free.
    let checked = 0;

    for (const spec of STORE_SPECS) {
      const result = spec.readFrom({});
      if (result.ok) continue;

      for (const name of result.missing) {
        checked += 1;
        assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${spec.provider} reported ${name}, which is not a variable name`);
      }
    }

    assert.ok(checked > 0, 'no store reported anything missing — this assertion checked nothing');
  });

  it('lists the providers it can build', () => {
    assert.deepEqual(storeProviders(), ['linear', 'sqlite', 'memory']);
  });
});

describe('a dev-only store cannot be deployed', () => {
  it('refuses the in-memory store under NODE_ENV=production', () => {
    // The Dockerfile sets NODE_ENV=production. Feedback accepted into RAM and lost on the next
    // restart, behind a green health check, is worse than a worker that refuses to start — and this
    // guard is the one thing SKG-526 must not loosen while generalising the flag it came from.
    const missing = missingOf({ ...linearEnv, FRUITBACK_STORE: 'memory', NODE_ENV: 'production' });

    assert.equal(missing.length, 1);
    assert.match(missing[0] ?? '', /^FRUITBACK_STORE \("memory" is dev-only/);
  });

  it('refuses it even when the Linear credentials would have worked', () => {
    // Refused, not quietly swapped for the store that happens to be configured. `linearEnv` is
    // complete here, so a fallback would boot a green worker on a provider nobody asked for.
    const result = readConfig({ ...linearEnv, FRUITBACK_STORE: 'memory', NODE_ENV: 'production' });

    assert.equal(result.ok, false);
  });

  it('says which stores are dev-only, for the boot warning', () => {
    assert.equal(isDevOnlyProvider('memory'), true);
    assert.equal(isDevOnlyProvider('linear'), false);
    // An unknown provider never gets that far, and must not read as dev-only on the way.
    assert.equal(isDevOnlyProvider('sqlite'), false);
  });
});

describe('FRUITBACK_FAKE_LINEAR, the spelling this replaces', () => {
  const sugar: WorkerEnv = { ALLOWED_ORIGINS: 'https://acme.test', FRUITBACK_FAKE_LINEAR: '1' };

  it('still selects the in-memory store', () => {
    // It is in the `.env` files and compose stacks of everyone who ran this loop before the rename —
    // not in anything here: `dev:fake`, `serve:fake` and the E2E suite all moved to
    // FRUITBACK_STORE=memory. Breaking it would have been a gratuitous cost. This comment named the
    // package manifest and the CI workflow for three tickets after SKG-526 emptied both.
    assert.equal(providerOf(sugar), 'memory');
    assert.equal(providerOf({ ...sugar, FRUITBACK_FAKE_LINEAR: 'true' }), 'memory');
  });

  it('degrades to the real store in production rather than refusing to boot', () => {
    // The asymmetry with FRUITBACK_STORE=memory is deliberate, and this is the assertion that pins
    // it: a flag *inherited* by a container meant to serve production must not stop it serving. A
    // provider someone deliberately named is refused instead.
    assert.equal(providerOf({ ...linearEnv, FRUITBACK_FAKE_LINEAR: '1', NODE_ENV: 'production' }), 'linear');
  });

  it('loses to an explicit FRUITBACK_STORE', () => {
    // Explicit beats sugar, and it also fails towards the safe side: the dangerous direction is the
    // in-memory store winning somewhere nobody asked for it.
    assert.equal(providerOf({ ...linearEnv, FRUITBACK_STORE: 'linear', FRUITBACK_FAKE_LINEAR: '1' }), 'linear');
  });

  /**
   * The half SKG-526 asked for and did not ship, and the reason it matters is the asymmetry: the
   * shipped warning fires only when the flag **loses**, which is every operator with nothing to
   * migrate. The one still relying on it heard nothing at all.
   */
  it('says so when the flag is what selected the memory store', () => {
    assert.match(fakeLinearDeprecationNotice(sugar) ?? '', /FRUITBACK_STORE=memory/);
    // And never when it lost: the other half owns those, and two lines about one flag read as two
    // problems.
    assert.equal(fakeLinearDeprecationNotice({ ...sugar, NODE_ENV: 'production' }), undefined);
    assert.equal(fakeLinearDeprecationNotice({ ...sugar, FRUITBACK_STORE: 'linear' }), undefined);
    assert.equal(fakeLinearDeprecationNotice(linearEnv), undefined);
  });

  /**
   * The state that was silent on **both** halves: the flag is set, the explicit variable selects the
   * same store, so nothing was ignored and nothing was decided. It is a stale line in somebody's
   * env, and saying so is the whole point of a deprecation notice.
   */
  it('says the flag changed nothing when the store was already named explicitly', () => {
    const migrated = { ...sugar, FRUITBACK_STORE: 'memory' };

    assert.equal(fakeLinearIgnoredReason(migrated), undefined);
    assert.match(fakeLinearDeprecationNotice(migrated) ?? '', /changed nothing/);
  });

  /**
   * **And claims nothing about the store surviving**, because it does not always. Under
   * `NODE_ENV=production` that explicit `memory` is refused by `readStoreConfig`, so a notice saying
   * it "already selects that store" printed one line above a boot failure saying the opposite. What
   * the flag did is all this line is entitled to say. Raised in review.
   */
  it('does not claim the explicit store is in use, because it can be refused', () => {
    const refused = { ...sugar, FRUITBACK_STORE: 'memory', NODE_ENV: 'production' };
    const notice = fakeLinearDeprecationNotice(refused) ?? '';

    assert.match(notice, /changed nothing/);
    assert.doesNotMatch(notice, /selects that store|in use|is running/);
    // The boot failure is what says the store is refused, and it names the variable to fix.
    assert.partialDeepStrictEqual(readConfig(refused as WorkerEnv), { ok: false });
  });

  /** Neither half may stay quiet while the flag is set, and both speaking at once is the other bug. */
  it('says exactly one thing about the flag, whatever the environment', () => {
    const environments = [
      sugar,
      { ...sugar, NODE_ENV: 'production' },
      { ...sugar, FRUITBACK_STORE: 'linear' },
      { ...sugar, FRUITBACK_STORE: 'memory' },
      { ...sugar, FRUITBACK_STORE: 'linear', NODE_ENV: 'production' },
      // The store is selected and then refused as dev-only, which is the state the notice must not
      // describe as a working selection. Raised in review.
      { ...sugar, FRUITBACK_STORE: 'memory', NODE_ENV: 'production' },
      { ...sugar, FRUITBACK_FAKE_LINEAR: 'true' },
    ];

    for (const env of environments) {
      const spoken = [fakeLinearIgnoredReason(env), fakeLinearDeprecationNotice(env)].filter(
        (line) => line !== undefined,
      );
      assert.equal(spoken.length, 1, `${JSON.stringify(env)} produced ${spoken.length} lines: ${spoken.join(' | ')}`);
    }

    // And nothing at all when the flag is not set, whatever else is going on.
    assert.equal(fakeLinearIgnoredReason(linearEnv), undefined);
    assert.equal(fakeLinearDeprecationNotice({ ...linearEnv, FRUITBACK_STORE: 'memory' }), undefined);
  });

  /**
   * **The notice is worth nothing if nobody prints it**, and `server.ts` has no test of its own — it
   * opens a socket. So the boot line is asserted on the source, the way `embed.test.ts` asserts the
   * widget's transport: the notice's cases above would all stay green with the call deleted, and the
   * warning would reach nobody. Same defect as every other correct handler the real caller never
   * reaches.
   */
  it('is printed at boot by the file that has no test of its own', () => {
    const server = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');

    // One pattern, and the back-reference is the point: two independent regexes would pass a boot
    // that asks for this notice and then warns with `${flagIgnored}`. Raised in review.
    assert.match(
      server,
      /const (\w+) = fakeLinearDeprecationNotice\(env\);\s*if \(\1 !== undefined\) \{\s*console\.warn\(\s*`\[fruitback\] FRUITBACK_FAKE_LINEAR is deprecated: \$\{\1\}`/,
      'server.ts does not warn at boot with the notice it asked for',
    );
  });

  it('is reported as ignored whenever it got the process nowhere', () => {
    // Both ways of losing count, or an operator reads a worker on the wrong store as a worker that
    // ignored nothing.
    assert.notEqual(fakeLinearIgnoredReason({ ...sugar, NODE_ENV: 'production' }), undefined);
    assert.notEqual(fakeLinearIgnoredReason({ ...sugar, FRUITBACK_STORE: 'linear' }), undefined);
    assert.equal(fakeLinearIgnoredReason(sugar), undefined);
    assert.equal(fakeLinearIgnoredReason(linearEnv), undefined);
  });

  it('names the reason it lost, rather than asserting the one that is usually true', () => {
    // The boot log prints this verbatim. It claimed NODE_ENV=production unconditionally, which is
    // wrong — and misleading in exactly the situation someone reads the log to understand.
    assert.match(fakeLinearIgnoredReason({ ...sugar, NODE_ENV: 'production' }) ?? '', /NODE_ENV=production/);
    assert.match(fakeLinearIgnoredReason({ ...sugar, FRUITBACK_STORE: 'linear' }) ?? '', /FRUITBACK_STORE=linear/);
    // Both set: the explicit selection is what decided, and production is beside the point.
    const both = fakeLinearIgnoredReason({ ...sugar, FRUITBACK_STORE: 'linear', NODE_ENV: 'production' }) ?? '';
    assert.match(both, /FRUITBACK_STORE=linear/);
    assert.doesNotMatch(both, /NODE_ENV/);
  });
});

describe('the boot diagnostic', () => {
  /** Every way of making the config invalid, and the variable an operator would have to go and fix. */
  const BROKEN: ReadonlyArray<{ label: string; env: WorkerEnv; names: string }> = [
    { label: 'no origins', env: {}, names: 'ALLOWED_ORIGINS' },
    { label: 'no Linear key', env: { ALLOWED_ORIGINS: 'https://acme.test' }, names: 'LINEAR_API_KEY' },
    { label: 'unknown store', env: { ...linearEnv, FRUITBACK_STORE: 'postgres' }, names: 'FRUITBACK_STORE' },
    { label: 'sqlite with no path', env: { FRUITBACK_STORE: 'sqlite', ...origins }, names: 'FRUITBACK_SQLITE_PATH' },
    {
      label: 'dev-only store in production',
      env: { ...linearEnv, FRUITBACK_STORE: 'memory', NODE_ENV: 'production' },
      names: 'FRUITBACK_STORE',
    },
    { label: 'misspelt read', env: { ...linearEnv, FRUITBACK_READ: 'authenticaed' }, names: 'FRUITBACK_READ' },
    { label: 'non-numeric rate limit', env: { ...linearEnv, RATE_LIMIT_PER_MINUTE: 'lots' }, names: 'RATE_LIMIT' },
    { label: 'non-numeric proxy hops', env: { ...linearEnv, TRUSTED_PROXY_HOPS: 'one' }, names: 'TRUSTED_PROXY_HOPS' },
    { label: 'malformed client map', env: { ...linearEnv, FRUITBACK_CLIENTS: '{oops' }, names: 'FRUITBACK_CLIENTS' },
    // A short HMAC secret is a guessable one, so the schema refuses it — and until SKG-526 nothing
    // mapped that field to a name, so the answer was `missing:` followed by nothing at all.
    {
      label: 'identity secret under 32 characters',
      env: { ...linearEnv, FRUITBACK_IDENTITY_SECRET: 'too-short' },
      names: 'FRUITBACK_IDENTITY_SECRET',
    },
  ];

  it('answers no empty diagnostic', () => {
    // The failure this catches is silent by construction: an unnamed field fails the schema, the
    // name list comes back empty, and the operator reads `misconfigured, missing:` with nothing
    // after the colon. Asserted over every field that can fail rather than the one that did.
    for (const { label, env, names } of BROKEN) {
      const result = readConfig(env);

      assert.equal(result.ok, false, `${label} should not be a valid configuration`);
      assert.ok(!result.ok && result.missing.length > 0, `${label} refused the config but named nothing`);
      assert.ok(
        !result.ok && result.missing.some((name) => name.includes(names)),
        `${label} should name ${names}, got: ${result.ok ? '' : result.missing.join(', ')}`,
      );
    }
  });
});

describe('what the worker keeps of a store', () => {
  it('hands back a name and a way to build one, and nothing of the provider', () => {
    // `WorkerConfig` used to carry `linearApiKey`, `linearTeamId` and `linearProjectId`, so every
    // module that could read the config could read one connector's credentials. This asserts the
    // shape rather than the absence of three particular names, so the next provider's fields cannot
    // arrive here either.
    const result = readStoreConfig(linearEnv);
    assert.ok(result.ok);

    assert.deepEqual(Object.keys(result.config).sort(), ['create', 'provider']);
    assert.equal(result.config.provider, 'linear');
    assert.equal(result.config.create().name, 'linear');
  });

  it('builds a store per call, so the transport decides how many there are', () => {
    // `RequestContext.store` exists because a store may hold a resource — a SQLite connection is the
    // case that made it matter. This factory must not memoise that decision away from the caller.
    const result = readStoreConfig(linearEnv);
    assert.ok(result.ok);

    assert.notEqual(result.config.create(), result.config.create());
  });
});
