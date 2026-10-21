import { MAX_ATTACHMENT_BYTES } from '@fruitback/shared';
import { isSecureWorkerEndpoint } from './endpoint.ts';
import type { AccessResult } from './session.ts';
import type { SiteConfig } from './sites.ts';

/**
 * A capture of the page, taken by the browser itself (FRU-44, FRU-332).
 *
 * The widget asks for a capture of the visible page, or of an area the person chose on it
 * (`captureVisible`, its seam). The page world passes the request across, and this, in the
 * background, takes the visible part of the tab (`tabs.captureVisibleTab`), cuts the area out, and
 * answers the PNG. **It sends nothing**: the widget joins it to the note like a file of the disk,
 * and it goes to the worker through the relay, with the session of the reviewer, then to the ticket
 * of the tracker (FRU-331). The address of FRU-44, `POST /screenshot`, is gone.
 *
 * **No new permission.** `captureVisibleTab` needs `activeTab` or `<all_urls>` (measured on Chromium
 * 145). The manifest declares `activeTab` already, and the browser grants it when the reviewer opens
 * the popup on the page, until the page navigates. Without that gesture the capture is refused, and
 * the composer says that the capture was not taken: **a capture that fails costs the capture, never
 * the note.**
 *
 * **Only for a site of a workspace, with a session**: the one place where the worker takes files. A
 * page that asks for a capture of another site gets nothing.
 *
 * Every refusal is `undefined`, never an error.
 */

/** Where on the screen the area is, in CSS pixels of the viewport, and the scale of the screen. */
export type CaptureArea = { left: number; top: number; width: number; height: number; scale: number };

/** A capture, as the widget joins it to a note. */
export type CapturedFile = { name: string; type: 'image/png' | 'image/jpeg'; size: number; base64: string };

/**
 * A capture over the limit of an image of the worker (`MAX_ATTACHMENT_BYTES.image`), even as a JPEG:
 * its name and its size, and no bytes. The widget says it is too large, rather than « not taken ».
 */
export type TooLargeCapture = { tooLarge: { name: string; size: number } };

export type CaptureSeams = {
  readSite: (origin: string) => Promise<SiteConfig | undefined>;
  ensureAccess: (endpoint: string) => Promise<AccessResult>;
  /** The visible part of the tab, as a PNG. Rejects without `activeTab`. */
  captureTab: () => Promise<Blob>;
  /** The area of `picture`, as a PNG. */
  crop: (picture: Blob, area: CaptureArea) => Promise<Blob>;
  /** The same picture as a JPEG, for a PNG over the limit of the worker (a page of a large screen). */
  toJpeg?: (picture: Blob) => Promise<Blob>;
};

/** The name of a capture: a capture of the page, or of an area. */
export const CAPTURE_NAMES = { page: 'page.png', area: 'area.png' } as const;

export function createCapture(seams: CaptureSeams) {
  return async (
    area: CaptureArea | undefined,
    origin: string | undefined,
  ): Promise<CapturedFile | TooLargeCapture | undefined> => {
    try {
      return await take(seams, area, origin);
    } catch {
      return undefined;
    }
  };
}

async function take(
  { readSite, ensureAccess, captureTab, crop, toJpeg }: CaptureSeams,
  area: CaptureArea | undefined,
  origin: string | undefined,
): Promise<CapturedFile | TooLargeCapture | undefined> {
  if (origin === undefined) return undefined;
  const site = await readSite(origin);
  if (site === undefined || !site.enabled || site.mode !== 'team') return undefined;
  // The capture goes through the relay, with the token: never to a worker on an http address.
  if (!isSecureWorkerEndpoint(site.endpoint)) return undefined;
  // Before the capture: a reviewer with no session gets no capture taken at all.
  const access = await ensureAccess(site.endpoint);
  if (!access.ok) return undefined;

  const tab = await captureTab();
  const png = area === undefined ? tab : await crop(tab, area);
  const name = area === undefined ? CAPTURE_NAMES.page : CAPTURE_NAMES.area;
  // A PNG of a whole page on a large screen can pass the limit of the worker: it goes as a JPEG, and
  // a JPEG still over it is said too large, never « not taken » (raised by the balanced of #433).
  let picture = png;
  let type: CapturedFile['type'] = 'image/png';
  if (png.size > MAX_ATTACHMENT_BYTES.image && toJpeg !== undefined) {
    picture = await toJpeg(png);
    type = 'image/jpeg';
  }
  const named = type === 'image/jpeg' ? name.replace(/\.png$/, '.jpg') : name;
  if (picture.size > MAX_ATTACHMENT_BYTES.image) return { tooLarge: { name: named, size: picture.size } };
  const bytes = new Uint8Array(await picture.arrayBuffer());

  return { name: named, type, size: bytes.byteLength, base64: base64Of(bytes) };
}

/** The base64 of bytes, by pieces: a spread of megabytes into `String.fromCharCode` overflows the stack. */
export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }

  return btoa(binary);
}

/** The bytes of base64, for the body of a relayed file. */
export function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  return bytes;
}

/**
 * The area to cut, in pixels of the captured picture, inside it. `undefined` when nothing is left:
 * an element out of the viewport, or of no size.
 */
export function pixelsOf(
  area: CaptureArea,
  picture: { width: number; height: number },
): { left: number; top: number; width: number; height: number } | undefined {
  const scale = area.scale > 0 && Number.isFinite(area.scale) ? area.scale : 1;
  const left = Math.max(0, Math.floor(area.left * scale));
  const top = Math.max(0, Math.floor(area.top * scale));
  const right = Math.min(picture.width, Math.ceil((area.left + area.width) * scale));
  const bottom = Math.min(picture.height, Math.ceil((area.top + area.height) * scale));
  if (right <= left || bottom <= top) return undefined;

  return { left, top, width: right - left, height: bottom - top };
}
