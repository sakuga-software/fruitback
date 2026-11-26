/**
 * Whether the worker answers a reader that carries no credential (FRU-66).
 *
 * The extension-mode widget calls the worker from the page, with no session. On a worker that reads
 * `authenticated`, each read answers `401`, and the widget leaves the page as it is: no pin and no
 * reason, the same screen as a page with no note. The popup asks the worker the same question, and
 * says the answer.
 *
 * Behind a seam so `node --test` reaches each answer. The popup binds `fetch`.
 */

/** What the popup says when the worker wants a session for a read. */
export const READ_NEEDS_SESSION =
  'This server answers a signed-in reader only, and in extension mode the extension holds no session. Notes do not show on this site.';

/**
 * What the popup says when the site takes notes from its members only (FRU-330): the refusal of the
 * read says `canWrite: false`, and the widget of extension mode offers no note. How to open the site
 * for extension mode: « Anyone on the page », in the console.
 */
export const NOTES_NEED_SESSION =
  'This site takes notes from its members only, and in extension mode the extension holds no session: no note can be sent from here. To review it in extension mode, an admin of the site sets « Who can leave a note » to « Anyone on the page » in the console.';

/**
 * FRU-395: the worker of the rule answers `404` to a read, so nothing is at that address: a pairing
 * link pasted where the worker goes (`…/pair`), or a path that is not the worker's.
 */
export const WORKER_NOT_FOUND = 'The server of this rule does not answer. Check its address in the options.';

/** The guide that says which mode can read an authenticated worker. */
export const MODES_GUIDE = 'https://sakuga-software.github.io/fruitback/modes.html';

/** `members-only`: a `401` that also says that a note would be refused (FRU-330). */
export type ReadProbe = 'answers' | 'wants-a-session' | 'members-only' | 'not-found' | 'unknown';

export type ReadProbeSeams = {
  fetch: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<{ status: number; ok: boolean; json?: () => Promise<unknown> }>;
};

/** A popup is open for a moment. An answer that comes later than this is shown to nobody. */
export const READ_PROBE_TIMEOUT_MS = 4_000;

/**
 * Only a `401` and a `404` are statements. A worker that is down, slow or rate-limited says nothing about who can
 * read, so the popup stays silent for it rather than naming a cause it did not measure.
 */
export async function probeRead(
  site: { endpoint: string; clientId?: string | undefined },
  pageUrl: string,
  seams: ReadProbeSeams,
): Promise<ReadProbe> {
  const client = site.clientId === undefined ? '' : `&client=${encodeURIComponent(site.clientId)}`;
  const url = `${site.endpoint}/feedback?url=${encodeURIComponent(pageUrl)}${client}`;

  try {
    const response = await seams.fetch(url, { signal: AbortSignal.timeout(READ_PROBE_TIMEOUT_MS) });
    if (response.status === 401) {
      // A body that cannot be read says nothing more than the status: the read wants a session.
      const body = await response.json?.().catch(() => undefined);
      const closed = typeof body === 'object' && body !== null && (body as { canWrite?: unknown }).canWrite === false;

      return closed ? 'members-only' : 'wants-a-session';
    }

    // FRU-395: no route at that address. A worker that is there answers its read, or refuses it:
    // an unknown client and a missing one are `400` (`routingFailure`), a page with no note is `200`
    // with no issue. Its only `404` on this path is the one of a path it does not serve,
    // `{ error: 'not-found' }`. A `404` that names another error is said to be nothing (review of #539).
    if (response.status === 404) {
      const body = await response.json?.().catch(() => undefined);
      const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;

      return error === undefined || error === 'not-found' ? 'not-found' : 'unknown';
    }

    return response.ok ? 'answers' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * FRU-663: the same two refusals, on the Fruitback of this build. A site made there is read by its
 * members by default, and its notes are « Members only »: the widget of extension mode shows no pin
 * and takes no note. On the Cloud the fix is not an admin's: the person signs in, and a member turns
 * the site on with their account. Extension mode stays open on the Cloud.
 */
export const CLOUD_NOTES_NEED_MEMBER =
  'Only the members of this site see its notes and leave one here. Sign in to Fruitback to review it as a member.';
export const CLOUD_READ_NEEDS_MEMBER =
  'Only the members of this site see its notes here. Sign in to Fruitback to review it as a member.';
/** Signed in, and a workspace of the account lists the site: one click turns it on with the account. */
export const MEMBER_TURNS_ON =
  'You are a member of this site. Turn it on with your account to see its notes and leave one.';
/** Signed in, and no workspace of the account lists the site. */
export const NOT_A_MEMBER =
  'Only the members of this site see its notes, and your account is not one of them. Ask its team to invite you.';

/** What the popup says of a refusal of a member's read, and the one button that fixes it, if any. */
export type MemberRemedy = { sentence: string; action?: 'sign-in' | 'turn-on'; guide?: true };

/**
 * The line of the popup for an extension-mode rule whose read was refused for want of a session.
 *
 * `onCloud`: the rule is on the Fruitback of this build. `signedIn`: this browser holds the account of
 * that Fruitback. `member`: a workspace of the account lists the origin (asked only when signed in).
 * A worker run by somebody else keeps the sentences of FRU-66 and FRU-330, with the guide.
 */
export function memberRemedy(
  answer: 'members-only' | 'wants-a-session',
  where: { onCloud: boolean; signedIn: boolean; member?: boolean },
): MemberRemedy {
  if (!where.onCloud) {
    return { sentence: answer === 'members-only' ? NOTES_NEED_SESSION : READ_NEEDS_SESSION, guide: true };
  }
  if (!where.signedIn) {
    return {
      sentence: answer === 'members-only' ? CLOUD_NOTES_NEED_MEMBER : CLOUD_READ_NEEDS_MEMBER,
      action: 'sign-in',
    };
  }

  return where.member === true ? { sentence: MEMBER_TURNS_ON, action: 'turn-on' } : { sentence: NOT_A_MEMBER };
}
