import {
  type Note,
  type NoteAttachment,
  type NoteComment,
  type NotePage,
  type NoteIssue,
  type NoteStage,
  NOTE_STAGES,
  canonicalizePageUrl,
  noteAttachmentSchema,
  parseNote,
} from '@fruitback/shared';
import { type FruitbackTransport, type TransportResponse, bytesOfBase64 } from './transport.ts';

/**
 * Where the notes go when no worker takes them (FRU-646): functions of the host.
 *
 * `write` is required. Every other function is optional, and the widget hides what it serves when it
 * is absent (FRU-647): no `read`, no pin comes back; no `reply`, no field to reply; no `check`, no
 * « Looks fixed » / « Still wrong »; no `edit` or `withdraw`, no such item in the menu of the author;
 * no `attach`, no file in the composer. The widget offers no place to choose and no address to ask
 * with `notes`.
 */
export type FruitbackNotes = {
  /**
   * Keeps one note, and answers its id. The same note can come twice, after a send that failed: the
   * id of the note (`note.id`) is the same, so keep it once. A rejection, or an answer with no `id`,
   * is a send that failed: the composer keeps the text and says so. `sent.attachments`: the ids that
   * `attach` gave for the files of this note, in their order; empty for a note with no file.
   */
  write(note: Note, sent: NoteSent): Promise<{ id: string }>;
  /** The notes of one page, for its pins. Asked with the address of the page, as the notes keep it. */
  read?(page: NotePage): Promise<StoredNote[]>;
  /**
   * Keeps a reply under the note whose id `write` gave (FRU-647), and answers the id of the reply.
   * `author` is the name the person typed in the widget, when they typed one. A rejection, or an
   * answer with no `id`, is a reply that failed: the field keeps the text and says so.
   */
  reply?(id: string, reply: NewNoteReply): Promise<{ id: string }>;
  /**
   * Keeps the verdict of the author of a note at `done` (FRU-647): `fixed` (« Looks fixed ») or `wrong`
   * (« Still wrong », with what is still wrong in `text`). After `wrong`, the next `read` gives the note
   * at `new`, as the worker does. Offered on a note `mine` at `done` that no `fixed` verdict confirmed.
   */
  check?(id: string, verdict: NewNoteVerdict): Promise<void>;
  /** Keeps the new text of a note (FRU-647). Offered to its author (`mine`) while it is open. */
  edit?(id: string, text: string): Promise<void>;
  /**
   * Withdraws a note (FRU-647): the next `read` gives it at `closed`, or not at all. Offered to its
   * author (`mine`) while it is open.
   */
  withdraw?(id: string): Promise<void>;
  /**
   * Keeps one file of a note that is being written (FRU-647), and answers its id, which `write` gets
   * in `sent.attachments`. A file of a note that is never sent is never named by `write`. A rejection,
   * or an answer with no `id`, is a file that did not go: the composer says so.
   */
  attach?(file: File): Promise<{ id: string }>;
};

/** What `write` gets beside the note (FRU-647). */
export type NoteSent = { attachments: string[] };

/** A reply written from the page (FRU-647). */
export type NewNoteReply = { text: string; author?: string };

/** The verdict of the author on a note at `done` (FRU-647). */
export type NoteVerdict = 'fixed' | 'wrong';

/** A verdict as `check` gets it. `author`: the name on the note, when it has one. */
export type NewNoteVerdict = { verdict: NoteVerdict; text?: string; author?: string };

/**
 * A note as `read` gives it back. `id` is the id `write` gave. `stage` is where the note is; left out,
 * the pin says « New ».
 *
 * FRU-647: `mine` says that the reader wrote the note. Only then does its thread offer `edit`,
 * `withdraw` and the verdict. `replies`, oldest first, are the conversation of its thread. `attachments`
 * are the files the note has; the thread says how many.
 */
export type StoredNote = {
  id: string;
  note: Note;
  stage?: NoteStage;
  mine?: boolean;
  replies?: StoredReply[];
  attachments?: StoredAttachment[];
};

/**
 * A reply as `read` gives it back (FRU-647). `author` is the name the thread shows; left out, the
 * thread says « Anonymous ». `mine`: the reader wrote it from the page. The thread then says « you »
 * beside the name, and never takes it for a reply of the team (« Léa marked it done »). `verdict`:
 * the author of the note wrote it as a verdict, with `text` typed beside it. The newest verdict
 * `fixed` on a note at `done` is what confirms it.
 */
export type StoredReply = {
  id: string;
  text: string;
  createdAt: string;
  author?: string;
  mine?: boolean;
  verdict?: NoteVerdict;
};

/** A file of a note as `read` gives it back (FRU-647). The widget shows no file: only how many. */
export type StoredAttachment = { name: string; url?: string };

/** The words the transport writes in a reply, in the language of the reader (FRU-647). */
export type NotesWords = (key: 'thread.anonymous' | 'thread.you') => string;

const ENGLISH_WORDS: NotesWords = (key) => ({ 'thread.anonymous': 'Anonymous', 'thread.you': 'you' })[key];

/**
 * The address the calls of a widget with `notes` are written to. `.invalid` is a name that no DNS
 * resolves (RFC 2606): if a call took another way than the transport of `notesTransport`, it fails
 * and sends nothing.
 */
export const NOTES_ENDPOINT = 'https://notes.fruitback.invalid';

/** The stages where the author may still edit or withdraw a note, as the worker says (FRU-605). */
const OPEN_STAGES: ReadonlySet<NoteStage> = new Set(['new', 'todo', 'progress']);

/** What the transport knows of a note from the last read that gave it: the writes about it check it. */
type Known = { note: Note; stage: NoteStage; mine: boolean; checked: boolean };

/**
 * The calls of the widget, answered by `notes` as the worker would answer them. A call whose function
 * is absent gets a `404`; the read says nothing of it, so the widget does not offer it.
 *
 * `words` gives the words of the reader for a reply with no name and for a verdict: the widget shows
 * a reply as it comes.
 */
export function notesTransport(notes: FruitbackNotes, words: NotesWords = ENGLISH_WORDS): FruitbackTransport {
  const known = new Map<string, Known>();
  /** The id of each file in transit, as the widget names it, to the id `attach` gave. */
  const files = new Map<string, string>();

  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== NOTES_ENDPOINT || (request.method === 'GET' && url.pathname !== '/feedback')) {
      return answer(404, { error: 'not-found' });
    }
    if (request.method === 'GET') return readPage(notes, known, words, url.searchParams.get('url'));
    if (url.pathname === '/feedback') return writeNote(notes, files, request.body, url.searchParams.get('attachments'));
    if (url.pathname === '/attachments') {
      return attachFile(notes, files, request.body, url.searchParams.get('name'), request.headers['Content-Type']);
    }
    const about = /^\/feedback\/([^/]+)\/(replies|check|text|withdraw)$/u.exec(url.pathname);
    if (about === null) return answer(404, { error: 'not-found' });
    const id = decodeURIComponent(about[1] ?? '');
    const body = jsonOf(request.body);
    if (body === undefined) return answer(400, { error: 'invalid-body' });
    switch (about[2]) {
      case 'replies':
        return replyTo(notes, known, words, id, body);
      case 'check':
        return checkNote(notes, known, words, id, body);
      case 'text':
        return editNote(notes, known, id, body);
      default:
        return withdrawNote(notes, known, id);
    }
  };
}

async function readPage(
  notes: FruitbackNotes,
  known: Map<string, Known>,
  words: NotesWords,
  address: string | null,
): Promise<TransportResponse> {
  if (address === null) return answer(400, { error: 'invalid-url' });
  const page = canonicalOrNothing(address);
  if (page === undefined) return answer(400, { error: 'invalid-url' });
  // FRU-647: the read says what the functions of the host offer, as the worker says what it takes.
  const offers = {
    ...(notes.reply === undefined ? {} : { canReply: true }),
    ...(notes.attach === undefined ? {} : { canAttach: true }),
  };
  if (notes.read === undefined) return answer(200, { issues: [], ...offers });
  let stored: unknown;
  try {
    stored = await notes.read({ url: page, path: new URL(page).pathname });
  } catch {
    return answer(503, { error: 'read-failed' });
  }
  const issues = issuesOf(notes, words, stored, page);
  for (const issue of issues) {
    known.set(issue.id, {
      note: issue.note,
      stage: issue.stage,
      mine: issue.mine === true,
      checked: issue.checked !== undefined,
    });
  }

  return answer(200, { issues, ...offers });
}

async function writeNote(
  notes: FruitbackNotes,
  files: Map<string, string>,
  body: string | undefined,
  attachments: string | null,
): Promise<TransportResponse> {
  const parsed = jsonOf(body);
  if (parsed === undefined) return answer(400, { error: 'invalid-note' });
  const note = parseNote(parsed);
  if (!note.ok) return answer(400, { error: 'invalid-note' });
  // FRU-647: the files of the note, by the ids `attach` gave. A file this transport did not take is
  // refused, as the worker refuses a file that is not in transit.
  const named = attachments === null || attachments === '' ? [] : attachments.split(',');
  const ids = named.map((each) => files.get(each));
  if (ids.some((each) => each === undefined)) return answer(400, { error: 'invalid-attachments' });
  try {
    const kept: unknown = await notes.write(note.note, { attachments: ids as string[] });
    const id = idOf(kept);
    if (id === undefined) return answer(500, { error: 'write-failed' });
    for (const each of named) files.delete(each);

    return answer(200, { id });
  } catch {
    return answer(500, { error: 'write-failed' });
  }
}

/**
 * One file the composer sends (FRU-647), as `POST /attachments` carries it: its bytes in base64, its
 * name in the query, its type in `Content-Type`. The widget checked its size and its kind before.
 */
async function attachFile(
  notes: FruitbackNotes,
  files: Map<string, string>,
  body: string | undefined,
  name: string | null,
  type: string | undefined,
): Promise<TransportResponse> {
  if (notes.attach === undefined) return answer(404, { error: 'not-found' });
  if (name === null || name === '' || body === undefined) return answer(400, { error: 'invalid-file' });
  let file: File;
  try {
    file = new File([bytesOfBase64(body)], name, { type: type ?? '' });
  } catch {
    return answer(400, { error: 'invalid-file' });
  }
  try {
    const id = idOf(await notes.attach(file));
    if (id === undefined) return answer(500, { error: 'attach-failed' });
    // The widget takes only an id of its own shape: the id of the host stays here until the write.
    const transit = transitId();
    files.set(transit, id);

    return answer(200, { id: transit });
  } catch {
    return answer(500, { error: 'attach-failed' });
  }
}

/** A reply under a note (FRU-647). The note must be one a read gave. */
async function replyTo(
  notes: FruitbackNotes,
  known: Map<string, Known>,
  words: NotesWords,
  id: string,
  body: Record<string, unknown>,
): Promise<TransportResponse> {
  if (notes.reply === undefined || !known.has(id)) return answer(404, { error: 'not-found' });
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (text === '') return answer(400, { error: 'invalid-reply' });
  const author = nameOf(body.name);
  try {
    const kept = idOf(await notes.reply(id, { text, ...(author === undefined ? {} : { author }) }));
    if (kept === undefined) return answer(500, { error: 'reply-failed' });

    const reply: StoredReply = { id: kept, text, createdAt: new Date().toISOString(), mine: true };
    if (author !== undefined) reply.author = author;

    return answer(201, { comment: commentOf(reply, words) });
  } catch {
    return answer(500, { error: 'reply-failed' });
  }
}

/**
 * A verdict of the author (FRU-647): only on a note `mine` at `done` that no verdict confirmed, as the
 * thread offers it. `409` otherwise: the widget then says that the note may have moved.
 */
async function checkNote(
  notes: FruitbackNotes,
  known: Map<string, Known>,
  words: NotesWords,
  id: string,
  body: Record<string, unknown>,
): Promise<TransportResponse> {
  const note = known.get(id);
  if (notes.check === undefined || note === undefined) return answer(404, { error: 'not-found' });
  const verdict = body.verdict;
  if (verdict !== 'fixed' && verdict !== 'wrong') return answer(400, { error: 'invalid-verdict' });
  if (!note.mine || note.stage !== 'done' || note.checked) return answer(409, { error: 'not-done' });
  const text = typeof body.body === 'string' && body.body.trim() !== '' ? body.body.trim() : undefined;
  const author = nameOf(note.note.reporter?.name);
  try {
    await notes.check(id, {
      verdict,
      ...(text === undefined ? {} : { text }),
      ...(author === undefined ? {} : { author }),
    });
  } catch {
    return answer(500, { error: 'check-failed' });
  }
  const stage: NoteStage = verdict === 'wrong' ? 'new' : note.stage;
  known.set(id, { ...note, stage, checked: verdict === 'fixed' });
  const createdAt = new Date().toISOString();

  return answer(200, {
    comment: commentOf({ id: `${id}:verdict:${createdAt}`, text: text ?? '', createdAt, verdict, author }, words),
    stage,
  });
}

/** The new text of a note, by its author, while it is open (FRU-647). */
async function editNote(
  notes: FruitbackNotes,
  known: Map<string, Known>,
  id: string,
  body: Record<string, unknown>,
): Promise<TransportResponse> {
  const note = known.get(id);
  if (notes.edit === undefined || note === undefined) return answer(404, { error: 'not-found' });
  if (!note.mine || !OPEN_STAGES.has(note.stage)) return answer(409, { error: 'not-new' });
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const edited = parseNote({ ...note.note, text });
  if (text === '' || !edited.ok) return answer(400, { error: 'invalid-text' });
  try {
    await notes.edit(id, text);
  } catch {
    return answer(500, { error: 'edit-failed' });
  }
  known.set(id, { ...note, note: edited.note });

  return answer(200, { note: edited.note });
}

/** A withdrawal by the author of a note, while it is open (FRU-647): the note goes to `closed`. */
async function withdrawNote(notes: FruitbackNotes, known: Map<string, Known>, id: string): Promise<TransportResponse> {
  const note = known.get(id);
  if (notes.withdraw === undefined || note === undefined) return answer(404, { error: 'not-found' });
  if (!note.mine || !OPEN_STAGES.has(note.stage)) return answer(409, { error: 'not-open' });
  try {
    await notes.withdraw(id);
  } catch {
    return answer(500, { error: 'withdraw-failed' });
  }
  known.set(id, { ...note, stage: 'closed' });

  return answer(200, { stage: 'closed' });
}

/**
 * The issues of a read, from what `read` gave. What it gives is not trusted: a `localStorage` that any
 * script of the page can write, or the code of a host. A note that `parseNote` refuses, or of another
 * page, is dropped, and so is a reply or a file that is not one.
 */
function issuesOf(notes: FruitbackNotes, words: NotesWords, stored: unknown, page: string): NoteIssue[] {
  if (!Array.isArray(stored)) return [];
  const issues: NoteIssue[] = [];
  for (const entry of stored as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, note, stage, mine, replies, attachments } = entry as Record<keyof StoredNote, unknown>;
    const parsed = parseNote(note);
    if (typeof id !== 'string' || id === '' || !parsed.ok) continue;
    if (canonicalizePageUrl(parsed.note.page.url) !== page) continue;
    const at: NoteStage = NOTE_STAGES.includes(stage as NoteStage) ? (stage as NoteStage) : 'new';
    const thread = repliesOf(replies);
    const own = mine === true;
    const open = own && OPEN_STAGES.has(at);
    const checked = at === 'done' ? checkedOf(thread, words) : undefined;
    const files = filesOf(attachments);
    issues.push({
      id,
      identifier: '',
      title: '',
      stage: at,
      stateName: '',
      updatedAt: thread.at(-1)?.createdAt ?? parsed.note.createdAt,
      comments: thread.map((reply) => commentOf(reply, words)),
      ...(checked === undefined ? {} : { checked }),
      ...(own ? { mine: true as const } : {}),
      ...(open && notes.edit !== undefined ? { editable: true as const } : {}),
      ...(open && notes.withdraw !== undefined ? { withdrawable: true as const } : {}),
      ...(files.length === 0 ? {} : { attachments: files }),
      note: parsed.note,
    });
  }

  return issues;
}

/** The replies of a stored note, oldest first. One that is not a reply is dropped. */
function repliesOf(replies: unknown): StoredReply[] {
  if (!Array.isArray(replies)) return [];
  const kept: StoredReply[] = [];
  for (const reply of replies as unknown[]) {
    if (typeof reply !== 'object' || reply === null) continue;
    const { id, text, createdAt, author, mine, verdict } = reply as Record<keyof StoredReply, unknown>;
    if (typeof id !== 'string' || id === '' || typeof text !== 'string' || typeof createdAt !== 'string') continue;
    if (Number.isNaN(Date.parse(createdAt))) continue;
    const name = nameOf(author);
    kept.push({
      id,
      text,
      createdAt,
      ...(name === undefined ? {} : { author: name }),
      ...(mine === true ? { mine: true } : {}),
      ...(verdict === 'fixed' || verdict === 'wrong' ? { verdict } : {}),
    });
  }

  return kept.sort((one, two) => Date.parse(one.createdAt) - Date.parse(two.createdAt));
}

/** Who confirmed a note at `done`: the newest verdict, when it is `fixed`, as the worker reads it. */
function checkedOf(replies: readonly StoredReply[], words: NotesWords): { by: string; at: string } | undefined {
  const newest = [...replies].reverse().find((reply) => reply.verdict !== undefined);

  return newest?.verdict === 'fixed' ? { by: shownName(newest, words), at: newest.createdAt } : undefined;
}

/** The lines the worker writes for a verdict (FRU-294). The overlay reads them in the words of the reader. */
const VERDICT_LINES = { fixed: 'Checked: looks fixed', wrong: 'Reopened: still wrong' } as const;

/**
 * A reply as the thread shows it. A reply of the reader, and a verdict, are written as the worker
 * writes a reply of the page (`replyFromPage`, `verdictFromPage` of `overlay.ts`): a line with the name
 * and « you », then the text, quoted. The thread shows the name, and the text as it was typed; a verdict
 * reads in the words of the reader. Any other reply is the text and its author, as a store gives them.
 */
function commentOf(reply: StoredReply, words: NotesWords): NoteComment {
  const name = shownName(reply, words);
  const base = { id: reply.id, createdAt: reply.createdAt, author: name };
  if (reply.verdict === undefined && reply.mine !== true) return { ...base, body: reply.text };
  // The name is one line with no `*`, or the line of the name would not read as one.
  const line = `**${name.replace(/[*\n\r]/gu, ' ').trim() || words('thread.anonymous')}** via Fruitback · ${words('thread.you')}`;
  const typed = reply.text === '' ? [] : ['', ...quoted(reply.text)];
  const body =
    reply.verdict === undefined ? [line, '', ...quoted(reply.text)] : [line, VERDICT_LINES[reply.verdict], ...typed];

  return { ...base, body: body.join('\n') };
}

/** The name a reply shows: its author, or « Anonymous ». */
function shownName(reply: StoredReply, words: NotesWords): string {
  return reply.author ?? words('thread.anonymous');
}

/** Every line of a text, quoted, the empty ones too, as the worker quotes a reply. */
function quoted(text: string): string[] {
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`));
}

function filesOf(attachments: unknown): NoteAttachment[] {
  if (!Array.isArray(attachments)) return [];

  return (attachments as unknown[]).flatMap((each) => {
    const file = noteAttachmentSchema.safeParse(each);

    return file.success ? [file.data] : [];
  });
}

/** A name with something in it, or `undefined`. */
function nameOf(name: unknown): string | undefined {
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
}

/** The `id` of an answer of the host, or `undefined` when it gave none. */
function idOf(kept: unknown): string | undefined {
  const id = (kept as { id?: unknown } | null | undefined)?.id;

  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** An id of a file in transit, of the shape the widget takes (`att_` and 32 hex digits). */
function transitId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return `att_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The JSON object of a body, or `undefined` for a body that is not one. */
function jsonOf(body: string | undefined): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body ?? '');

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The canonical form of an address, or `undefined` for a value that is not one. */
function canonicalOrNothing(address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined;
  try {
    return canonicalizePageUrl(address);
  } catch {
    return undefined;
  }
}

function answer(status: number, body: unknown): TransportResponse {
  return { ok: status >= 200 && status < 300, status, body: JSON.stringify(body) };
}

export type LocalNotesOptions = {
  /** Defaults to `localStorage`. */
  storage?: Storage;
  /** Defaults to `fruitback:notes`. */
  key?: string;
};

/**
 * Notes kept in the browser, in `localStorage` (FRU-646): for a widget with no server, a demo, a test.
 * They stay in this browser only. Nobody else reads them.
 *
 * FRU-647: every note is the reader's (`mine`): this browser wrote it. Replies, verdicts, edits and
 * withdrawals go on the note. Of a file, only its name is kept: `localStorage` holds a few megabytes
 * for the whole site, and the widget shows no file anyway.
 */
export function localNotes(options: LocalNotesOptions = {}): FruitbackNotes {
  const key = options.key ?? 'fruitback:notes';
  const storage = (): Storage => options.storage ?? globalThis.localStorage;
  const all = (): StoredNote[] => {
    const raw = storage().getItem(key);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);

      return Array.isArray(parsed) ? (parsed as StoredNote[]) : [];
    } catch {
      return [];
    }
  };
  /** Changes the note `id` and keeps them all. `setItem` throws when the storage is full or refused. */
  const change = (id: string, edit: (stored: StoredNote) => StoredNote): void => {
    const notes = all();
    const at = notes.findIndex((each) => each?.id === id);
    const stored = notes[at];
    if (stored === undefined) throw new Error(`localNotes: no note ${id}`);
    notes[at] = edit(stored);
    storage().setItem(key, JSON.stringify(notes));
  };
  /** The names of the files taken and not written yet, by id. They are in this page only. */
  const pending = new Map<string, string>();
  let next = 0;
  const replyId = (): string => `${Date.now().toString(36)}-${(next += 1).toString(36)}`;

  return {
    async write(note, sent) {
      // `setItem` throws when the storage is full or refused: the send then fails, and the text stays.
      const kept = all().filter((each) => each?.note?.id !== note.id);
      const attachments = (sent?.attachments ?? []).flatMap((id) => {
        const name = pending.get(id);

        return name === undefined ? [] : [{ name }];
      });
      storage().setItem(
        key,
        JSON.stringify([...kept, { id: note.id, note, ...(attachments.length === 0 ? {} : { attachments }) }]),
      );
      for (const id of sent?.attachments ?? []) pending.delete(id);

      return { id: note.id };
    },
    async read(page) {
      // The address as the read asks for it: a note written with another form of it is still found.
      return all()
        .filter((each) => canonicalOrNothing(each?.note?.page?.url) === page.url)
        .map((each) => ({ ...each, mine: true }));
    },
    async reply(id, reply) {
      const kept: StoredReply = { id: replyId(), text: reply.text, createdAt: new Date().toISOString(), mine: true };
      if (reply.author !== undefined) kept.author = reply.author;
      change(id, (stored) => ({ ...stored, replies: [...(stored.replies ?? []), kept] }));

      return { id: kept.id };
    },
    async check(id, verdict) {
      const kept: StoredReply = {
        id: replyId(),
        text: verdict.text ?? '',
        createdAt: new Date().toISOString(),
        verdict: verdict.verdict,
      };
      if (verdict.author !== undefined) kept.author = verdict.author;
      change(id, (stored) => ({
        ...stored,
        ...(verdict.verdict === 'wrong' ? { stage: 'new' as const } : {}),
        replies: [...(stored.replies ?? []), kept],
      }));
    },
    async edit(id, text) {
      change(id, (stored) => ({ ...stored, note: { ...stored.note, text } }));
    },
    async withdraw(id) {
      change(id, (stored) => ({ ...stored, stage: 'closed' }));
    },
    async attach(file) {
      const id = `file-${replyId()}`;
      pending.set(id, file.name);

      return { id };
    },
  };
}
