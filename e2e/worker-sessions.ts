import os from 'node:os';
import path from 'node:path';

/**
 * The worker holds extension sessions during the suite, so the team-mode spec can pair (SKG-538).
 *
 * The server and the `pair` command must read the same file and the same key. The key is a test
 * value, and the worker refuses one shorter than 32 characters.
 */
/** The worker the team-mode spec pairs with. It refuses a read with no identity. */
export const AUTHENTICATED_WORKER_ORIGIN = 'http://localhost:8789';

export const WORKER_SESSION_ENV = {
  FRUITBACK_SESSION_PATH: path.join(os.tmpdir(), 'fruitback-e2e-sessions.sqlite'),
  FRUITBACK_IDENTITY_SECRET: 'e2e-only-identity-secret-never-deployed',
};
