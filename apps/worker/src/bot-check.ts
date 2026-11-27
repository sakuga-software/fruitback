import type { Kv } from './kv.ts';

/**
 * « Bot check » of the card « Safeguards » (FRU-704): Cloudflare Turnstile before the first note of a
 * visitor with no account, on a site that asks for it, on an instance that has the keys of Turnstile.
 *
 * - **The guard is in `feedback-routes.ts`** (`botCheck`), so that a copy of that module with it taken
 *   out reaches `handleRequest`. This module holds what it calls: the verifier and the mark.
 * - **The widget sends the token in `TURNSTILE_HEADER`**, after a `403 bot-check` that names the site
 *   key. The worker sends it to `siteverify` with the secret of the instance and the address of the
 *   visitor, once: Cloudflare spends a token at its first check.
 * - **Before the first note, then not again for 30 days**: a browser that passed, known by the digest
 *   of its key (`visitorDigestOf`, of this site), gets a mark in the `Kv`. A visitor with no key is
 *   asked at each note: nothing tells them apart.
 * - **No call leaves a test**: the verifier is the seam `verifyTurnstile` of `RequestContext`. The one
 *   of production calls `SITEVERIFY_URL` with the `fetch` it is given.
 */

/** The two keys of one Turnstile widget (FRU-704): `FRUITBACK_TURNSTILE_SECRET` and `_SITE_KEY`. */
export type TurnstileKeys = { secret: string; siteKey: string };

/** The header of the token of Turnstile. Not CORS-safelisted: `cors.ts` lists it. */
export const TURNSTILE_HEADER = 'X-Fruitback-Turnstile';

/**
 * Where the worker checks a token (Cloudflare, « Validate the token », read 2026-11-27:
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
 */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The longest token Cloudflare makes (« Maximum length: 2048 characters », same page). */
export const TURNSTILE_TOKEN_MAX = 2048;

/** How long `siteverify` may take before the note is refused with `503`. */
export const SITEVERIFY_TIMEOUT_MS = 5_000;

/** How long a browser that passed is not asked again on the site: 30 days. */
export const BOT_CHECK_MARK_MS = 30 * 24 * 3_600_000;

/** `passed`: a person. `failed`: no person, or a token spent. `unavailable`: Cloudflare did not answer. */
export type TurnstileVerdict = 'passed' | 'failed' | 'unavailable';

export type VerifyTurnstile = (asked: { secret: string; token: string; remoteIp: string }) => Promise<TurnstileVerdict>;

/**
 * The verifier of production: one `POST` of a form to `SITEVERIFY_URL` with `secret`, `response` and
 * `remoteip`, and `success` of the JSON it answers. No answer in `timeoutMs`, a status that is not
 * `200`, or a body that is not JSON is `unavailable`, never `passed`.
 */
export function createTurnstileVerifier(
  http: typeof fetch = fetch,
  timeoutMs: number = SITEVERIFY_TIMEOUT_MS,
): VerifyTurnstile {
  return async ({ secret, token, remoteIp }) => {
    const form = new URLSearchParams({ secret, response: token });
    // The address the worker read behind its trusted proxies: `unknown` tells Cloudflare nothing.
    if (remoteIp !== '' && remoteIp !== 'unknown') form.set('remoteip', remoteIp);
    try {
      const answer = await http(SITEVERIFY_URL, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (answer.status !== 200) return 'unavailable';
      const body = (await answer.json()) as { success?: unknown } | null;

      return body?.success === true ? 'passed' : 'failed';
    } catch {
      return 'unavailable';
    }
  };
}

/** The key of the mark of a browser that passed on a site. The digest names the site already. */
export function botCheckMark(site: string, visitor: string): string {
  return `fruitback:bot-check:${JSON.stringify([site, visitor])}`;
}

/** Whether this browser passed on this site in the last 30 days. A `Kv` that does not answer: no. */
export async function passedBefore(kv: Kv, site: string, visitor: string | undefined): Promise<boolean> {
  if (visitor === undefined) return false;
  try {
    return (await kv.get(botCheckMark(site, visitor))) !== undefined;
  } catch {
    return false;
  }
}

/** Keeps the mark of a browser that passed. A `Kv` that does not answer keeps none: it is asked again. */
export async function rememberPassed(kv: Kv, site: string, visitor: string | undefined): Promise<void> {
  if (visitor === undefined) return;
  try {
    await kv.set(botCheckMark(site, visitor), '1', BOT_CHECK_MARK_MS);
  } catch (error) {
    console.error(`[fruitback] the bot check of site ${site} was not remembered: ${String(error)}`);
  }
}

/**
 * The token of a request, or `undefined` for none or one Cloudflare would never have made. A token
 * too long is not sent to Cloudflare.
 */
export function turnstileTokenOf(request: Request): string | undefined {
  const token = request.headers.get(TURNSTILE_HEADER)?.trim();
  if (token === undefined || token === '' || token.length > TURNSTILE_TOKEN_MAX) return undefined;

  return token;
}

/**
 * The verifier of the worker of development (`dev-worker.fixture.ts`): no call to Cloudflare. It
 * answers as Cloudflare documents its keys of test (« Testing », read 2026-11-27:
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/): the dummy token passes with
 * the secret that always passes, and fails with any other secret. Any other token fails.
 */
export const TURNSTILE_TEST_KEYS = {
  /** « Always passes », a visible widget. */
  siteKeyPasses: '1x00000000000000000000AA',
  /** « Always fails », a visible widget. */
  siteKeyFails: '2x00000000000000000000AB',
  /** « Always passes validation ». */
  secretPasses: '1x0000000000000000000000000000000AA',
  /** « Always fails validation ». */
  secretFails: '2x0000000000000000000000000000000AA',
  /** What a dummy site key gives the widget, and the only token a dummy secret takes. */
  dummyToken: 'XXXX.DUMMY.TOKEN.XXXX',
} as const;

export const verifyTestTurnstile: VerifyTurnstile = async ({ secret, token }) =>
  secret === TURNSTILE_TEST_KEYS.secretPasses && token === TURNSTILE_TEST_KEYS.dummyToken ? 'passed' : 'failed';
