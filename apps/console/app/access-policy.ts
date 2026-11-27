import type { DeletedNoteKeep, Site, Visibility, VisitorNoteLimit, VisitorRight, Writers } from './api.ts';

/**
 * What a visitor with no account may do on a site (FRU-703), as the tab « Access » sets it. The worker
 * checks each value; the console only shows and sends them.
 *
 * - `visibility`: who reads the notes, `members` or `everyone`.
 * - `writers`: who leaves one, `members` or `anyone`. It decides on every site since FRU-703.
 * - `visitorEdit`, `visitorDelete`: what a visitor may do to a note of their own.
 * - `notifyDone`: the e-mail when a note is done (FRU-604), offered where anybody writes.
 * - `visitorNotesPerHour`: the notes a visitor leaves in an hour, `0` for no limit (FRU-704), a line
 *   of the card « Safeguards ». It counts where anybody writes; a level does not change it.
 * - `holdVisitorNotes`: a note of a visitor waits for a member before it goes on (FRU-704), the same.
 * - `keepNoteVersions`: an edit or a deletion of a note keeps the version of before (FRU-704), the same.
 * - `deletedNotesKeepDays`: the days a note its visitor deleted is kept, then erased (FRU-704), the same.
 */
export type Access = {
  visibility: Visibility;
  writers: Writers;
  visitorEdit: VisitorRight;
  visitorDelete: VisitorRight;
  notifyDone: boolean;
  visitorNotesPerHour: VisitorNoteLimit;
  holdVisitorNotes: boolean;
  keepNoteVersions: boolean;
  deletedNotesKeepDays: DeletedNoteKeep;
};

/**
 * The levels of the card « Public access », in the order of the mockup. « Collaborate » comes with
 * FRU-707: it is drawn, and cannot be chosen.
 */
export const LEVELS = ['closed', 'read-only', 'contribute', 'collaborate'] as const;
export type Level = (typeof LEVELS)[number];
export type ChosenLevel = Exclude<Level, 'collaborate'>;

/** What each level that can be chosen sets: the table of the mockup. */
export const LEVEL_ACCESS: Readonly<
  Record<
    ChosenLevel,
    Omit<
      Access,
      'notifyDone' | 'visitorNotesPerHour' | 'holdVisitorNotes' | 'keepNoteVersions' | 'deletedNotesKeepDays'
    >
  >
> = {
  closed: { visibility: 'members', writers: 'members', visitorEdit: 'never', visitorDelete: 'never' },
  'read-only': { visibility: 'everyone', writers: 'members', visitorEdit: 'never', visitorDelete: 'never' },
  contribute: { visibility: 'everyone', writers: 'anyone', visitorEdit: 'while-open', visitorDelete: 'while-open' },
};

/**
 * The access of a site as the worker answered it. A worker of before sends no `writers`: a site that
 * everyone read took a note from anybody, and one of members from its members (FRU-330 made the
 * field). It sends no right of a visitor either: `never`, as a visitor could do neither.
 */
export function accessOf(site: Site): Access {
  return {
    visibility: site.visibility,
    writers: site.writers ?? (site.visibility === 'everyone' ? 'anyone' : 'members'),
    visitorEdit: site.visitorEdit ?? 'never',
    visitorDelete: site.visitorDelete ?? 'never',
    notifyDone: site.notifyDone === true,
    visitorNotesPerHour: site.visitorNotesPerHour ?? 0,
    holdVisitorNotes: site.holdVisitorNotes === true,
    keepNoteVersions: site.keepNoteVersions === true,
    // A worker of before kept a deleted note as long as the note: the longest of the list stands for it.
    deletedNotesKeepDays: site.deletedNotesKeepDays ?? 90,
  };
}

/**
 * The level that an access is, or `custom` when a cell of the table differs from every level. Where
 * only members write, a visitor has no note of their own: what they could do to one changes nothing,
 * and is not read.
 */
export function levelOf(access: Access): ChosenLevel | 'custom' {
  if (access.writers === 'members') return access.visibility === 'members' ? 'closed' : 'read-only';
  const contribute = LEVEL_ACCESS.contribute;
  if (
    access.visibility === contribute.visibility &&
    access.visitorEdit === contribute.visitorEdit &&
    access.visitorDelete === contribute.visitorDelete
  ) {
    return 'contribute';
  }

  return 'custom';
}

/** The access once a level is chosen: the table is filled; the e-mail and the safeguards stay as they were. */
export function withLevel(access: Access, level: ChosenLevel): Access {
  return { ...access, ...LEVEL_ACCESS[level] };
}

/**
 * Whether the draft holds what is stored: the rights of a visitor count everywhere, as the body sends
 * them; the e-mail and the notes of a visitor in an hour count only where anybody writes.
 */
export function sameAccess(draft: Access, stored: Access): boolean {
  const sent = accessBody('', draft);

  return (
    sent.visibility === stored.visibility &&
    sent.writers === stored.writers &&
    sent.visitorEdit === stored.visitorEdit &&
    sent.visitorDelete === stored.visitorDelete &&
    (draft.writers === 'members' ||
      (draft.notifyDone === stored.notifyDone &&
        draft.visitorNotesPerHour === stored.visitorNotesPerHour &&
        draft.holdVisitorNotes === stored.holdVisitorNotes &&
        draft.keepNoteVersions === stored.keepNoteVersions &&
        draft.deletedNotesKeepDays === stored.deletedNotesKeepDays))
  );
}

/**
 * The draft of the tab « Access » once the frame of the page holds another site (FRU-689): a read
 * again, « Save », or a link to another site. Another site starts from its own access. The same site
 * replaces a draft that nobody changed, and keeps one that somebody did: what was chosen and not
 * saved is never lost under the hand of the person.
 */
export function draftAfter(draft: Access, before: Site, site: Site): Access {
  if (before.id !== site.id || sameAccess(draft, accessOf(before))) return accessOf(site);

  return draft;
}

/**
 * What the console sends to `POST …/sites` for this access: what the table shows. Where only members
 * write, the table says « Never » for the rights of a visitor, and that is what is stored: a site
 * opened again later does not bring back rights nobody sees. The e-mail is sent where anybody writes
 * only, as FRU-604 did: the worker keeps it, and it does nothing elsewhere.
 */
export function accessBody(origin: string, access: Access): Record<string, unknown> {
  const writes = access.writers === 'anyone';

  return {
    url: origin,
    visibility: access.visibility,
    writers: access.writers,
    visitorEdit: writes ? access.visitorEdit : 'never',
    visitorDelete: writes ? access.visitorDelete : 'never',
    // FRU-704: as the e-mail: where only members write, no visitor is counted, and the value stays.
    ...(writes
      ? {
          notifyDone: access.notifyDone,
          visitorNotesPerHour: access.visitorNotesPerHour,
          holdVisitorNotes: access.holdVisitorNotes,
          keepNoteVersions: access.keepNoteVersions,
          deletedNotesKeepDays: access.deletedNotesKeepDays,
        }
      : {}),
  };
}

/**
 * Whether a visitor replies to a note (`replyAuthorFor` of the worker): a reply with no session needs
 * a site that everyone reads and anybody writes.
 */
export function visitorReplies(access: Access): boolean {
  return access.visibility === 'everyone' && access.writers === 'anyone';
}
