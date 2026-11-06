import type { Stage } from '../stages';
import type { StatusChoice } from '../note-status';

// The model of the Notes screen (FRU-614): what the index of the notes answers, and its pages.

/** Who left a note, as the index of the notes says it (FRU-244). A name only for an account of the workspace. */
export type NoteAuthor = {
  kind: 'you' | 'owner' | 'admin' | 'member' | 'guest' | 'former-member' | 'verified' | 'anonymous';
  name?: string;
};

/** Where a note went: Fruitback, a connector (its id and its name), or a connector removed since. */
export type NotePlace = {
  kind: 'fruitback' | 'linear' | 'rest' | 'github' | 'removed';
  connector?: string;
  label?: string;
};

/** A note of the index (FRU-237, FRU-244): its first 64 characters, never its text (Q6). */
export type IndexedNote = {
  id: string;
  excerpt: string;
  page: { url: string; host: string; path: string };
  site: { id: string };
  stage: Stage;
  author: NoteAuthor;
  /**
   * The id the widget gave the note, which its link opens (`#fruitback-note=`, FRU-253). Absent from a
   * worker that does not send it: the link then names the issue, or opens the page alone.
   */
  note?: string;
  /** Where it went, its reference in the tracker and the address of the issue: not for a guest. */
  place?: NotePlace;
  ref?: string;
  url?: string;
  /** A note that an address did not take yet: `gave-up` when the worker stopped trying. */
  delivery?: { id: string; state: 'waiting' | 'gave-up' };
  /**
   * FRU-384: the status of a note the worker keeps (`own:<key>`), and whether this person may change
   * it: its author, or an owner or an admin. Absent for a note of a tracker, whose status is the tracker's.
   */
  status?: string;
  canSetStatus?: boolean;
  createdAt: string;
};

export type NotesAnswer = {
  notes: IndexedNote[];
  total: number;
  /** `byPlace` and `undelivered` go to whoever sees the tracker: not to a guest. */
  counts: {
    all: number;
    byPlace?: Readonly<Record<string, number>>;
    /** The notes of the list by stage, every page (FRU-551): the counts of the groups of the table. */
    byStage?: Readonly<Partial<Record<Stage, number>>>;
    undelivered?: number;
  };
  next?: string;
  /** The statuses of the worker's store of each site with a note it keeps on this page (FRU-384). */
  statuses?: Readonly<Record<string, StatusChoice[]>>;
};

/** The filters of the page, in its address: a reload keeps the view, and a link shares it. */
export const FILTERS = ['place', 'site', 'stage', 'mine', 'q'] as const;
export type Filter = (typeof FILTERS)[number];

/** How the notes are drawn (FRU-436): the table, or the board, as `?view=board` keeps it. */
export type View = 'table' | 'board';

/**
 * The groups of the table, in the order the worker reads them by status (FRU-551, as Linear): what
 * is being done, what is to do, what is new, what was closed without being done, then what is done.
 */
export const GROUPS: readonly Stage[] = ['progress', 'todo', 'new', 'closed', 'done'];

/** The notes of a page in their groups, each group in the order of the page. An empty group is not drawn. */
export function groupsOf<T extends { stage: Stage }>(notes: readonly T[]): { stage: Stage; notes: T[] }[] {
  return GROUPS.map((stage) => ({ stage, notes: notes.filter((note) => note.stage === stage) })).filter(
    (group) => group.notes.length > 0,
  );
}

/** The notes of a page (FRU-587): the default of the worker, asked for by name. */
export const NOTES_PER_PAGE = 25;

/** The page of the note at `from`, from 1. */
export const pageOf = (from: number) => Math.floor((from - 1) / NOTES_PER_PAGE) + 1;
