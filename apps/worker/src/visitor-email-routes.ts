import { readBoundedText } from './bounded-body.ts';
import { normalizeClientId } from './clients.ts';
import { noticeLocale, readEmail } from './done-notices.ts';
import { json } from './http.ts';
import { type Kv, KvError } from './kv.ts';
import { type MailMessage, type Mailer, MailError, unlinked } from './mail.ts';
import { routingFailure } from './note-helpers.ts';
import { checkNotifyCaller, checkNotifySite } from './rate-limit.ts';
import type { CallerChecks, Served } from './request-context.ts';
import {
  CONFIRM_ANCHOR,
  VISITOR_LINK_TTL_MS,
  type VisitorAddresses,
  emailVisitorDigestOf,
  readVisitorLinkToken,
  visitorLinkToken,
} from './visitor-addresses.ts';

/**
 * « A confirmed e-mail » (FRU-705): the two routes of the widget of a site that recognises its visitors
 * by an address. `visitor-addresses.ts` says what is kept and why.
 *
 * - `POST /feedback/visitor/email?client=<site>`, `{ email, url, locale? }`, with the key of the
 *   browser: sends a link to the address, on the page `url` of the site, `#fruitback-confirm=<token>`.
 *   `202`. The answer is the same whatever the address: it says nothing of who confirmed what.
 * - `POST /feedback/visitor/confirm?client=<site>`, `{ token }`, with the key of the browser: the
 *   browser that asked confirms, once, within 30 minutes. `200 { visitor: 'email' }`.
 *
 * Neither route exists (`404`) on a site that does not ask for an address, on a worker that sends no
 * e-mail or keeps no account, as the address of a note done (FRU-604).
 */
export const VISITOR_EMAIL_PATH = '/feedback/visitor/email';
export const VISITOR_CONFIRM_PATH = '/feedback/visitor/confirm';

export type VisitorEmailSeams = {
  kv: Kv;
  corsHeaders: Record<string, string>;
  clientIp: string;
  addresses: VisitorAddresses | undefined;
  mailer: Mailer | undefined;
  /** `FRUITBACK_AUTH_SECRET`: the key of the links is derived from it, for this use alone. */
  secret: string | undefined;
  /** The digest of the key of the browser of this request, for this site (`visitorDigestOf`). */
  browserOf: (request: Request, site: string) => string | undefined;
  now: number;
};

type Checks = Pick<CallerChecks, 'routeFor'>;

/** What both routes need: the site, which asks for an address, and a worker that can confirm one. */
async function siteThatAsks(
  request: Request,
  config: Served,
  seams: VisitorEmailSeams,
  checks: Checks,
): Promise<
  | { ok: true; site: string; origins: readonly string[]; addresses: VisitorAddresses; secret: string; browser: string }
  | { ok: false; response: Response }
> {
  const { corsHeaders, addresses, mailer, secret } = seams;
  const site = normalizeClientId(new URL(request.url).searchParams.get('client'));
  const route = await checks.routeFor(request, config, site);
  if (!route.ok) return { ok: false, response: routingFailure(route, corsHeaders) };
  if (
    site === undefined ||
    route.client?.workspace === undefined ||
    route.policy.visitorIdentity !== 'email' ||
    addresses === undefined ||
    mailer === undefined ||
    secret === undefined
  ) {
    return { ok: false, response: json(404, { error: 'not-found' }, corsHeaders) };
  }
  // A link is for one browser: the key it confirms. With no key, there is nobody to confirm.
  const browser = seams.browserOf(request, site);
  if (browser === undefined) return { ok: false, response: json(401, { error: 'identity-required' }, corsHeaders) };

  return { ok: true, site, origins: route.client.origins ?? [], addresses, secret, browser };
}

export async function postVisitorEmail(
  request: Request,
  config: Served,
  seams: VisitorEmailSeams,
  checks: Checks,
): Promise<Response> {
  const { kv, corsHeaders, clientIp, now } = seams;
  const asked = await siteThatAsks(request, config, seams, checks);
  if (!asked.ok) return asked.response;
  const body = await bodyOf(request);
  const email = readEmail(body?.email);
  if (email === undefined) return json(400, { error: 'invalid-email' }, corsHeaders);
  const page = pageOf(body?.url, asked.origins);
  if (page === undefined) return json(400, { error: 'invalid-url' }, corsHeaders);

  try {
    // As the address of a note done (FRU-604): the caller first, then the site.
    if (!(await checkNotifyCaller(kv, clientIp, now))) return json(429, { error: 'rate-limited' }, corsHeaders);
    if (!(await checkNotifySite(kv, asked.site, now))) return json(429, { error: 'rate-limited' }, corsHeaders);
  } catch (error) {
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
  const token = visitorLinkToken(
    asked.secret,
    { site: asked.site, visitor: asked.browser, identity: emailVisitorDigestOf(asked.site, email) },
    now,
  );
  page.hash = `${CONFIRM_ANCHOR}=${token}`;
  try {
    await seams.mailer?.send(confirmMessage(email, page.toString(), body?.locale));
  } catch (error) {
    if (!(error instanceof MailError)) throw error;
    console.error(`[fruitback] the link of a visitor of site ${asked.site} was not sent: ${error.message}`);

    return json(502, { error: 'mail-unavailable' }, corsHeaders);
  }

  return json(202, { sent: true, minutes: VISITOR_LINK_TTL_MS / 60_000 }, corsHeaders);
}

export async function postVisitorConfirm(
  request: Request,
  config: Served,
  seams: VisitorEmailSeams,
  checks: Checks,
): Promise<Response> {
  const { kv, corsHeaders, now } = seams;
  const asked = await siteThatAsks(request, config, seams, checks);
  if (!asked.ok) return asked.response;
  const body = await bodyOf(request);
  const link = readVisitorLinkToken(asked.secret, asked.site, body?.token, now);
  // Forged, of another site, or out of date: one answer, so a guess learns nothing.
  if (link === undefined) return json(410, { error: 'link-expired' }, corsHeaders);
  // Before the link is spent: a link opened in another browser stays good for the one that asked.
  if (link.visitor !== asked.browser) return json(403, { error: 'other-browser' }, corsHeaders);

  try {
    // Once. The count lives as long as the link could.
    if ((await kv.incr(`visitor-link:${link.mac}`, VISITOR_LINK_TTL_MS)) > 1) {
      return json(410, { error: 'link-used' }, corsHeaders);
    }
  } catch (error) {
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
  try {
    await asked.addresses.confirm(asked.site, asked.browser, link.identity, now);
  } catch (error) {
    // The link is spent and nothing is kept: the visitor asks for another one.
    console.error(
      `[fruitback] the address of a visitor of site ${asked.site} was not kept: ${error instanceof Error ? error.message : String(error)}`,
    );

    return json(502, { error: 'store-unavailable' }, corsHeaders);
  }

  return json(200, { visitor: 'email' }, corsHeaders);
}

/**
 * The body of a call of the widget: a JSON object, else nothing. As `notify-route.ts` reads it: bounded,
 * and a body that is no object is an empty one, which each route then refuses for what it lacks.
 */
async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await readBoundedText(request);
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A page of the site that the widget is on: http or https, of an origin of the site. */
function pageOf(value: unknown, origins: readonly string[]): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !origins.includes(url.origin)) return undefined;

  return url;
}

const WORDS = {
  en: {
    subject: (host: string) => `Confirm your address for your notes on ${host}`,
    lead: (host: string) => `Somebody asked to link this address to their notes on ${host}.`,
    how: 'Open this link in the browser where you asked, within 30 minutes. It works once.',
    button: 'Confirm my address',
    after: 'Your notes on this site are then yours on every browser that confirms this address.',
    ignore: 'If you did not ask, ignore this message: nothing changes.',
  },
  fr: {
    subject: (host: string) => `Confirmez votre adresse pour vos notes sur ${host}`,
    lead: (host: string) => `Quelqu'un a demandé à lier cette adresse à ses notes sur ${host}.`,
    how: "Ouvrez ce lien dans le navigateur où vous l'avez demandé, dans les 30 minutes. Il ne sert qu'une fois.",
    button: 'Confirmer mon adresse',
    after: 'Vos notes sur ce site sont alors à vous dans chaque navigateur qui confirme cette adresse.',
    ignore: "Si vous n'avez rien demandé, ignorez ce message : rien ne change.",
  },
} as const;

/**
 * The message of a link (FRU-705): the host of the page and the link, and no word of a note. No picture:
 * an image that loads from a server says when the message was opened.
 */
export function confirmMessage(to: string, link: string, locale: unknown): MailMessage {
  const words = WORDS[noticeLocale(locale)];
  const host = unlinked(new URL(link).host);
  const text = [words.lead(host), '', words.how, '', link, '', words.after, words.ignore].join('\n');
  const href = escapeHtml(link);
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#18181b;background:#ffffff;padding:32px">
<p style="font-size:16px;font-weight:600">${escapeHtml(words.lead(host))}</p>
<p>${escapeHtml(words.how)}</p>
<p><a href="${href}" style="display:inline-block;background:#5560c4;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(words.button)}</a></p>
<p style="color:#6b6b74;font-size:13px">${escapeHtml(words.after)} ${escapeHtml(words.ignore)}</p>
<p style="color:#6b6b74;font-size:12px;word-break:break-all">${href}</p>
</body></html>`;

  return { to, subject: words.subject(host), text, html };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
