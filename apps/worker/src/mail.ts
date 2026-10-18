/**
 * Sending one e-mail (FRU-98): the sign-in link, and the invitation to a workspace (FRU-104).
 *
 * A seam like `SeedStore`. The worker names what it sends, and an implementation knows how. The one
 * implementation is Scaleway Transactional Email, over its HTTP API: one `fetch`, no SMTP client to
 * carry. A worker with no mailer sends nothing, and its `/console/auth/email` route does not exist.
 */

export type MailMessage = { to: string; subject: string; text: string; html: string };

export type Mailer = { send(message: MailMessage): Promise<void> };

export class MailError extends Error {}

/** `FRUITBACK_SCALEWAY_TEM`: the project id and the secret key of an API key, joined by a colon. */
export type TemSettings = { projectId: string; secretKey: string; from: string; region?: string };

/** Reads `<project id>:<secret key>`, or `undefined` when the value does not have that shape. */
export function parseTemCredentials(value: string): { projectId: string; secretKey: string } | undefined {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return undefined;

  return { projectId: value.slice(0, separator).trim(), secretKey: value.slice(separator + 1).trim() };
}

/**
 * When this process last sent a message that the provider took (FRU-261), for the administrator of
 * the instance. In the memory of this process: another replica has its own.
 */
let lastSentAt: number | undefined;

/** The instant of the last message this process sent, as ISO 8601, or `undefined` for none yet. */
export function lastMailSentAt(): string | undefined {
  return lastSentAt === undefined ? undefined : new Date(lastSentAt).toISOString();
}

/** A bounded call: a provider that accepts the connection and never answers must not hold a route. */
const SEND_TIMEOUT_MS = 10_000;

export function createTemMailer(settings: TemSettings, fetcher: typeof fetch = fetch): Mailer {
  const region = settings.region ?? 'fr-par';
  const endpoint = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${region}/emails`;

  return {
    async send({ to, subject, text, html }) {
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Auth-Token': settings.secretKey },
          body: JSON.stringify({
            from: { email: settings.from, name: 'Fruitback' },
            to: [{ email: to }],
            subject,
            text,
            html,
            project_id: settings.projectId,
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        throw new MailError(`The mail provider did not answer: ${String(error)}`);
      }

      // The body of a refusal names the reason, and never the key: it is safe to log.
      if (!response.ok) throw new MailError(`The mail provider refused the message: ${response.status}`);
      lastSentAt = Date.now();
    },
  };
}

/** The languages of the sign-in message. Any other tag falls back to English. */
const SIGN_IN_WORDS = {
  en: {
    subject: 'Your Fruitback sign-in link',
    title: 'Sign in to Fruitback',
    lead: 'Sign in to Fruitback with this link:',
    button: 'Sign in',
    once: (minutes: number) => `It works once, for ${minutes} minutes.`,
    ignore: 'If you did not ask to sign in, ignore this message: nothing happens without the link.',
  },
  fr: {
    subject: 'Votre lien de connexion à Fruitback',
    title: 'Connexion à Fruitback',
    lead: 'Connectez-vous à Fruitback avec ce lien :',
    button: 'Se connecter',
    once: (minutes: number) => `Il ne sert qu'une fois, pendant ${minutes} minutes.`,
    ignore: "Si vous n'avez pas demandé à vous connecter, ignorez ce message : rien ne se passe sans le lien.",
  },
} as const;

/**
 * The sign-in message. The link is the whole of it, and it carries no picture: an image that loads
 * from a server says when the message was opened.
 *
 * It says what happens when somebody did not ask: nothing. An address anybody can type receives this,
 * and the person who reads it must know that ignoring it is safe.
 */
export function signInMessage(to: string, link: string, minutes: number, locale = 'en'): MailMessage {
  const words = locale.toLowerCase().startsWith('fr') ? SIGN_IN_WORDS.fr : SIGN_IN_WORDS.en;
  const text = [words.lead, '', link, '', words.once(minutes), words.ignore].join('\n');
  const href = escapeHtml(link);
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#18181b;background:#ffffff;padding:32px">
<p style="font-size:16px;font-weight:600">${escapeHtml(words.title)}</p>
<p><a href="${href}" style="display:inline-block;background:#dd2c27;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(words.button)}</a></p>
<p style="color:#6b6b74;font-size:13px">${escapeHtml(words.once(minutes))} ${escapeHtml(words.ignore)}</p>
<p style="color:#6b6b74;font-size:12px;word-break:break-all">${href}</p>
</body></html>`;

  return { to, subject: words.subject, text, html };
}

/** The languages of an invitation. Any other tag falls back to English. */
const INVITATION_WORDS = {
  en: {
    subject: 'You are invited to a workspace on Fruitback',
    lead: (inviter: string, workspace: string, role: string, sites: string) =>
      role === 'guest'
        ? `${inviter} invites you to the workspace « ${workspace} » on Fruitback, as a guest, on ${sites}.`
        : `${inviter} invites you to the workspace « ${workspace} » on Fruitback, as ${role === 'admin' ? 'an admin' : 'a member'}.`,
    how: (address: string) => `Sign in with ${address}, and you will see the invitation:`,
    button: 'See the invitation',
    lasts: (days: number) => `It waits for ${days} days.`,
    ignore:
      'This link opens nothing by itself: to join, you sign in with this address. If you expected no invitation, ignore this message.',
  },
  fr: {
    subject: 'Vous êtes invité dans un espace de travail sur Fruitback',
    lead: (inviter: string, workspace: string, role: string, sites: string) =>
      role === 'guest'
        ? `${inviter} vous invite dans l'espace de travail « ${workspace} » sur Fruitback, comme invité, sur ${sites}.`
        : `${inviter} vous invite dans l'espace de travail « ${workspace} » sur Fruitback, comme ${role === 'admin' ? 'administrateur' : 'membre'}.`,
    how: (address: string) => `Connectez-vous avec ${address}, et vous verrez l'invitation :`,
    button: "Voir l'invitation",
    lasts: (days: number) => `Elle attend ${days} jours.`,
    ignore:
      "Ce lien n'ouvre rien à lui seul : pour rejoindre l'espace, vous vous connectez avec cette adresse. Si vous n'attendiez pas d'invitation, ignorez ce message.",
  },
} as const;

/**
 * An invitation to a workspace (FRU-104).
 *
 * **The link is the address of the console, and holds no id and no token.** Whoever reads this
 * message, or a copy of it, opens nothing with it: the invitation is shown to a session of the
 * address it was sent to, and to nobody else.
 *
 * **The name of the workspace and of the inviter are written by people, and anybody makes a
 * workspace** (FRU-209). So the subject is the same for every invitation and holds neither: a subject
 * « You are invited to Your invoice is ready: https://… » went out under the name of Fruitback. In
 * the body they are escaped in the HTML, one line each (the accounts keep them so), and written so
 * that no mail client makes a link of them (`unlinked`): the one link of the message is the console's.
 */
export function invitationMessage(
  to: string,
  invitation: {
    inviter: string;
    workspace: string;
    role: string;
    link: string;
    days: number;
    /** The sites a guest is invited on (FRU-250), by their address: the message names their hosts. */
    sites?: readonly string[];
  },
  locale = 'en',
): MailMessage {
  const words = locale.toLowerCase().startsWith('fr') ? INVITATION_WORDS.fr : INVITATION_WORDS.en;
  // A site is an address an admin pasted: its host, written so that no client makes a link of it.
  const sites = (invitation.sites ?? []).map((origin) => unlinked(hostOf(origin))).join(', ');
  const lead = words.lead(unlinked(invitation.inviter), unlinked(invitation.workspace), invitation.role, sites);
  const text = [lead, '', words.how(to), '', invitation.link, '', words.lasts(invitation.days), words.ignore].join(
    '\n',
  );
  const href = escapeHtml(invitation.link);
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#18181b;background:#ffffff;padding:32px">
<p style="font-size:16px;font-weight:600">${escapeHtml(lead)}</p>
<p>${escapeHtml(words.how(to))}</p>
<p><a href="${href}" style="display:inline-block;background:#dd2c27;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(words.button)}</a></p>
<p style="color:#6b6b74;font-size:13px">${escapeHtml(words.lasts(invitation.days))} ${escapeHtml(words.ignore)}</p>
<p style="color:#6b6b74;font-size:12px;word-break:break-all">${href}</p>
</body></html>`;

  return { to, subject: words.subject, text, html };
}

/**
 * A text that a person wrote, as a mail client shows it without a link: a zero-width space after each
 * `.`, `:`, `/` and `@` breaks what a client would read as an address (`https://…`, `www.…`,
 * `a@b.c`). The text reads the same.
 */
export function unlinked(value: string): string {
  return value.replaceAll(/[.:/@]/g, (mark) => `${mark}\u200B`);
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
