import { pairingLink } from './pair-page.ts';
import { PAIRING_TTL_SECONDS, type SessionStore, createPairing } from './session.ts';

/**
 * The link of the first reviewer, written in the log when the worker starts (FRU-108).
 *
 * A self-hosted worker pairs its first reviewer with `docker compose exec worker node server.mjs
 * pair …`. With `FRUITBACK_FIRST_REVIEWER` the operator names that person in the environment, and a
 * worker that holds no session yet mints a code for them when it starts.
 *
 * - **The operator names the person, and a browser never does.** No variable, nothing minted.
 * - **Only while nobody paired.** A store that holds a session, live or ended, mints nothing: the
 *   variable left in the environment after the first day opens nothing.
 * - **A code like any other**: the same lifetime, usable once, kept as a digest. A worker that starts
 *   again with no session mints another one.
 * - **WARNING: the code is in the log, in the clear.** Whoever reads the log of the container in its
 *   ten minutes pairs as that person, and a log that is shipped elsewhere keeps the line. It is the
 *   reason the variable is not on by default, and `SECURITY.md` says it.
 */

export type FirstReviewer = { subject: string; name: string; email?: string };

/**
 * `Alice Martin`, or `Alice Martin <alice@acme.dev>`: the person as the operator names them, or
 * `undefined` for a value that names nobody. `subject` is what lands in `reporter.id` of their notes:
 * the address when there is one, the name in lower case with hyphens when there is none.
 */
export function readFirstReviewer(value: string | undefined): FirstReviewer | undefined {
  const typed = value?.replace(/\s+/g, ' ').trim() ?? '';
  const match = /^([^<>]+?)(?: <([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>)?$/.exec(typed);
  const name = match?.[1]?.trim();
  if (match === null || name === undefined || name === '' || name.length > 80) return undefined;
  const email = match[2]?.toLowerCase();
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    // The accents go, and their letters stay: « Élodie » is `elodie`.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return { subject: email ?? (slug === '' ? 'first-reviewer' : slug), name, ...(email === undefined ? {} : { email }) };
}

/**
 * The lines to write in the log, or none when there is nothing to mint. `publicUrl` is the address a
 * reviewer reaches this worker at: the container does not know it, so with none the code is written
 * alone, to type in the extension.
 */
export async function firstReviewerLines(
  store: SessionStore,
  reviewer: FirstReviewer,
  publicUrl: string | undefined,
  now: number = Date.now(),
): Promise<string[]> {
  if (await store.holdsSession()) return [];
  // The codes that expired go first, as a redemption does: the file of a worker that starts every
  // day with nobody pairing must not grow.
  await store.purge(now);
  const { code } = await createPairing(
    store,
    {
      subject: reviewer.subject,
      name: reviewer.name,
      ...(reviewer.email === undefined ? {} : { email: reviewer.email }),
    },
    now,
  );
  const minutes = Math.round(PAIRING_TTL_SECONDS / 60);

  return [
    `no reviewer paired with this worker yet. Pairing ${publicUrl === undefined ? 'code' : 'link'} for ${reviewer.name} (FRUITBACK_FIRST_REVIEWER):`,
    `    ${publicUrl === undefined ? code : pairingLink(publicUrl, code)}`,
    ...(publicUrl === undefined
      ? [
          'Type it in the Fruitback extension, with the address of this worker. Set FRUITBACK_PUBLIC_URL to get a link to open.',
        ]
      : [`${reviewer.name} opens it, then clicks the Fruitback icon.`]),
    `Valid for ${minutes} minutes, and usable once. Whoever reads this log can use it: start the worker again for another one.`,
  ];
}
