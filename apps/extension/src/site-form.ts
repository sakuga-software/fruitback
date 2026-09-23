import { isSecureWorkerEndpoint, isWorkerEndpoint, normalizeWorkerEndpoint } from './endpoint.ts';
import type { SiteConfig, SiteMode } from './sites.ts';

/**
 * The fields of a site entry, checked the same way in the popup and on the options page (SKG-536).
 *
 * Two copies of these rules would drift, and the bridge applies the endpoint rule again before it
 * mounts. An entry that only one editor refused would be stored, shown as **On**, and then ignored.
 */

export type SiteFields = { mode: SiteMode; endpoint: string; clientId: string };

export const PATTERN_PROBLEM =
  'Use an origin such as https://acme.dev, or a wildcard such as https://*.staging.acme.dev.';

/** What is wrong with these fields, in the reporter's words, or nothing. */
export function complaint(values: SiteFields): string {
  if (values.endpoint === '') return 'The worker endpoint is required.';
  if (!isWorkerEndpoint(values.endpoint)) return 'The endpoint must be a full http:// or https:// URL.';
  // Trimmed, because an id made of spaces is an absent id. `importSites` passes the value of a file
  // here as it is, and a worker with several clients answers `client-required` for it (SKG-612).
  if (values.mode === 'private' && values.clientId.trim() === '') return 'The client id is required.';
  // Team mode cannot work without a session, and a session may not be opened over plain http — so
  // this entry would be stored, shown as **On**, and refuse every call. Say it here instead.
  if (values.mode === 'team' && !isSecureWorkerEndpoint(values.endpoint)) {
    return 'A team-mode worker must be on https (localhost excepted).';
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
