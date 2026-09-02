import { z } from 'zod';
import type { SeedStore } from './store.ts';

/**
 * Which store this process runs on, and who validates its configuration (SKG-526).
 *
 * SKG-522 named the `SeedStore` interface but left the worker Linear-shaped anyway: `WorkerConfig`
 * carried `linearApiKey`, `linearTeamId` and `linearProjectId`, so every module that could read the
 * config could read one provider's credentials. `readConfig` also validated those three fields for
 * every deployment, including the ones that will not have them — a SQLite worker (SKG-524) would
 * have been refused at boot for a missing Linear key.
 *
 * So the provider is selected by `FRUITBACK_STORE`, and **each provider validates its own
 * environment**. What the worker keeps is a name and a way to build one; the fields stay inside the
 * connector that understands them.
 *
 * The other half of the ticket is that a store must still be able to say what an operator forgot.
 * `readFrom` answers with the **environment variable names** — `LINEAR_API_KEY`, not `apiKey` — so
 * the `/health` diagnostic keeps naming what someone would actually go and set.
 */

/**
 * The environment, as a plain map.
 *
 * Deliberately not `WorkerEnv`: `env.ts` imports this module, so a connector declaring its spec
 * cannot import the worker's env type back without a cycle. A store reads variables; it does not
 * need to know which other ones exist.
 */
export type StoreEnv = Record<string, string | undefined>;

/**
 * What the worker keeps once a provider's own configuration has been validated: its name, and a way
 * to build one.
 *
 * A factory rather than the validated options, because the options are the provider's business and
 * this is the value that travels in `WorkerConfig`. It is called **once per process** by the
 * transport — see `RequestContext.store`.
 */
export type StoreConfig = { readonly provider: string; create(): SeedStore };

export type StoreConfigResult = { ok: true; config: StoreConfig } | { ok: false; missing: string[] };

export type StoreSpec = {
  readonly provider: string;
  /**
   * Refused when `NODE_ENV=production`, which the Dockerfile sets. Only the in-memory store is
   * dev-only today, and it must stay impossible to deploy: a `200 ok` from a worker quietly keeping
   * a client's feedback in RAM until the next restart is the worst kind of green check.
   */
  readonly devOnly: boolean;
  /** Read and validate this provider's own environment. */
  readFrom(env: StoreEnv): StoreConfigResult;
};

/**
 * Declare a provider: what it reads, what shape that has to be, and how to build a store from it.
 *
 * The generic is erased here rather than at the registry, which is what keeps `STORE_SPECS`
 * heterogeneous without a cast anywhere: `create` only ever sees options this spec's own schema has
 * already accepted.
 */
export function defineStore<TOptions>(spec: {
  provider: string;
  devOnly?: boolean;
  /**
   * Field name to environment variable, for every field. A missing one is reported by the name an
   * operator writes in their `.env`, so requiring the whole map is what keeps a new field from
   * surfacing as `apiKey` in a boot diagnostic.
   */
  envNames: Record<keyof TOptions & string, string>;
  read(env: StoreEnv): Record<string, unknown>;
  schema: z.ZodType<TOptions>;
  create(options: TOptions): SeedStore;
}): StoreSpec {
  return {
    provider: spec.provider,
    devOnly: spec.devOnly ?? false,
    readFrom(env) {
      const result = spec.schema.safeParse(spec.read(env));

      if (!result.success) {
        const names = result.error.issues.map((issue) => {
          const field = String(issue.path[0]);

          // The field name is the fallback rather than the answer: it means `envNames` is missing an
          // entry, which is a defect here and not a misconfiguration out there.
          return spec.envNames[field as keyof TOptions & string] ?? field;
        });

        return { ok: false, missing: [...new Set(names)] };
      }

      const options = result.data;

      return { ok: true, config: { provider: spec.provider, create: () => spec.create(options) } };
    },
  };
}

/** What `FRUITBACK_STORE` selects when it is not set: what every deployment ran before SKG-526. */
export const DEFAULT_STORE_PROVIDER = 'linear';

/**
 * Read `FRUITBACK_STORE`, including the compatibility shim for the flag it replaces.
 *
 * `FRUITBACK_FAKE_LINEAR=1` still selects the in-memory store: it is in `apps/worker/package.json`,
 * in the CI workflow, and in the muscle memory of anyone who has run this loop. It is sugar, and it
 * loses to an explicit `FRUITBACK_STORE` — which also happens to fail towards the safe side, since
 * the dangerous direction is the in-memory store winning somewhere it was not asked for.
 */
export function storeProviderFor(env: StoreEnv): string {
  const explicit = env.FRUITBACK_STORE?.trim();

  if (explicit !== undefined && explicit !== '') return explicit;

  // The production guard is applied to the sugar **here**, so the flag *degrades* to the real store
  // rather than refusing to boot. An explicit `FRUITBACK_STORE=memory` gets no such treatment — see
  // `readStoreConfig`, and `fakeLinearIgnoredReason` for why the two differ.
  return asksForFakeLinear(env) && env.NODE_ENV !== 'production' ? MEMORY_PROVIDER : DEFAULT_STORE_PROVIDER;
}

/** Not exported: `stores.ts` finds the in-memory store by asking the registry, not by its name. */
const MEMORY_PROVIDER = 'memory';

/** Whether the deprecated flag was set at all — the production guard is applied separately. */
function asksForFakeLinear(env: StoreEnv): boolean {
  return env.FRUITBACK_FAKE_LINEAR === '1' || env.FRUITBACK_FAKE_LINEAR?.toLowerCase() === 'true';
}

/**
 * Why `FRUITBACK_FAKE_LINEAR` got this process nowhere, or `undefined` when it did not.
 *
 * The flag is **ignored** rather than refused, and that asymmetry with `FRUITBACK_STORE=memory` is
 * deliberate. A flag inherited by a container that was meant to serve production must not stop it
 * serving; a provider someone deliberately named must not be silently swapped for another. So the
 * sugar degrades, loudly, and the explicit selection is refused at boot.
 *
 * It returns the reason rather than a boolean because there are **two** ways to lose: the flag can
 * lose to `NODE_ENV=production`, and it can lose to an explicit `FRUITBACK_STORE`. A boot log that
 * names only the first misleads exactly the operator who is reading it to find out why their store
 * is not the one they asked for.
 */
export function fakeLinearIgnoredReason(env: StoreEnv): string | undefined {
  if (!asksForFakeLinear(env) || storeProviderFor(env) === MEMORY_PROVIDER) return undefined;

  const explicit = env.FRUITBACK_STORE?.trim();

  // Explicit first: when both are set it is the one that decided, and production is beside the point.
  return explicit !== undefined && explicit !== ''
    ? `FRUITBACK_STORE=${explicit} was set explicitly`
    : 'this process runs with NODE_ENV=production';
}
