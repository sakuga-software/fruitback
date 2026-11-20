import {
  type Note,
  type NotePage,
  type NoteIssue,
  type NoteStage,
  NOTE_STAGES,
  canonicalizePageUrl,
  parseNote,
} from '@fruitback/shared';
import type { FruitbackTransport, TransportResponse } from './transport.ts';

/**
 * Where the notes go when no worker takes them (FRU-646): a function of the host.
 *
 * `write` is required. `read` is optional: without it a note goes, and no pin comes back. The widget
 * offers nothing else with `notes`: no reply, no place to choose, no address to ask, no file.
 */
export type FruitbackNotes = {
  /**
   * Keeps one note, and answers its id. The same note can come twice, after a send that failed: the
   * id of the note (`note.id`) is the same, so keep it once. A rejection, or an answer with no `id`,
   * is a send that failed: the composer keeps the text and says so.
   */
  write(note: Note): Promise<{ id: string }>;
  /** The notes of one page, for its pins. Asked with the address of the page, as the notes keep it. */
  read?(page: NotePage): Promise<StoredNote[]>;
};

/**
 * A note as `read` gives it back. `id` is the id `write` gave. `stage` is where the note is; left out,
 * the pin says « New ».
 */
export type StoredNote = { id: string; note: Note; stage?: NoteStage };

/**
 * The address the calls of a widget with `notes` are written to. `.invalid` is a name that no DNS
 * resolves (RFC 2606): if a call took another way than the transport of `notesTransport`, it fails
 * and sends nothing.
 */
export const NOTES_ENDPOINT = 'https://notes.fruitback.invalid';

/**
 * The calls of the widget, answered by `notes` as the worker would answer them. `GET /feedback` and
 * `POST /feedback` only: every other call gets a `404`, which the widget takes as « not offered ».
 */
export function notesTransport(notes: FruitbackNotes): FruitbackTransport {
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== NOTES_ENDPOINT || url.pathname !== '/feedback') return answer(404, { error: 'not-found' });
    if (request.method === 'GET') return readPage(notes, url.searchParams.get('url'));

    return writeNote(notes, request.body);
  };
}

async function readPage(notes: FruitbackNotes, address: string | null): Promise<TransportResponse> {
  if (address === null) return answer(400, { error: 'invalid-url' });
  if (notes.read === undefined) return answer(200, { issues: [] });
  const page = canonicalOrNothing(address);
  if (page === undefined) return answer(400, { error: 'invalid-url' });
  let stored: unknown;
  try {
    stored = await notes.read({ url: page, path: new URL(page).pathname });
  } catch {
    return answer(503, { error: 'read-failed' });
  }

  return answer(200, { issues: issuesOf(stored, page) });
}

async function writeNote(notes: FruitbackNotes, body: string | undefined): Promise<TransportResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    return answer(400, { error: 'invalid-note' });
  }
  const note = parseNote(parsed);
  if (!note.ok) return answer(400, { error: 'invalid-note' });
  try {
    const kept: unknown = await notes.write(note.note);
    const id = (kept as { id?: unknown } | null | undefined)?.id;
    if (typeof id !== 'string' || id === '') return answer(500, { error: 'write-failed' });

    return answer(200, { id });
  } catch {
    return answer(500, { error: 'write-failed' });
  }
}

/**
 * The issues of a read, from what `read` gave. What it gives is not trusted: a `localStorage` that any
 * script of the page can write, or the code of a host. A note that `parseNote` refuses, or of another
 * page, is dropped.
 */
function issuesOf(stored: unknown, page: string): NoteIssue[] {
  if (!Array.isArray(stored)) return [];
  const issues: NoteIssue[] = [];
  for (const entry of stored as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, note, stage } = entry as { id?: unknown; note?: unknown; stage?: unknown };
    const parsed = parseNote(note);
    if (typeof id !== 'string' || id === '' || !parsed.ok) continue;
    if (canonicalizePageUrl(parsed.note.page.url) !== page) continue;
    issues.push({
      id,
      identifier: '',
      title: '',
      stage: NOTE_STAGES.includes(stage as NoteStage) ? (stage as NoteStage) : 'new',
      stateName: '',
      updatedAt: parsed.note.createdAt,
      note: parsed.note,
    });
  }

  return issues;
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

  return {
    async write(note) {
      // `setItem` throws when the storage is full or refused: the send then fails, and the text stays.
      const kept = all().filter((each) => each?.note?.id !== note.id);
      storage().setItem(key, JSON.stringify([...kept, { id: note.id, note }]));

      return { id: note.id };
    },
    async read(page) {
      // The address as the read asks for it: a note written with another form of it is still found.
      return all().filter((each) => canonicalOrNothing(each?.note?.page?.url) === page.url);
    },
  };
}
