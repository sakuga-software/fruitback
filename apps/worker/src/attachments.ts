import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ATTACHMENT_NAME_LENGTH,
  ATTACHMENT_TRANSIT_DAYS,
  type AttachmentKind,
  MAX_ATTACHMENT_BYTES,
  OPAQUE_TYPE,
  attachmentKindOf,
} from '@fruitback/shared';

/**
 * The files of a note in transit (FRU-331), on their way to the ticket of the tracker.
 *
 * Decision of 2026-10-20 (FRU-198): **Fruitback stores no file, the ticket of the tracker does.**
 *
 * - `POST /attachments?client=<site>&name=<name>` keeps one file, sent by a session of the
 *   workspace, and answers its id. The worker checks the type against the bytes and the size against
 *   `MAX_ATTACHMENT_BYTES` of its kind.
 * - `POST /feedback?attachments=<id>,<id>` names the files of the note. The store of the site sends
 *   them to the tracker with the note: Linear at once, a REST address with each delivery.
 * - A file goes as soon as the tracker has it. A file whose note never arrives goes at
 *   `expiresAt`, `ATTACHMENT_TRANSIT_DAYS` after it came, and the note goes without it.
 * - **No route answers a file to a browser or to a member.** The one read is
 *   `GET /attachments/<id>?expires=…&signature=…`, the address of short life that a delivery of a
 *   REST connector carries, for the receiver of that delivery: see `signedAttachmentPath`.
 *
 * The table keeps the name of FRU-44, `screenshots`: it holds every file in transit. This file
 * imports nothing of the database: the store on PostgreSQL is `attachments-postgres.ts`, which
 * `postgres-stores.ts` loads at its first call.
 */

/** `POST /attachments`, and the signed read of a delivery, `GET /attachments/<id>`. */
export const ATTACHMENTS_PATH = '/attachments';

/** How long a file waits for its note, at most. */
export const TRANSIT_MS = ATTACHMENT_TRANSIT_DAYS * 24 * 60 * 60 * 1_000;

/** How long the address of a file in a delivery answers, from the attempt that carries it. */
export const SIGNED_URL_MS = 60 * 60 * 1_000;

/**
 * The most files, and the most bytes, that one account holds in transit. A member who sends files
 * and never a note fills the database of the worker until the files end: this stops them first.
 */
export const MAX_HELD_FILES = 50;
export const MAX_HELD_BYTES = 100 * 1_024 * 1_024;

export type StoredAttachment = {
  id: string;
  workspace: string;
  /** Who sent it: the account of the session. Only that account names it in a note. */
  account: string;
  /** The site of the note it goes with. */
  site: string;
  name: string;
  /** The type the worker checked, never the one the sender said: see `checkAttachment`. */
  type: string;
  content: Uint8Array;
  createdAt: number;
  /** After this instant the file reads as absent, and the sweep removes it. */
  expiresAt: number;
  /** The note that took it: the id the widget gave the seed. Absent until a note names it. */
  seed?: string;
};

export type AttachmentStore = {
  put(attachment: StoredAttachment): Promise<void>;
  /** The file, or `undefined` when it is absent or past its end at `now`. */
  get(id: string, now: number): Promise<StoredAttachment | undefined>;
  /** How many files, and how many bytes, an account holds now. */
  heldBy(account: string, now: number): Promise<{ files: number; bytes: number }>;
  /**
   * Gives the files to one note. A file already given to another note is not taken again: the
   * answer is the files that are this note's now.
   */
  claim(ids: readonly string[], seed: string, now: number): Promise<StoredAttachment[]>;
  /** Brings the end of the files to `at`, when it is later than that. */
  endAt(ids: readonly string[], at: number): Promise<void>;
  /** Removes the files. */
  remove(ids: readonly string[]): Promise<void>;
  /** Removes every file past its end. Answers how many went. */
  sweep(now: number): Promise<number>;
};

/** For the tests of the routes. A worker keeps its files in PostgreSQL. */
export function createMemoryAttachmentStore(): AttachmentStore & { size(): number; all(): StoredAttachment[] } {
  const held = new Map<string, StoredAttachment>();
  const live = (now: number) => [...held.values()].filter((each) => each.expiresAt > now);

  return {
    size: () => held.size,
    all: () => [...held.values()],
    async put(attachment) {
      held.set(attachment.id, { ...attachment, content: new Uint8Array(attachment.content) });
    },
    async get(id, now) {
      const found = held.get(id);

      return found !== undefined && found.expiresAt > now ? found : undefined;
    },
    async heldBy(account, now) {
      const mine = live(now).filter((each) => each.account === account);

      return { files: mine.length, bytes: mine.reduce((sum, each) => sum + each.content.byteLength, 0) };
    },
    async claim(ids, seed, now) {
      const taken: StoredAttachment[] = [];
      for (const id of ids) {
        const found = held.get(id);
        if (found === undefined || found.expiresAt <= now) continue;
        if (found.seed !== undefined && found.seed !== seed) continue;
        found.seed = seed;
        taken.push(found);
      }

      return taken;
    },
    async endAt(ids, at) {
      for (const id of ids) {
        const found = held.get(id);
        if (found !== undefined && found.expiresAt > at) found.expiresAt = at;
      }
    },
    async remove(ids) {
      for (const id of ids) held.delete(id);
    },
    async sweep(now) {
      let gone = 0;
      for (const [id, each] of held) {
        if (each.expiresAt > now) continue;
        held.delete(id);
        gone += 1;
      }

      return gone;
    },
  };
}

/** 128 bits that nobody guesses. The id is no secret all the same: only its sender names it. */
export function newAttachmentId(): string {
  return `att_${crypto.randomUUID().replaceAll('-', '')}`;
}

const ID = /^att_[0-9a-f]{32}$/;

export function isAttachmentId(value: string): boolean {
  return ID.test(value);
}

/** The id that a path names, or `undefined`: `/attachments/att_…` and nothing after it. */
export function attachmentIdOf(pathname: string): string | undefined {
  const id = pathname.startsWith(`${ATTACHMENTS_PATH}/`) ? pathname.slice(ATTACHMENTS_PATH.length + 1) : '';

  return ID.test(id) ? id : undefined;
}

/**
 * The ids of `?attachments=`, or `null` for a value that is not a list of ids. Absent or empty: no
 * file. The same id twice is one file.
 */
export function attachmentIdsOf(value: string | null, max: number): string[] | null {
  if (value === null || value.trim() === '') return [];
  const ids = [...new Set(value.split(',').map((each) => each.trim()))];
  if (ids.length > max || !ids.every((id) => ID.test(id))) return null;

  return ids;
}

/**
 * The name of a file as the worker keeps it: no path, no control character, no quote, at most
 * `ATTACHMENT_NAME_LENGTH` characters with its extension kept. A name with nothing left is
 * `attachment`. It is the sender's word, and the tracker shows it as such.
 */
export function attachmentName(value: string | null): string {
  const cleaned = [...(value ?? '').normalize('NFC')]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;

      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
    })
    .join('')
    .replace(/["\\/<>:|?*]/g, '_')
    .trim()
    .replace(/^\.+/, '');
  if (cleaned === '') return 'attachment';
  const chars = [...cleaned];
  if (chars.length <= ATTACHMENT_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? [...cleaned.slice(dot)] : [];
  const kept = extension.length > 0 && extension.length <= 10 ? extension : [];

  return [...chars.slice(0, ATTACHMENT_NAME_LENGTH - kept.length), ...kept].join('');
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.byteLength >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** The first bytes of each type of image, which the worker reads instead of the word of the sender. */
const IMAGE_SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  'image/png': (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  'image/gif': (bytes) => startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a')),
  'image/webp': (bytes) => startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8),
};

export type CheckedAttachment = { ok: true; kind: AttachmentKind; type: string } | { ok: false; error: string };

/**
 * What the worker keeps of a file, from its bytes and the type the sender declared.
 *
 * - An image must start as its type says: a declared PNG that is a page of HTML is refused.
 * - A PDF must start with `%PDF-`.
 * - A text must be UTF-8 with no NUL byte.
 * - Anything else is kept as `application/octet-stream`, whatever the sender said.
 *
 * Nothing is decoded: no image is opened, no PDF is read. The worker never shows a file, so it
 * never needs to.
 */
export function checkAttachment(declared: string | null, bytes: Uint8Array): CheckedAttachment {
  const kind = attachmentKindOf(declared);
  if (bytes.byteLength === 0) return { ok: false, error: 'empty-file' };
  const bare = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (kind === 'image') {
    return IMAGE_SIGNATURES[bare]?.(bytes) === true
      ? { ok: true, kind, type: bare }
      : { ok: false, error: 'type-mismatch' };
  }
  if (kind === 'pdf') {
    return startsWith(bytes, ascii('%PDF-')) ? { ok: true, kind, type: bare } : { ok: false, error: 'type-mismatch' };
  }
  if (kind === 'text') {
    if (bytes.includes(0)) return { ok: false, error: 'type-mismatch' };
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, error: 'type-mismatch' };
    }

    return { ok: true, kind, type: bare };
  }

  return { ok: true, kind, type: OPAQUE_TYPE };
}

/** The most bytes of one file of the kind that `declared` names. */
export function maxBytesFor(declared: string | null): number {
  return MAX_ATTACHMENT_BYTES[attachmentKindOf(declared)];
}

/**
 * The key that signs the address of a file in a delivery. Derived from the key of the secrets, so
 * that a signature of an address is never a seal of a secret, and the other way round.
 */
function signingKey(secretsKey: string): Buffer {
  return createHmac('sha256', secretsKey).update('fruitback:attachment-url:v1').digest();
}

function signatureOf(secretsKey: string, id: string, expires: number): string {
  return createHmac('sha256', signingKey(secretsKey)).update(`${id}.${expires}`).digest('hex');
}

/**
 * The path and the query of the address of a file for one attempt of a delivery: it answers until
 * `expires`, a time in seconds, and to nobody without the signature.
 */
export function signedAttachmentPath(secretsKey: string, id: string, expires: number): string {
  return `${ATTACHMENTS_PATH}/${id}?expires=${expires}&signature=${signatureOf(secretsKey, id, expires)}`;
}

/** Whether the query of a read is a signature of `id` that has not ended at `now`. */
export function verifiesSignedRead(secretsKey: string, id: string, query: URLSearchParams, now: number): boolean {
  const expires = Number(query.get('expires'));
  const given = query.get('signature') ?? '';
  if (!Number.isSafeInteger(expires) || expires * 1_000 <= now || !/^[0-9a-f]{64}$/.test(given)) return false;

  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(signatureOf(secretsKey, id, expires), 'hex'));
}

/** A file as a store sends it to a tracker. */
export type OutgoingFile = { id: string; name: string; type: string; content: Uint8Array };

/** What a store that sends the files answers of them, after the note. */
export type FilesOutcome = { sent: number; lost: number; waiting: number };
