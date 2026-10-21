import { z } from 'zod';

/**
 * The files that go with a note (FRU-331): the capture of the page, of an area, an image, any file.
 *
 * **Fruitback keeps no file.** A file waits in the worker until its note reaches the tracker, and
 * goes as soon as the tracker has it. A file whose note never arrives goes after
 * `ATTACHMENT_TRANSIT_DAYS`, and the note is sent without it. A note kept in Fruitback, with no
 * tracker, takes no file at all.
 *
 * The worker checks the type and the size of every file. The widget reads the same limits from here,
 * to refuse a file before it is sent: the check of the worker is the one that holds.
 */

/** The most days a file waits in the worker for its note to reach the tracker. */
export const ATTACHMENT_TRANSIT_DAYS = 7;

/** The most files of one note. */
export const MAX_ATTACHMENTS_PER_NOTE = 5;

/** The most bytes of all the files of one note. */
export const MAX_ATTACHMENT_BYTES_PER_NOTE = 25 * 1_024 * 1_024;

/**
 * The kinds of file, and the most bytes of one file of each kind.
 *
 * - `image`: PNG, JPEG, WebP, GIF. A capture of a whole page at 2x on a 4K screen is 3 to 8 MB.
 * - `pdf`: a document.
 * - `text`: plain text, CSV, JSON. A log or an export. Checked as UTF-8 with no NUL byte.
 * - `file`: anything else. It is kept and sent as `application/octet-stream`, whatever type the
 *   sender said: nobody opens it in a browser on the word of the sender.
 */
export const ATTACHMENT_KINDS = ['image', 'pdf', 'text', 'file'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const MAX_ATTACHMENT_BYTES: Readonly<Record<AttachmentKind, number>> = {
  image: 10 * 1_024 * 1_024,
  pdf: 10 * 1_024 * 1_024,
  text: 2 * 1_024 * 1_024,
  file: 10 * 1_024 * 1_024,
};

/** The types that the worker reads as one kind. Any other type is a `file`. */
export const ATTACHMENT_TYPES: Readonly<Record<Exclude<AttachmentKind, 'file'>, readonly string[]>> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  pdf: ['application/pdf'],
  text: ['text/plain', 'text/csv', 'application/json'],
};

/** The type of a file that is no other kind: how it is kept and how it is sent. */
export const OPAQUE_TYPE = 'application/octet-stream';

/** The kind of a type, as a sender declares it. Parameters (`; charset=…`) and case do not count. */
export function attachmentKindOf(type: string | null | undefined): AttachmentKind {
  const bare = (type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  for (const kind of ['image', 'pdf', 'text'] as const) {
    if (ATTACHMENT_TYPES[kind].includes(bare)) return kind;
  }

  return 'file';
}

/** The longest name of a file, in characters. A longer one is cut, its extension kept. */
export const ATTACHMENT_NAME_LENGTH = 120;

/**
 * A file of a note, as a read answers it, after the tracker took it.
 *
 * `url` is the address that the tracker gave the file: it opens there, with an account of the
 * tracker. Fruitback serves no file. Part of the read envelope: `SEED_VERSION` does not move.
 */
export const seedAttachmentSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1).optional(),
});

export type SeedAttachment = z.infer<typeof seedAttachmentSchema>;
