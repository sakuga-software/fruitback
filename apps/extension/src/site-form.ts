import { isSecureWorkerEndpoint, isWorkerEndpoint, normalizeWorkerEndpoint } from './endpoint.ts';
import { lendsSession } from './site-patterns.ts';
import { PAIR_PATH, type PairLink, parsePairLink } from './pair-link.ts';
import type { SiteConfig, SiteMode } from './sites.ts';

/**
 * The fields of a site entry, checked the same way in the popup and on the options page (FRU-43).
 *
 * Two copies of these rules would drift, and the bridge applies the endpoint rule again before it
 * mounts. An entry that only one editor refused would be stored, shown as **On**, and then ignored.
 */

export type SiteFields = { mode: SiteMode; endpoint: string; clientId: string };

export const PATTERN_PROBLEM =
  'Use an origin such as https://acme.dev, or a wildcard such as https://*.staging.acme.dev.';

/** For a rule that an earlier version stored. The options page shows it on the row. */
export const STALE_TEAM_WILDCARD =
  'A wildcard cannot serve team mode, so this rule runs nowhere. Remove it, and add one rule for each origin.';

/** For the previews of a site of a workspace, turned on in one click, whose worker does not list them now (FRU-103). */
export const PREVIEWS_NOT_PROVEN =
  'The workspace does not prove this domain now, so this rule runs nowhere. It runs again when the server says the domain is proven.';

/** For a rule that `storage.sync` cannot keep (FRU-264). The options page shows it on the row while the copy is on. */
export const TOO_LARGE_FOR_ACCOUNT =
  'This rule is too large for the account of this browser, which keeps at most 8 KB for one rule. It is not copied there, and it stays and works in this browser.';

export const WILDCARD_TEAM_PROBLEM =
  'A team-mode rule must name one origin. A wildcard would lend your session to every site it covers.';

/**
 * FRU-395: a pairing link pasted where the worker goes. The link is `<worker>/pair#<code>`, and the
 * worker is the address before `/pair`: a rule that reads `<worker>/pair` asks for
 * `<worker>/pair/feedback` and gets `404` on every page, with nothing on screen to say so.
 */
export const PAIRING_LINK_PROBLEM =
  'This is a connection link, not the address of a server. Use it to connect, and give the rule the address before /pair.';

/** The same address with no code, or with a fragment that is no code. */
export const PAIR_PATH_PROBLEM =
  'An address that ends in /pair, or that carries a #, is a connection link, not a server. Give the address before /pair.';

/** Whether this address is a pairing link, or the page of one, rather than a worker. */
export function isPairingAddress(value: string): boolean {
  try {
    const url = new URL(value);

    return url.hash !== '' || url.pathname.replace(/\/+$/, '').endsWith(PAIR_PATH);
  } catch {
    return false;
  }
}

/** Where the page of the extension pairs with a link (FRU-302): the fragment `options` reads. */
export function pairingFragment(link: PairLink): string {
  return `#workers?${new URLSearchParams({ worker: link.endpoint, code: link.code }).toString()}`;
}

/** The pairing link this address is, when it is a whole one: the form offers to pair with it. */
export function pairingLinkIn(value: string): PairLink | undefined {
  return parsePairLink(value.trim());
}

/**
 * What is wrong with these fields, for the rule stored under `pattern`, in the reporter's words, or
 * nothing.
 */
export function complaint(values: SiteFields, pattern: string): string {
  if (lendsSession(pattern, values)) return WILDCARD_TEAM_PROBLEM;
  if (values.endpoint === '') return 'The server address is required.';
  if (!isWorkerEndpoint(values.endpoint)) return 'The endpoint must be a full http:// or https:// URL.';
  if (isPairingAddress(values.endpoint)) {
    return pairingLinkIn(values.endpoint) === undefined ? PAIR_PATH_PROBLEM : PAIRING_LINK_PROBLEM;
  }
  // Trimmed, because an id made of spaces is an absent id. `importSites` passes the value of a file
  // here as it is, and a worker with several clients answers `client-required` for it (FRU-73).
  if (values.mode === 'private' && values.clientId.trim() === '') return 'The client id is required.';
  // Team mode cannot work without a session, and a session may not be opened over plain http — so
  // this entry would be stored, shown as **On**, and refuse every call. Say it here instead.
  if (values.mode === 'team' && !isSecureWorkerEndpoint(values.endpoint)) {
    return 'A team-mode server must be on https (localhost excepted).';
  }

  return '';
}

/**
 * The entry these fields describe.
 *
 * **The endpoint is stored in both modes**, and in team mode it is not what the widget is pointed
 * at — the site does that. It is what the relay checks the site's declaration against, so a page
 * cannot name another worker and be handed this reviewer's token for it. See `src/relay.ts`.
 */
export function siteFrom(values: SiteFields, enabled: boolean): SiteConfig {
  const endpoint = normalizeWorkerEndpoint(values.endpoint);

  return values.mode === 'team'
    ? { mode: 'team', endpoint, enabled }
    : { mode: 'private', endpoint, clientId: values.clientId.trim(), enabled };
}
