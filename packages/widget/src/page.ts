import { canonicalizePageUrl, type SeedEnv, type SeedPage, type SeedViewport } from '@fruitback/shared';

/**
 * The context around the pin: which page, seen how.
 *
 * `url` goes through `canonicalizePageUrl` here rather than being sent raw. The worker re-does it —
 * it cannot trust a client — but doing it on this side too means the widget queries the read path
 * with the same key the seed was stored under, instead of asking for a URL nobody planted anything
 * on.
 */

export function capturePage(view: Window): SeedPage {
  const url = canonicalizePageUrl(view.location.href);
  const page: SeedPage = { url, path: new URL(url).pathname };

  const title = view.document.title.trim();
  if (title.length > 0) page.title = title;

  return page;
}

/**
 * A link that opens a note on its page (FRU-253): `<page>#fruitback-note=<id>`.
 *
 * The fragment is the site's, and the widget reads one part of it: `fruitback-note=<id>`, alone or
 * after an `&`. So `#pricing` is not ours, and `#pricing&fruitback-note=sd_1` is the site's
 * `#pricing` with our part after it. The id is what the note is called anywhere: its own id, the
 * id of its issue, or its identifier.
 */
const LINK_KEY = 'fruitback-note=';

/** The id a fragment asks for, or `undefined` when the fragment does not ask for a note. */
export function linkedNote(hash: string): string | undefined {
  const part = hash
    .replace(/^#/, '')
    .split('&')
    .find((each) => each.startsWith(LINK_KEY));
  if (part === undefined) return undefined;

  let id = part.slice(LINK_KEY.length);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A fragment anybody can type: one that does not decode is read as it is written.
  }

  return id === '' ? undefined : id;
}

/** The same fragment without our part: `''` when nothing of the site is left, a `#…` otherwise. */
export function withoutLinkedNote(hash: string): string {
  const rest = hash
    .replace(/^#/, '')
    .split('&')
    .filter((each) => !each.startsWith(LINK_KEY))
    .join('&');

  return rest === '' ? '' : `#${rest}`;
}

/**
 * `innerWidth`/`innerHeight`, not `screen`: what matters when re-reading a note is how much of the
 * page the reporter could actually see.
 */
export function captureViewport(view: Window): SeedViewport {
  const viewport: SeedViewport = { width: view.innerWidth, height: view.innerHeight };

  // Kept even at 1 — it is an observation, not a default, and the screenshot work (FRU-6) needs it
  // to read a capture taken on a retina screen.
  if (Number.isFinite(view.devicePixelRatio)) viewport.dpr = view.devicePixelRatio;

  return viewport;
}

/**
 * The "it works on my machine" fields. Deliberately thin: the widget runs on client sites, and a
 * seed is a Linear issue anyone on the workspace can read, so this collects what helps reproduce a
 * visual bug and nothing that identifies a person.
 */
export function captureEnv(view: Window): SeedEnv {
  const navigator = view.navigator;
  const env: SeedEnv = {};

  if (navigator.userAgent) env.userAgent = navigator.userAgent;
  if (navigator.language) env.locale = navigator.language;

  const platform = readPlatform(navigator);
  if (platform !== undefined) env.platform = platform;

  return env;
}

/** `navigator.platform` is deprecated; the client hint replaces it where the browser exposes one. */
function readPlatform(navigator: Navigator): string | undefined {
  const hinted = (navigator as { userAgentData?: { platform?: unknown } }).userAgentData?.platform;
  if (typeof hinted === 'string' && hinted.length > 0) return hinted;

  return navigator.platform || undefined;
}
