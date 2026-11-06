import { createHmac, timingSafeEqual } from 'node:crypto';
import { type MailMessage, type Mailer, unlinked } from './mail.ts';

/**
 * Telling the person who left a note that the team marked it done (FRU-604).
 *
 * - **A member** gets the message at the address of their account. The row holds the account, never
 *   an address: `watch` writes it when the note is planted.
 * - **A visitor with no account** is asked for an address by the widget, just after the note is
 *   sent. The answer of `POST /feedback` carries a `notify` token for that one note; the address
 *   comes back with it to `POST /feedback/<id>/notify` (`notify-route.ts`). Without the token, no
 *   address is taken: a caller cannot ask for messages about the note of somebody else.
 * - **One message per note, then the row goes.** `take` claims the rows of the notes that are done
 *   and answers them, in one statement: two reads of the page at once send one message. The row goes
 *   only once the provider took the message (`sent`). A message the provider refused releases its
 *   claim (`release`), and a process that stopped while it sent leaves a claim that runs out
 *   (`DONE_CLAIM_MS`): either way the next read that sees the note done tries again, until
 *   `expires_at`. One case sends twice: the provider took the message, and the database refused the
 *   removal of its row. A second message is the lesser harm: the other order loses the only one.
 * - **When**: when the worker learns that the note is done. That is a read of its page that asks
 *   the store (the read cache holds an answer for 15 seconds), or a change of its status in the
 *   console or the extension. A note moved in a tracker that nobody reads again sends nothing.
 */

/** A row of `done_notices`: exactly one of `account` and `email`. */
export type DoneNotice = {
  site: string;
  note: string;
  account?: string;
  email?: string;
  locale?: string;
  /** When the row goes if no message left before. Written by `watch`. */
  expiresAt?: number;
};

export type DoneNotices = {
  /**
   * Writes the person to tell for this note. `false`: the note has one already, or it is not in the
   * index of the site: nothing is written.
   */
  watch(notice: DoneNotice, now: number): Promise<boolean>;
  /**
   * Claims the rows of these notes of the site until `now + DONE_CLAIM_MS`, and answers them. A row
   * another read claimed, and that claim has not run out, is absent: two reads at once send one
   * message. The row stays until `sent`: a process that stops while it sends loses nothing.
   */
  take(site: string, notes: readonly string[], now: number): Promise<DoneNotice[]>;
  /** The message of this note left, or nobody is left to tell: its row goes. */
  sent(notice: Pick<DoneNotice, 'site' | 'note'>): Promise<void>;
  /** The message did not leave: the claim goes, and the next read that sees the note done tries again. */
  release(notice: Pick<DoneNotice, 'site' | 'note'>): Promise<void>;
  /** Removes the rows whose time ran out. Answers how many went. */
  sweep(now: number): Promise<number>;
};

/**
 * How long a row waits for its note to be done: 90 days. A note that is not done by then, or that the
 * team closed without doing it, is no longer « about to be fixed », and its address goes.
 */
export const DONE_NOTICE_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How long a read holds the rows it is sending: 10 minutes, well above the 10 seconds a message may
 * take (`SEND_TIMEOUT_MS` of `mail.ts`) for each of the notes of one page. A read that stopped
 * meanwhile leaves its rows to the next read after it.
 */
export const DONE_CLAIM_MS = 10 * 60 * 1000;

/** How long the token of a note takes an address after the note was sent: 30 minutes. */
export const NOTIFY_TOKEN_TTL_MS = 30 * 60 * 1000;

/** The longest address taken: the bound of RFC 5321 on a path. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * An address the worker will send to: one `@`, a local part, and a domain with a dot, no space, no
 * control character, no quote and no angle bracket. Answered trimmed and in lower case, else
 * `undefined`. Not a proof that the address exists: nothing is sent before the note is done.
 */
export function readEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined;
  // One `@`, a local part of 64 at most, a domain of labels with at least one dot.
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      email,
    )
  ) {
    return undefined;
  }

  return email;
}

/** A language the message is written in: `fr` or `en`. Anything else is English. */
export function noticeLocale(value: unknown): 'en' | 'fr' {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/**
 * The token that lets the browser that sent a note give an address for it: `<expiry>.<mac>`.
 *
 * The MAC is an HMAC-SHA256 of the site, the note and the expiry, under a key derived from
 * `FRUITBACK_AUTH_SECRET` for this use alone. So the worker keeps nothing for a note whose visitor
 * gives no address, and a token of one note opens no other.
 */
export function notifyToken(secret: string, site: string, note: string, now: number): string {
  const expiry = now + NOTIFY_TOKEN_TTL_MS;

  return `${expiry}.${macOf(secret, site, note, expiry)}`;
}

/** Whether this token was made by `notifyToken` for this note of this site, and is not out of date. */
export function readNotifyToken(secret: string, site: string, note: string, token: unknown, now: number): boolean {
  if (typeof token !== 'string' || token.length > 200) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiryText = token.slice(0, dot);
  if (!/^\d{1,16}$/u.test(expiryText)) return false;
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry < now || expiry > now + NOTIFY_TOKEN_TTL_MS) return false;
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(macOf(secret, site, note, expiry), 'utf8');

  return given.length === expected.length && timingSafeEqual(given, expected);
}

function macOf(secret: string, site: string, note: string, expiry: number): string {
  // A key for this use only: the same secret signs the sessions of better-auth.
  const key = createHmac('sha256', secret).update('fruitback done-notice token v1').digest();

  return createHmac('sha256', key)
    .update(JSON.stringify([site, note, expiry]))
    .digest('base64url');
}

const DONE_WORDS = {
  en: {
    subject: (host: string) => `Your note on ${host} is fixed`,
    lead: (host: string) => `The team marked your note on ${host} as done.`,
    how: 'See it on its page, and say whether it looks fixed:',
    button: 'Check it on the page',
    once: 'Fruitback writes to you once about this note.',
    forgotten: 'Your address is not kept after this message.',
  },
  fr: {
    subject: (host: string) => `Votre note sur ${host} est corrigée`,
    lead: (host: string) => `L'équipe a marqué votre note sur ${host} comme faite.`,
    how: 'Voyez-la sur sa page, et dites si elle vous semble corrigée :',
    button: 'La vérifier sur la page',
    once: "Fruitback ne vous écrit qu'une fois au sujet de cette note.",
    forgotten: "Votre adresse n'est plus gardée après ce message.",
  },
} as const;

/**
 * The message of a note done. It holds the host of its page and the link to the note on its page
 * (`#fruitback-note=<id>`, FRU-253), and **no word of the note**: the text was typed by whoever sent
 * the note, and must not reach an inbox under the name of Fruitback. No picture either: an image that
 * loads from a server says when the message was opened.
 */
export function doneMessage(
  to: string,
  page: string,
  note: string,
  locale: string | undefined,
  /** A visitor with no account: the message says that their address goes with it. */
  guest = false,
): MailMessage {
  const words = DONE_WORDS[noticeLocale(locale)];
  const once = guest ? `${words.once} ${words.forgotten}` : words.once;
  const url = new URL(page);
  url.hash = `fruitback-note=${encodeURIComponent(note)}`;
  const link = url.toString();
  const host = unlinked(url.host);
  const text = [words.lead(host), '', words.how, '', link, '', once].join('\n');
  const href = escapeHtml(link);
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#18181b;background:#ffffff;padding:32px">
<p style="font-size:16px;font-weight:600">${escapeHtml(words.lead(host))}</p>
<p>${escapeHtml(words.how)}</p>
<p><a href="${href}" style="display:inline-block;background:#5560c4;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(words.button)}</a></p>
<p style="color:#6b6b74;font-size:13px">${escapeHtml(once)}</p>
<p style="color:#6b6b74;font-size:12px;word-break:break-all">${href}</p>
</body></html>`;

  return { to, subject: words.subject(host), text, html };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** What sending the messages of a site needs. Absent `mailer` or `notices`: nothing is sent. */
export type DoneNoticeSeams = {
  notices: DoneNotices | undefined;
  mailer: Mailer | undefined;
  /** The primary address and the language of an account, or `undefined` for an account that is gone. */
  accountOf: (account: string) => Promise<{ email: string; locale?: string } | undefined>;
  now?: () => number;
};

/**
 * Sends the message of each of these notes that is done and has a row, once. Never throws: a
 * failure is logged, and costs the read nothing. Answers how many messages left.
 */
export async function sendDoneNotices(
  seams: DoneNoticeSeams,
  site: string,
  issues: readonly { stage: string; note: { id: string; page: { url: string } } }[],
): Promise<number> {
  const { notices, mailer } = seams;
  if (notices === undefined || mailer === undefined) return 0;
  const done = issues.filter((issue) => issue.stage === 'done');
  if (done.length === 0) return 0;
  const now = seams.now?.() ?? Date.now();
  let taken: DoneNotice[];
  try {
    taken = await notices.take(
      site,
      done.map((issue) => issue.note.id),
      now,
    );
  } catch (error) {
    console.error('[fruitback] could not read who to tell of a note done', error);

    return 0;
  }
  const pages = new Map(done.map((issue) => [issue.note.id, issue.note.page.url]));
  let sent = 0;
  for (const notice of taken) {
    const page = pages.get(notice.note);
    let left = false;
    try {
      const to =
        notice.email === undefined ? await accountTo(seams, notice) : { email: notice.email, locale: notice.locale };
      if (to === undefined) {
        // An account that is gone, or suspended, has nobody to tell: its row goes as a message would.
        left = true;
      } else if (page !== undefined) {
        await mailer.send(doneMessage(to.email, page, notice.note, to.locale, notice.email !== undefined));
        sent += 1;
        left = true;
      }
      // A row whose page this read does not hold is not this read's to send: it is released below.
    } catch (error) {
      console.error(`[fruitback] the message of a note done did not leave: ${String(error)}`);
    }
    // The row goes once the message left; else its claim goes, and the next read tries again. A
    // failure here leaves the claim, which runs out by itself: nothing is lost.
    await (left ? notices.sent(notice) : notices.release(notice)).catch((again: unknown) => {
      console.error('[fruitback] could not write what became of the message of a note done', again);
    });
  }

  return sent;
}

/** The address and the language of the account of a notice, or `undefined` for none. */
async function accountTo(
  seams: DoneNoticeSeams,
  notice: DoneNotice,
): Promise<{ email: string; locale?: string | undefined } | undefined> {
  return notice.account === undefined ? undefined : seams.accountOf(notice.account);
}
