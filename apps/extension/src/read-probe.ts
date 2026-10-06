/**
 * Whether the worker answers a reader that carries no credential (FRU-66).
 *
 * The private-mode widget calls the worker from the page, with no session. On a worker that reads
 * `authenticated`, each read answers `401`, and the widget leaves the page as it is: no pin and no
 * reason, the same screen as a page with no note. The popup asks the worker the same question, and
 * says the answer.
 *
 * Behind a seam so `node --test` reaches each answer. The popup binds `fetch`.
 */

/** What the popup says when the worker wants a session for a read. */
export const READ_NEEDS_SESSION =
  'This worker answers a signed-in reader only, and private mode carries no session. Notes do not show on this site.';

/** The guide that says which mode can read an authenticated worker. */
export const MODES_GUIDE = 'https://sakuga-software.github.io/fruitback/modes.html';

export type ReadProbe = 'answers' | 'wants-a-session' | 'unknown';

export type ReadProbeSeams = {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ status: number; ok: boolean }>;
};

/** A popup is open for a moment. An answer that comes later than this is shown to nobody. */
export const READ_PROBE_TIMEOUT_MS = 4_000;

/**
 * Only a `401` is a statement. A worker that is down, slow or rate-limited says nothing about who can
 * read, so the popup stays silent for it rather than naming a cause it did not measure.
 */
export async function probeRead(
  site: { endpoint: string; clientId: string },
  pageUrl: string,
  seams: ReadProbeSeams,
): Promise<ReadProbe> {
  const url = `${site.endpoint}/feedback?url=${encodeURIComponent(pageUrl)}&client=${encodeURIComponent(site.clientId)}`;

  try {
    const response = await seams.fetch(url, { signal: AbortSignal.timeout(READ_PROBE_TIMEOUT_MS) });
    if (response.status === 401) return 'wants-a-session';

    return response.ok ? 'answers' : 'unknown';
  } catch {
    return 'unknown';
  }
}
