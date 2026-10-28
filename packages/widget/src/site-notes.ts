/**
 * The notes of every page of the site, for « All pages » of the list (FRU-470).
 *
 * The widget reads the notes of one page, by `GET /feedback`, and the worker has no route that a
 * script reads the whole site by. So this list comes through a seam: a host that can read the site
 * gives `siteNotes` to `init`, and the list then offers « All pages ». A host that gives nothing gets
 * the list it had, « This page » alone.
 *
 * The shape is the one `GET /session/notes` answers (FRU-306), which the side panel of the extension
 * reads for « Whole site »: an excerpt, the page, the stage, the author, the date. Never the text of
 * a note, never its replies: a row opens the page of its note, and the widget reads it there.
 */

export const SITE_STAGES = ['new', 'todo', 'progress', 'done', 'closed'] as const;
export type SiteStage = (typeof SITE_STAGES)[number];

/** A note of the site, as the host answers it. */
export type SiteNote = {
  /** The id of the note: the link `#fruitback-note=<id>` opens it on its page (FRU-253). */
  note: string;
  /** A few words of the note. Text: the list writes it with `textContent`. */
  excerpt: string;
  page: { url: string; path: string };
  stage: SiteStage;
  /** Who wrote it, when the host says. */
  author?: string;
  /** The issue in the tracker, when the host lets this reader see it. */
  reference?: string;
  /** ISO 8601. */
  createdAt: string;
};

/** What the list asks: the words of its search, and the cursor of « Show more ». */
export type SiteQuery = { q?: string; cursor?: string };

/**
 * What a read answered. `signed-out`: the session of the host ended, and the list offers to sign in.
 * `unavailable`: this host cannot read the site here, and the list says so with no « Try again ».
 * `failed`: nothing answered.
 */
export type SiteRead =
  | { ok: true; notes: readonly SiteNote[]; total: number; next?: string }
  | { ok: false; reason: 'signed-out' | 'unavailable' | 'failed' };

/** The seam of `init`: one page of the notes of the site, the newest first. */
export type SiteNotes = (query: SiteQuery) => Promise<SiteRead>;

/** The link that opens a note on its page (FRU-253). The fragment of the page is kept. */
export function linkToNote(url: string, note: string): string {
  const parsed = new URL(url);
  const fragment = parsed.hash.replace(/^#/, '');
  const part = `fruitback-note=${encodeURIComponent(note)}`;
  parsed.hash = fragment === '' ? part : `${fragment}&${part}`;

  return parsed.href;
}
