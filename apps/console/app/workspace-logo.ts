import { LOGO_TYPES, MAX_LOGO_BYTES } from './api.ts';
import { msg } from './i18n.ts';

/**
 * What the console says of a logo of a workspace (FRU-428) that it refuses before it sends it, or
 * that the worker refuses: the type, the size, the pixels, and who may.
 */

const TYPE_REFUSED = msg('Choose a PNG, JPEG or WebP image. SVG is not accepted.');
const SIZE_REFUSED = msg('The image is over 512 KB. Choose a smaller one.');

/** What the worker refuses when a logo is sent or removed, by the code it answers. */
export const LOGO_PROBLEMS: Readonly<Record<string, string>> = {
  'unsupported-type': TYPE_REFUSED,
  'payload-too-large': SIZE_REFUSED,
  'type-mismatch': msg('This file is not the image its type says. Choose another one.'),
  'image-too-large': msg('The image is over 4096 pixels on a side. Choose a smaller one.'),
  'empty-file': msg('This file is empty. Choose another one.'),
  forbidden: msg('Only an owner or an admin of the workspace changes its logo.'),
};
export const LOGO_NOT_SAVED = msg('The logo was not saved. Try again.');
export const LOGO_NOT_REMOVED = msg('The logo was not removed. Try again.');

/**
 * Why the console refuses a file before it sends it, or `undefined`: the type and the size the worker
 * takes, said at once. The worker checks them again, and the bytes.
 */
export function logoRefusal(file: { type: string; size: number }): string | undefined {
  if (!LOGO_TYPES.includes(file.type)) return TYPE_REFUSED;
  if (file.size > MAX_LOGO_BYTES) return SIZE_REFUSED;

  return undefined;
}
