/**
 * The second worker of the suite, for the team mode (FRU-45): its site is read by a session of the
 * workspace only, so a pin read back proves that the relay carried the session.
 *
 * Each worker of the suite is `dev-worker.fixture.ts`: a database in its process (FRU-223), with one
 * workspace and the site `playground`. A spec pairs with `mintPairing` of `extension.ts`.
 */
export const AUTHENTICATED_WORKER_ORIGIN = 'http://localhost:8789';

/**
 * Who may leave a note on the site of this worker (FRU-330): `members` is the default of a new site,
 * and of this one. A spec about a site that takes notes from anybody says so here, and gives the
 * default back when it ends: the specs of one file run one after the other.
 */
export async function noteWriters(writers: 'members' | 'anyone'): Promise<void> {
  const answer = await fetch(`${AUTHENTICATED_WORKER_ORIGIN}/__dev/writers`, {
    method: 'POST',
    body: JSON.stringify({ writers }),
  });
  if (!answer.ok) throw new Error(`the worker of the suite did not set its writers: ${answer.status}`);
}
