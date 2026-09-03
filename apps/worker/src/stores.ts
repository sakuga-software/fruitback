import { createMemoryStoreSpec } from './linear-memory.ts';
import { createLinearStoreSpec } from './linear.ts';
import { createSqliteStoreSpec } from './sqlite.ts';
import { type StoreConfigResult, type StoreEnv, type StoreSpec, storeProviderFor } from './store-config.ts';

/**
 * Every store this worker can run on (SKG-526).
 *
 * A separate module from `store-config.ts` because the connectors import `defineStore` from there:
 * holding the registry in the same file would make `store-config.ts` and `linear.ts` import each
 * other. SQLite (SKG-524) and GitHub (SKG-525) are one entry each.
 */
export const STORE_SPECS: readonly StoreSpec[] = [
  createLinearStoreSpec(),
  createSqliteStoreSpec(),
  createMemoryStoreSpec(),
];

function specFor(provider: string): StoreSpec | undefined {
  return STORE_SPECS.find((spec) => spec.provider === provider);
}

/** The providers an operator may name, for the diagnostic that tells them they misspelt one. */
export function storeProviders(): string[] {
  return STORE_SPECS.map((spec) => spec.provider);
}

/** Whether the selected provider must never run in production — see `StoreSpec.devOnly`. */
export function isDevOnlyProvider(provider: string): boolean {
  return specFor(provider)?.devOnly === true;
}

/**
 * Select the provider and let it validate its own environment.
 *
 * Two refusals rather than a fallback, for the reason `FRUITBACK_READ` and `TRUSTED_PROXY_HOPS` are
 * also refused rather than defaulted:
 *
 * - **An unknown provider** is a typo, and defaulting to Linear would send a worker someone
 *   configured for SQLite to an API it has no key for — an opaque failure per request instead of one
 *   clear line at boot.
 * - **A dev-only provider under `NODE_ENV=production`** is refused outright, not downgraded. This is
 *   the guard `FRUITBACK_FAKE_LINEAR` has always had, and the one thing SKG-526 must not loosen:
 *   feedback accepted into RAM and lost on the next restart, behind a green health check, is worse
 *   than a worker that refuses to start. The deprecated flag is still *ignored* rather than refused
 *   — see `fakeLinearIgnoredReason` for why the two differ.
 */
export function readStoreConfig(env: StoreEnv): StoreConfigResult {
  const provider = storeProviderFor(env);
  const spec = specFor(provider);

  if (spec === undefined) {
    return {
      ok: false,
      missing: [`FRUITBACK_STORE (unknown store "${provider}", expected ${storeProviders().join(' | ')})`],
    };
  }

  if (spec.devOnly && env.NODE_ENV === 'production') {
    return { ok: false, missing: [`FRUITBACK_STORE ("${provider}" is dev-only and NODE_ENV is production)`] };
  }

  return spec.readFrom(env);
}
