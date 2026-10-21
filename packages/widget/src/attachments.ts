import {
  MAX_ATTACHMENTS_PER_NOTE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES_PER_NOTE,
  attachmentKindOf,
} from '@fruitback/shared';
import { base64OfBytes } from './transport.ts';

/**
 * The files of a note (FRU-332): a capture of the page or of an area, an image of the disk, any file.
 *
 * They go to the ticket of the tracker, through the worker, which keeps them only while they travel
 * (FRU-331). The widget never shows a file that Fruitback serves: a sent note says how many files it
 * has, with the link of its ticket. This file holds what the composer and `embed.ts` share: the shape
 * of a file before it is sent, the checks the widget can make before the worker makes them, and the
 * words of a refusal.
 */

/** A file as the widget holds it before it is sent: its bytes in base64, for any transport. */
export type PickedFile = { name: string; type: string; size: number; base64: string };

/**
 * Why a file did not go:
 *
 * - `too-large`: over the limit of its kind, or of the note.
 * - `type`: its bytes are not what its type says (an image that is not one).
 * - `too-many`: the note has `MAX_ATTACHMENTS_PER_NOTE` files already.
 * - `no-tracker`: the place of the note takes no file (`409`).
 * - `full`: the person holds too many files on their way (`429 transit-full`).
 * - `signed-out`: the session ended (`401`).
 * - `capture`: the capture of the page did not come.
 * - `retry`: no answer, or the worker failed. A second try can work.
 */
export type AttachRefusal =
  | 'too-large'
  | 'type'
  | 'too-many'
  | 'no-tracker'
  | 'full'
  | 'signed-out'
  | 'capture'
  | 'retry';

/** What the worker said of the files of this reader, at the last read. */
export type AttachOffer = 'offered' | 'no-tracker' | 'none';

/** The images that « Image » offers on the disk: the two the ticket names. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg';

/** What the widget refuses before it sends anything: the worker checks it again. */
export function refusalBefore(
  file: { type: string; size: number },
  held: readonly { size: number }[],
): AttachRefusal | undefined {
  if (held.length >= MAX_ATTACHMENTS_PER_NOTE) return 'too-many';
  if (file.size === 0) return 'type';
  if (file.size > MAX_ATTACHMENT_BYTES[attachmentKindOf(file.type)]) return 'too-large';
  const total = held.reduce((sum, each) => sum + each.size, file.size);

  return total > MAX_ATTACHMENT_BYTES_PER_NOTE ? 'too-large' : undefined;
}

/** The refusal of an answer of `POST /attachments` or of `POST /feedback` with files. */
export function refusalOf(response: { status: number; body: string }): AttachRefusal {
  if (response.status === 413) return 'too-large';
  if (response.status === 409) return 'no-tracker';
  if (response.status === 401) return 'signed-out';
  if (response.status === 400) return 'type';
  if (response.status === 429) return errorOf(response.body) === 'transit-full' ? 'full' : 'retry';

  return 'retry';
}

function errorOf(body: string): unknown {
  try {
    return (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

/**
 * A file of the disk, read. Its type is the one the browser gives, or `application/octet-stream`:
 * the worker reads the bytes and decides.
 */
export async function readPicked(file: File): Promise<PickedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  return {
    name: file.name === '' ? 'attachment' : file.name,
    type: file.type === '' ? 'application/octet-stream' : file.type,
    size: bytes.byteLength,
    base64: base64OfBytes(bytes),
  };
}

/** A size as a person reads it, in the language of the widget: « 48 KB », « 2.4 MB ». */
export function readableSize(bytes: number, locale: string): string {
  const units = [
    ['byte', 1],
    ['kilobyte', 1_024],
    ['megabyte', 1_024 * 1_024],
  ] as const;
  const [unit, size] = [...units].reverse().find(([, each]) => bytes >= each) ?? units[0];
  const value = bytes / size;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: value < 10 && unit !== 'byte' ? 1 : 0,
    }).format(value);
  } catch {
    return `${Math.round(value)} ${unit}`;
  }
}

/** An area of the visible page, in CSS pixels of the viewport, and the scale of the screen. */
export type CaptureArea = { left: number; top: number; width: number; height: number; scale: number };
