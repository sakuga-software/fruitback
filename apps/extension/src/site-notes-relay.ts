import type { SiteNote as PageSiteNote, SiteRead as PageSiteRead } from '@fruitback/widget';
import { isSecureWorkerEndpoint } from './endpoint.ts';
import { type SiteNote, type SiteNotesSeams, readSiteNotes } from './site-notes.ts';
import type { SiteConfig } from './sites.ts';

/**
 * « All pages » of the widget the extension mounts (FRU-470): one page of the notes of the site of
 * the tab, read here with the session of the reviewer, as the side panel reads « Whole site »
 * (`GET /session/notes`, FRU-306).
 *
 * **The page can ask for this too**: the widget the extension mounts lives in the page's world, so
 * a script of the site can post the same request and read the answer. What it gets is what the
 * side panel shows the reviewer for that site: an excerpt of 64 characters at most, the page, the
 * stage, the author's name, the date. Never the text of a note, never a reply, never a token. So
 * the background decides everything, from what the page cannot write:
 *
 * - the **origin** comes from the sender the browser reports, never from the message;
 * - the **site** is the entry the reviewer stored for that origin: switched on, in team mode, with
 *   the widget mounted by the extension. Its id is the one that entry names, never one of the page;
 * - the **endpoint** is that entry's, `https` or loopback, as for the relay;
 * - the **session** is the reviewer's for that endpoint. With none, nothing is read.
 *
 * The page names the words of a search and the cursor of « Show more », and nothing else.
 */

export type SiteNotesRelaySeams = Pick<SiteNotesSeams, 'ensureAccess' | 'renewAccess' | 'fetcher'> & {
  readSite: (origin: string) => Promise<SiteConfig | undefined>;
};

/** What the page may say: the words and the cursor. */
export type PageSiteQuery = { q?: string; cursor?: string };

export type SiteNotesRelay = (query: PageSiteQuery, origin: string | undefined) => Promise<PageSiteRead>;

const UNAVAILABLE: PageSiteRead = { ok: false, reason: 'unavailable' };

export function createSiteNotesRelay(seams: SiteNotesRelaySeams): SiteNotesRelay {
  // Never rejects: the bridge answers the page with what this gives, whatever the storage does.
  return async (query, origin) => {
    try {
      if (origin === undefined) return UNAVAILABLE;
      const site = await seams.readSite(origin);
      if (site === undefined || !site.enabled || site.mode !== 'team' || site.mount === undefined) return UNAVAILABLE;
      if (!isSecureWorkerEndpoint(site.endpoint)) return UNAVAILABLE;

      const read = await readSiteNotes(
        site.endpoint,
        {
          site: site.mount.clientId,
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        },
        seams,
      );
      if (!read.ok) return read;

      return {
        ok: true,
        notes: read.page.notes.map(forThePage),
        total: read.page.total,
        ...(read.page.next === undefined ? {} : { next: read.page.next }),
      };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  };
}

/**
 * A note as the widget lists it. The link to the tracker stays in the side panel: the widget has no
 * use for it, and the page then never holds it.
 */
function forThePage(note: SiteNote): PageSiteNote {
  return {
    note: note.note,
    excerpt: excerptAtMost(note.excerpt),
    page: note.page,
    stage: note.stage,
    ...(note.author === undefined ? {} : { author: note.author }),
    ...(note.reference === undefined ? {} : { reference: note.reference }),
    createdAt: note.createdAt,
  };
}

/**
 * The most an excerpt holds when it reaches the page: `EXCERPT_LENGTH` of the worker's index, in code
 * points. The worker never sends more; this holds the promise of SECURITY.md without trusting it,
 * since the answer crosses into the page's world (review of #645).
 */
export const PAGE_EXCERPT_MAX = 64;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** At most `PAGE_EXCERPT_MAX` code points, cut between two graphemes, as the worker cuts it. */
export function excerptAtMost(text: string): string {
  if ([...text].length <= PAGE_EXCERPT_MAX) return text;
  let kept = '';
  let length = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = [...segment].length;
    if (length + size > PAGE_EXCERPT_MAX) break;
    kept += segment;
    length += size;
  }

  return kept.trimEnd();
}
