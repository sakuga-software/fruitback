import { WITHOUT_DATABASE, type WorkerEnv } from './env.ts';

/**
 * The environment of a worker of before FRU-225, for the tests of its code: no database, the sites in
 * `FRUITBACK_CLIENTS` or one client, the sessions in `FRUITBACK_SESSION_PATH`, the notes in Linear by
 * default. `readConfig` refuses all of it for any environment a process can be given; see
 * `WITHOUT_DATABASE`. It goes with that code (FRU-226).
 */
export function beforePostgres(env: WorkerEnv): WorkerEnv {
  // The default store of before. A test that names a store, or the flag of before, keeps it.
  const store =
    env.FRUITBACK_STORE === undefined && env.FRUITBACK_FAKE_LINEAR === undefined ? { FRUITBACK_STORE: 'linear' } : {};

  return { ...store, ...env, [WITHOUT_DATABASE]: true };
}
