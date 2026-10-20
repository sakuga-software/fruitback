import { SEED_STAGES, type Seed, type SeedIssue, type SeedStage } from '@fruitback/shared';

/**
 * The index of the notes of a workspace (FRU-237): one row for each note this worker planted for a
 * site of a workspace, wherever the note went. It is what the console counts, and what it lists.
 *
 * **What it keeps, and only that** (Mathieu, 2026-10-13: « oui sans le texte », then « les 64 premiers
 * caractères juste pour l'identification des notes »):
 * - the site, the workspace, the id the widget gave the note, the address of its page;
 * - **an excerpt of the text: its first `EXCERPT_LENGTH` characters, never more** (`excerptOf`);
 * - the stage, as the tracker last said it, and when it was last said;
 * - by which way it came (`script` or `extension`), when the worker knew it;
 * - who left it, as a kind (`visitor`, `site`, `member`) and, for a member, the account. **A name
 *   that a visitor typed is not kept**: it is a claim, and the screen shows « Visitor »;
 * - where it went: the connector, or the worker's own store, and the reference the tracker gave.
 *
 * The rest of a note (its whole text, the reporter's address, the anchor, the environment, the
 * replies) stays where it went: in the tracker, or in the worker's own store, which the index does
 * not copy. `docs/privacy.md` names each column.
 */

/** How many characters of the text the index keeps. One constant, and `notes-index.test.ts` holds it. */
export const EXCERPT_LENGTH = 64;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The first characters of a note, for a person to tell one note from another.
 *
 * Spaces and line breaks become one space, and the ends are trimmed. **At most `EXCERPT_LENGTH`
 * characters, counted as code points**, and cut between two graphemes: a family emoji or a letter
 * with its accent is kept whole or not at all, so the excerpt can be shorter. Never longer.
 */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  let kept = '';
  let length = 0;
  for (const { segment } of graphemes.segment(flat)) {
    const size = [...segment].length;
    if (length + size > EXCERPT_LENGTH) break;
    kept += segment;
    length += size;
  }

  return kept.trimEnd();
}

/**
 * By which way a note came. `extension`: the worker verified the token of a session of an extension
 * with it. `script`: anything else, the extension of a reviewer with no session among them, since
 * nothing tells them apart. Nothing more is asked of the browser.
 */
export type Channel = 'script' | 'extension';

/**
 * Who left a note, as the index keeps it. `member`: a session of the workspace, and its account.
 * `site`: a token the site signed. `verified`: a note from before the index, whose reporter the
 * worker verified, by a way the index did not see. `visitor`: anything else, a name typed or not.
 */
export type AuthorKind = 'visitor' | 'site' | 'member' | 'verified';

/** Where a note went: the store of the worker, or a connector of the workspace. */
export type Place = { kind: 'fruitback' } | { kind: 'connector'; connector: string };

/** One note, as it is written in the index when the worker planted it. */
export type NoteEntry = {
  workspace: string;
  site: string;
  seed: Seed;
  channel: Channel;
  author: { kind: AuthorKind; account?: string };
  place: Place;
  issue: { identifier: string; url?: string };
  /** The stage of a note that was just planted. */
  stage: SeedStage;
};

/** The notes of one site, as the console and the extension read them. */
export type SiteNotes = {
  notes: Record<SeedStage, number>;
  lastNoteAt?: string;
  via: Channel[];
  /** The oldest instant at which a tracker confirmed the stage of a note of this site. */
  asOf?: string;
};

/** No note: five zeros, and nothing else. */
export function noNotes(): SiteNotes {
  return { notes: Object.fromEntries(SEED_STAGES.map((stage) => [stage, 0])) as Record<SeedStage, number>, via: [] };
}

export type NoteIndex = {
  /** Writes the notes just planted. A note that is there already is left as it is. */
  record(entries: readonly NoteEntry[], now: number): Promise<void>;
  /**
   * What a read of one page of a site learned (FRU-237): the stage of each note as its store answers
   * it now. A note of the site that the index does not hold yet, planted before it, is written with
   * what the read says and nothing else: no way, and a visitor for anyone the site did not verify.
   */
  refresh(workspace: string, site: string, place: Place, issues: readonly SeedIssue[], now: number): Promise<void>;
  /** The notes of each site of a workspace that has some. A site with none is absent. */
  summary(workspace: string): Promise<Map<string, SiteNotes>>;
  /**
   * The deliveries of each site of a workspace that are not delivered: waiting for an attempt, or
   * given up (FRU-122). A delivery that arrived is removed, so it is not counted.
   */
  undelivered(workspace: string): Promise<Map<string, number>>;
  /**
   * Removes the rows of these notes, and answers what they held. `notes`: the notes `forget` deleted
   * from the worker's store, each by its reference **and** the id the widget gave it. `seeds`: notes
   * that went to a tracker, by the id the widget gave them, which their issue carries (FRU-237).
   * `dryRun` removes nothing and answers the same rows.
   *
   * The account of a member goes from the index by itself: `author_account_id` is a foreign key to
   * the account, `ON DELETE SET NULL`.
   */
  forget(which: ForgetIndex, options?: { dryRun?: boolean }): Promise<IndexedNote[]>;
  /**
   * One page of the notes of a workspace (FRU-244), the newest first, with the counts of the filter.
   * It reads the index and nothing else: **a search finds what the index keeps** (the excerpt, the
   * page, the origin of the site, the stage, the reference), never the rest of a text.
   */
  list(workspace: string, query: NoteQuery): Promise<NoteList>;
  /**
   * The account that left each of these notes of a site, for the notes a member left (FRU-294). A note
   * of a visitor, of a token of the site, or of an account that is gone is absent. What decides who
   * may confirm or reopen a note, and which notes are a reader's own (`mine`).
   */
  authors(workspace: string, site: string, seeds: readonly string[]): Promise<Map<string, string>>;
  /** The delivery of one note that did not arrive (FRU-244), for « Send again ». */
  deliveryOf(workspace: string, site: string, seed: string): Promise<{ connector: string; id: string } | undefined>;
};

/** The smallest and the largest page of `list`, and the page when none is asked. */
export const PAGE_SIZES = { min: 8, max: 50, default: 25 } as const;

/** Where a page starts: after this note, in the order of `list`. */
export type NoteCursor = { at: number; site: string; seed: string };

/** What `list` filters on. Each field narrows; an absent one does not. */
export type NoteQuery = {
  site?: string;
  stage?: SeedStage;
  /** `fruitback`, or the id of a connector of the workspace. */
  place?: string;
  /** The account whose own notes are asked (`mine`). */
  author?: string;
  /** Words, each in one of the fields the index keeps. At most `QUERY_LENGTH` characters. */
  q?: string;
  /**
   * Whether `q` reads the reference in the tracker too. A caller who does not see the tracker must
   * not find a reference by trying words in a search: `false` for a guest.
   */
  searchesReference?: boolean;
  /**
   * The sites the caller may read. Absent: every site of the workspace, as every role reads them
   * today. The guest of one site (Q3 of FRU-230) narrows it here, and the counts with it.
   */
  sites?: readonly string[];
  after?: NoteCursor;
  limit: number;
};

/** The longest search `list` takes. */
export const QUERY_LENGTH = 200;

/** What `list` searches, in the order the console names them. */
export const SEARCHED = ['excerpt', 'page', 'site', 'stage', 'reference'] as const;

/** What `list` searches for a caller who does not see the tracker. */
export const SEARCHED_WITHOUT_TRACKER = ['excerpt', 'page', 'site', 'stage'] as const;

/** A note of a page of `list`: the row of the index, with what the workspace knows of it now. */
export type ListedNote = {
  site: string;
  seed: string;
  pageUrl: string;
  excerpt: string;
  stage: string;
  channel: Channel | null;
  author: {
    kind: AuthorKind;
    account?: string;
    /** The name the account has now, and its role here, when it is still a member. */
    member?: { name: string; role: string };
  };
  /** `connector` with no id: the connector was removed since. */
  place: { kind: 'fruitback' } | { kind: 'connector'; connector?: { id: string; kind: string; label: string } };
  reference?: string;
  referenceUrl?: string;
  createdAt: number;
  checkedAt: number;
  /** Its delivery that did not arrive, when it went to a receiving connector. */
  delivery?: { id: string; attempts: number; nextAt?: number; lastStatus?: number };
};

export type NoteList = {
  notes: ListedNote[];
  /** The notes of the whole filter, every page. */
  total: number;
  /** The notes of the filter without `place`, by place: `fruitback`, a connector id, or `removed`. */
  byPlace: Map<string, number>;
  /** The notes of the filter without `place` whose delivery did not arrive. */
  undelivered: number;
  /** Where the next page starts; absent on the last one. */
  next?: NoteCursor;
};

export type ForgetIndex = { notes: readonly { identifier: string; seed: string }[] } | { seeds: readonly string[] };

/** A row of the index, as `forget` lists it to an operator. */
export type IndexedNote = {
  site: string;
  seed: string;
  pageUrl: string;
  excerpt: string;
  reference?: string;
  createdAt: number;
};

/** The author of a note, from what the worker verified when it took it. */
export function authorOf(seed: Seed, session: boolean): { kind: AuthorKind; account?: string } {
  if (seed.reporter?.verified !== true) return { kind: 'visitor' };
  if (session && seed.reporter.id !== undefined) return { kind: 'member', account: seed.reporter.id };

  return { kind: 'site' };
}
