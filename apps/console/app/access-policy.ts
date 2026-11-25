import type { Site, Visibility, VisitorRight, Writers } from './api.ts';

/**
 * What a visitor with no account may do on a site (FRU-703), as the tab « Access » sets it. The worker
 * checks each value; the console only shows and sends them.
 *
 * - `visibility`: who reads the notes, `members` or `everyone`.
 * - `writers`: who leaves one, `members` or `anyone`. It decides on every site since FRU-703.
 * - `visitorEdit`, `visitorDelete`: what a visitor may do to a note of their own.
 * - `notifyDone`: the e-mail when a note is done (FRU-604), offered where anybody writes.
 */
export type Access = {
  visibility: Visibility;
  writers: Writers;
  visitorEdit: VisitorRight;
  visitorDelete: VisitorRight;
  notifyDone: boolean;
};

/**
 * The levels of the card « Public access », in the order of the mockup. « Collaborate » comes with
 * FRU-707: it is drawn, and cannot be chosen.
 */
export const LEVELS = ['closed', 'read-only', 'contribute', 'collaborate'] as const;
export type Level = (typeof LEVELS)[number];
export type ChosenLevel = Exclude<Level, 'collaborate'>;

/** What each level that can be chosen sets: the table of the mockup. */
export const LEVEL_ACCESS: Readonly<Record<ChosenLevel, Omit<Access, 'notifyDone'>>> = {
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

/** The access once a level is chosen: the table is filled, and the e-mail switch stays as it was. */
export function withLevel(access: Access, level: ChosenLevel): Access {
  return { ...access, ...LEVEL_ACCESS[level] };
}

/**
 * Whether the draft holds what is stored: the rights of a visitor count everywhere, as the body sends
 * them; the e-mail counts only where anybody writes.
 */
export function sameAccess(draft: Access, stored: Access): boolean {
  const sent = accessBody('', draft);

  return (
    sent.visibility === stored.visibility &&
    sent.writers === stored.writers &&
    sent.visitorEdit === stored.visitorEdit &&
    sent.visitorDelete === stored.visitorDelete &&
    (draft.writers === 'members' || draft.notifyDone === stored.notifyDone)
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
    ...(writes ? { notifyDone: access.notifyDone } : {}),
  };
}

/**
 * Whether a visitor replies to a note (`replyAuthorFor` of the worker): a reply with no session needs
 * a site that everyone reads and anybody writes.
 */
export function visitorReplies(access: Access): boolean {
  return access.visibility === 'everyone' && access.writers === 'anyone';
}
