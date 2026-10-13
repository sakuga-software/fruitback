/**
 * The second worker of the suite, for the team mode (FRU-45): its site is read by a session of the
 * workspace only, so a pin read back proves that the relay carried the session.
 *
 * Each worker of the suite is `dev-worker.fixture.ts`: a database in its process (FRU-223), with one
 * workspace and the site `playground`. A spec pairs with `mintPairing` of `extension.ts`.
 */
export const AUTHENTICATED_WORKER_ORIGIN = 'http://localhost:8789';
