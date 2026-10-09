/**
 * Sending one e-mail (FRU-98): the sign-in link, and later the invitations.
 *
 * A seam like `SeedStore`. The worker names what it sends, and an implementation knows how. The one
 * implementation is Scaleway Transactional Email, over its HTTP API: one `fetch`, no SMTP client to
 * carry. A worker with no mailer sends nothing, and its `/auth/email` route does not exist.
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
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1c1917;background:#faf9f5;padding:32px">
<p style="font-size:16px;font-weight:600">${escapeHtml(words.title)}</p>
<p><a href="${href}" style="display:inline-block;background:#dd2c27;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(words.button)}</a></p>
<p style="color:#78716c;font-size:13px">${escapeHtml(words.once(minutes))} ${escapeHtml(words.ignore)}</p>
<p style="color:#a8a29e;font-size:12px;word-break:break-all">${href}</p>
</body></html>`;

  return { to, subject: words.subject, text, html };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
