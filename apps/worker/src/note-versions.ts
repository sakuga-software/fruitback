/**
 * The versions of a note (FRU-704): « Keep every version » of the card « Safeguards ». On a site that
 * keeps them (`ClientConfig.keepNoteVersions`), the worker writes a version before each change that
 * takes words away from the team:
 *
 * - `edit`: the author changes the text of their note (`POST /feedback/<id>/text`). The version holds
 *   the text **before** the edit. The text after it is the note's, or the next version's.
 * - `delete`: the author withdraws their note, or deletes it as a visitor (`POST
 *   /feedback/<id>/withdraw`). The version holds the text the note had then.
 *
 * - **Who reads them**: a role that sees the tracker (member, admin, owner), on the page of the note in
 *   the console (`GET …/notes/<note>`). A guest reads none, and a visitor none: the widget only tells a
 *   visitor who edits that the team keeps the text of before (`versionsKept`).
 * - **Who wrote them**: `member` with their account, read again at each read for its name, or
 *   `visitor`, named by nothing more. No key, no digest, no address.
 * - **How long**: as long as the note is in the index of its site, `NOTE_VERSION_LIMIT` at most for
 *   one note (the oldest goes first). A row goes with its note, its site and its workspace.
 * - **What it costs**: a version is written before the change, in one statement, and taken back when
 *   the change does not happen (`forget`). A store of versions that does not answer is a store that
 *   does not answer: `502`, and nothing changes.
 */
export type NoteVersionKind = 'edit' | 'delete';

export type NoteVersion = {
  id: string;
  kind: NoteVersionKind;
  /** An edit: the text before it. A deletion: the text the note had then. */
  text: string;
  /**
   * Who did it. A member by their account, and the name and the role it has now while it is still a
   * member of the workspace, as `ListedNote.author` names one. A visitor by nothing more.
   */
  author: { kind: 'member' | 'visitor'; account?: string; member?: { name: string; role: string } };
  at: number;
};

export type NewNoteVersion = Omit<NoteVersion, 'id' | 'author'> & {
  workspace: string;
  site: string;
  note: string;
  author: { kind: 'member'; account: string } | { kind: 'visitor' };
};

export type NoteVersions = {
  /**
   * Keeps a version, and lets go of the oldest of its note past `NOTE_VERSION_LIMIT`. Answers its id, for
   * `forget`. `undefined`: the note is not in the index of its site, and nothing is written.
   */
  keep(version: NewNoteVersion): Promise<string | undefined>;
  /** Takes back a version whose change did not happen: the store refused it, or failed. */
  forget(site: string, note: string, id: string): Promise<void>;
  /** The versions of a note of the workspace, oldest first. */
  list(workspace: string, site: string, note: string): Promise<NoteVersion[]>;
};

/**
 * The most versions one note keeps: the oldest goes past it. An edit of a visitor counts with their
 * replies of the minute (`checkReplyLimit`), so this is reached in no less than an hour, and a note
 * holds `NOTE_MAX_LENGTH` characters: 50 versions are 250 KB at most.
 */
export const NOTE_VERSION_LIMIT = 50;
