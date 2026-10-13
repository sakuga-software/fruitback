import { normalizeEmail } from './accounts.ts';
import { type Auth, MAGIC_LINK_TTL_SECONDS, sendLinkThrough } from './auth.ts';
import type { Kv } from './kv.ts';

/**
 * The sign-in link of the first administrator, with no e-mail and no provider (FRU-221).
 *
 * A console signs a person in by a link sent by e-mail, or with GitHub or Google. An instance that
 * has none of the three could make no account at all. Mathieu, 2026-10-13: an account is always
 * possible for whoever administers. Whoever runs the instance gets the link another way:
 *
 * - **in the log**, when the worker starts, with `FRUITBACK_FIRST_ADMIN=<address>`, as the pairing
 *   link of the first reviewer (FRU-108);
 * - **by a command**, `node server.mjs admin-link --email <address>`, for whoever wants nothing in a
 *   log that is shipped elsewhere.
 *
 * It is the link of the e-mail: better-auth makes its token, keeps it as a digest, and spends it
 * once. The person lands on the sign-in page of the console, and goes on to the setup as anybody.
 *
 * What bounds it:
 *
 * - **No request makes one.** Only `announceFirstAdmin` (the start) and `runAdminLink` (the command)
 *   call `mintAdminLink`: the operator names the address, and a browser never does.
 * - **The log writes one only while the instance has no owner.** After the first workspace, the
 *   variable left in the environment opens nothing.
 * - **The command makes one for an instance with no owner, or for the address of an owner** who lost
 *   their session: on an instance with no e-mail, a session that ended is the only other way out.
 *   It refuses every other address: it never makes a second owner, and promotes nobody. It leaves a
 *   line in its log: who the link is for, and never the link.
 * - **Ten minutes, once, and one at a time.** A link is marked in the `Kv` of the database, which the
 *   replicas share. A new link takes the place of the one before, which is then refused. The link
 *   of an e-mail lives fifteen minutes: the mark holds its moment, and is kept longer than the link.
 * - **Checked again when it is spent.** A link for a first administrator is refused once the
 *   instance has an owner, whoever made it and however (a sign-in by e-mail that came back since).
 *   A link for an owner is refused once that person is no owner.
 * - **WARNING: the link is in the log, or on the terminal, in the clear.** Whoever reads it in its
 *   ten minutes signs in as that address, and on an instance with no owner becomes its owner. The
 *   token is written on one line and nowhere else: it is after the `#` of the link, which no
 *   browser sends to a server. `SECURITY.md` says it.
 */

/** How long a link lives: the ten minutes of the pairing link of FRU-108. */
export const ADMIN_LINK_TTL_SECONDS = 10 * 60;
const TTL_MS = ADMIN_LINK_TTL_SECONDS * 1000;
/**
 * How long the mark of a link is kept: longer than better-auth keeps the link itself. A link whose
 * mark was gone would be the link of an e-mail, and spent with none of the checks here. So the mark
 * holds the moment the link was made, and outlives the link.
 */
// A function: `env.ts` reads this module for its variable, and `auth.ts` reads `env.ts`.
const markTtlMs = (): number => 2 * MAGIC_LINK_TTL_SECONDS * 1000;

const PREFIX = 'fruitback:admin-link:';
/** The digest of the one link that may be spent. */
const CURRENT = `${PREFIX}current`;
/** Counts the workers that started in the window: the first one writes the link. */
const STARTS = `${PREFIX}starts`;

/** The mark of a link that was spent or refused: it is one of this module, and it is over. */
const ENDED = 'ended';

/** `first`: for an instance with no owner. `owner`: for a person who is one. */
type Mark = { kind: 'first' | 'owner'; email: string; at: number };

/** What a mint and a check need of the worker. `owners` is the address of every owner of a workspace. */
export type AdminLinks = {
  auth: Auth | Promise<Auth>;
  kv: Kv;
  owners(): Promise<string[]>;
  /** `FRUITBACK_CONSOLE_URL`: where the link opens. */
  consoleUrl: string;
};

/** The address of `FRUITBACK_FIRST_ADMIN`, or `undefined` for a value that is not one. */
export function readFirstAdmin(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : normalizeEmail(value);
}

async function digestOf(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));

  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readMark(value: string | undefined): Mark | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<Mark>;

    return (parsed.kind === 'first' || parsed.kind === 'owner') &&
      typeof parsed.email === 'string' &&
      typeof parsed.at === 'number'
      ? { kind: parsed.kind, email: parsed.email, at: parsed.at }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Makes the link, and marks it as the one link that may be spent. Not reachable over HTTP.
 *
 * The mark is written before the link is handed over: a `Kv` that does not answer gives no link.
 */
async function mintAdminLink(links: AdminLinks, mark: Mark): Promise<string> {
  let link: string | undefined;
  await sendLinkThrough(await links.auth, mark.email, new Headers(), async (token) => {
    const digest = await digestOf(token);
    await links.kv.set(`${PREFIX}${digest}`, JSON.stringify(mark), markTtlMs());
    // The link before stops here: one link at a time, whoever asked for each.
    await links.kv.set(CURRENT, digest, markTtlMs());
    // After the `#`: a fragment is never sent to a server, so no proxy and no access log holds it.
    link = `${new URL(links.consoleUrl).origin}/sign-in#${token}`;
  });
  if (link === undefined) throw new Error('better-auth made no link');

  return link;
}

const MINUTES = Math.round(ADMIN_LINK_TTL_SECONDS / 60);

/**
 * The lines to write in the log when the worker starts, or none when there is nothing to say.
 *
 * Two replicas that start together both find no owner. The `Kv` counts them, and the first one
 * writes the link: the other says that a link was written, and writes none.
 */
export async function firstAdminLines(links: AdminLinks, email: string, now: number = Date.now()): Promise<string[]> {
  if ((await links.owners()).length > 0) return [];
  if ((await links.kv.incr(STARTS, TTL_MS)) > 1) {
    return [
      `this Fruitback has no owner yet, and a sign-in link for its first administrator was written less than ${MINUTES} minutes ago, by this worker or by another one (FRUITBACK_FIRST_ADMIN). ` +
        'Read the log of that start, wait and start again, or run `node server.mjs admin-link --email <address>`.',
    ];
  }
  const link = await mintAdminLink(links, { kind: 'first', email, at: now });

  return [
    `this Fruitback has no owner yet. Sign-in link for ${email} (FRUITBACK_FIRST_ADMIN):`,
    `    ${link}`,
    `${email} opens it, and makes the first workspace. Valid for ${MINUTES} minutes, and usable once. ` +
      'Whoever reads this log can use it: start the worker again for another one.',
  ];
}

export type AdminLinkOutcome = { ok: boolean; lines: string[]; log?: string };

/**
 * The command: a link for an instance with no owner, or for an owner. `log` is the line that the
 * command leaves in the log: who asked for a link, and never the link.
 */
export async function adminLinkFor(
  links: AdminLinks,
  typed: string,
  now: number = Date.now(),
): Promise<AdminLinkOutcome> {
  const email = normalizeEmail(typed);
  if (email === undefined) return { ok: false, lines: ['--email needs an address'] };
  const owners = await links.owners();
  if (owners.length > 0 && !owners.includes(email)) {
    return {
      ok: false,
      lines: [
        `this Fruitback has an owner, and ${email} is not one: the command makes a link for an owner who lost their session, and never makes another owner.`,
        'An owner invites a person from the console, on « Members ». Nothing was written.',
      ],
    };
  }
  const kind = owners.length === 0 ? 'first' : 'owner';
  const link = await mintAdminLink(links, { kind, email, at: now });

  return {
    ok: true,
    lines: [
      kind === 'first'
        ? `this Fruitback has no owner yet. Sign-in link for ${email}, who makes the first workspace:`
        : `sign-in link for ${email}, an owner of this Fruitback:`,
      '',
      `    ${link}`,
      '',
      `Valid for ${MINUTES} minutes, and usable once. A link made before this one is refused now.`,
      'It is not stored and cannot be shown again. The sessions that are open stay open.',
    ],
    log: `a sign-in link was made by the command admin-link for ${email} (${kind === 'first' ? 'no owner yet' : 'an owner'}). It is not in this log.`,
  };
}

/**
 * What a link is, when the console spends it: `none` for a link of an e-mail, which this module did
 * not make; `spend` for a link it made that may be spent; `refuse` for one that may not.
 *
 * A `Kv` that does not answer rejects: the caller cannot tell a link of an e-mail from this one, and
 * must not spend either.
 */
export async function adminLinkAt(
  links: Pick<AdminLinks, 'kv' | 'owners'>,
  token: string,
  now: number = Date.now(),
): Promise<{ is: 'none' } | { is: 'spend'; email: string; kind: Mark['kind'] } | { is: 'refuse'; why: string }> {
  const digest = await digestOf(token);
  const held = await links.kv.get(`${PREFIX}${digest}`);
  if (held === ENDED) return { is: 'refuse', why: 'it was spent or refused before' };
  const mark = readMark(held);
  // A mark that cannot be read is a mark: refused, and never taken for the link of an e-mail.
  if (mark === undefined) return held === undefined ? { is: 'none' } : { is: 'refuse', why: 'its mark cannot be read' };
  if (now - mark.at > TTL_MS) return { is: 'refuse', why: `it is more than ${MINUTES} minutes old` };
  if ((await links.kv.get(CURRENT)) !== digest) return { is: 'refuse', why: 'a link was made after it' };
  const owners = await links.owners();
  if (mark.kind === 'first' && owners.length > 0) return { is: 'refuse', why: 'this Fruitback has an owner now' };
  if (mark.kind === 'owner' && !owners.includes(mark.email))
    return { is: 'refuse', why: 'that person is no owner now' };

  return { is: 'spend', email: mark.email, kind: mark.kind };
}

/**
 * Ends a link: it was spent, or refused. Its mark stays, and says that it ended.
 *
 * WARNING: the mark is not taken away. A link that was refused was not given to better-auth, which
 * still holds it: with no mark it would be the link of an e-mail, and the next try would spend it.
 */
export async function endAdminLink(kv: Kv, token: string): Promise<void> {
  const digest = await digestOf(token);
  await kv.set(`${PREFIX}${digest}`, ENDED, markTtlMs());
  if ((await kv.get(CURRENT)) === digest) await kv.set(CURRENT, '', 1);
}
