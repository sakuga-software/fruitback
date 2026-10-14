import { isSecureWorkerEndpoint } from './endpoint.ts';
import type { AccessResult } from './session.ts';
import type { SiteConfig } from './sites.ts';

/**
 * The picture that goes with a note, taken by the browser itself (FRU-44).
 *
 * The widget asks for a picture of the element (`captureScreenshot`, its seam since SKG-495). The
 * page world passes the request across, and this, in the background, does the rest:
 * `tabs.captureVisibleTab`, the crop to the element, and the upload to the worker of the site, with
 * the session of the reviewer. **Nothing changes in `packages/widget`.**
 *
 * **No new permission.** `captureVisibleTab` needs `activeTab` or `<all_urls>` (measured on Chromium
 * 145). The manifest declares `activeTab` already, and the browser grants it when the reviewer opens
 * the popup on the page, until the page navigates. Without that gesture the capture is refused, and
 * the note goes without its picture: **a capture that fails costs the picture, never the note.**
 *
 * **Only a member reads the picture.** It is sent with the session of the worker of the site, and
 * the worker keeps it for the workspace of that session: no session, no picture.
 *
 * Every refusal is `undefined`, never an error: the widget treats them all as « no picture ».
 */

/** Where on the screen the element is, in CSS pixels of the viewport, and the scale of the screen. */
export type CaptureArea = { left: number; top: number; width: number; height: number; scale: number };

/** What the worker answered: the address of the picture, and its size in pixels. */
export type CapturedPicture = { url: string; width: number; height: number };

export type CaptureSeams = {
  readSite: (origin: string) => Promise<SiteConfig | undefined>;
  ensureAccess: (endpoint: string) => Promise<AccessResult>;
  /**
   * A new access token, when the worker refused `refused` (FRU-238): a token minted before the worker
   * names the session in it (`sid`) is refused by a route that writes, until the next refresh.
   */
  renewAccess?: (endpoint: string, refused: string) => Promise<AccessResult>;
  /** The visible part of the tab, as a PNG. Rejects without `activeTab`. */
  captureTab: () => Promise<Blob>;
  /** The area of `picture`, as a PNG. */
  crop: (picture: Blob, area: CaptureArea) => Promise<Blob>;
  upload: (url: string, accessToken: string, png: Blob) => Promise<{ status: number; body: string }>;
};

/** The path of the route that keeps a picture on the worker. */
export const SCREENSHOT_PATH = '/screenshot';

export function createCapture(seams: CaptureSeams) {
  return async (area: CaptureArea, origin: string | undefined): Promise<CapturedPicture | undefined> => {
    try {
      return await take(seams, area, origin);
    } catch {
      return undefined;
    }
  };
}

async function take(
  { readSite, ensureAccess, renewAccess, captureTab, crop, upload }: CaptureSeams,
  area: CaptureArea,
  origin: string | undefined,
): Promise<CapturedPicture | undefined> {
  if (origin === undefined) return undefined;
  const site = await readSite(origin);
  if (site === undefined || !site.enabled) return undefined;
  // The widget on the page is ours only then; a site that embeds its own takes its own pictures.
  const clientId = site.mode === 'private' ? site.clientId : site.mount?.clientId;
  if (clientId === undefined) return undefined;
  // The token goes on the wire with the picture, as on the relay.
  if (!isSecureWorkerEndpoint(site.endpoint)) return undefined;

  // Before the capture: a reviewer with no session gets no picture taken at all.
  const access = await ensureAccess(site.endpoint);
  if (!access.ok) return undefined;

  const picture = await crop(await captureTab(), area);
  const url = `${site.endpoint}${SCREENSHOT_PATH}?client=${encodeURIComponent(clientId)}`;
  let answer = await upload(url, access.grant.accessToken, picture);
  // Refused for its token: renewed once, and sent again. Twice refused, the note goes without it,
  // and the composer says so (`{ picture: 'missed' }` in the widget).
  if (refusedForItsToken(answer) && renewAccess !== undefined) {
    const renewed = await renewAccess(site.endpoint, access.grant.accessToken);
    if (!renewed.ok) return undefined;
    answer = await upload(url, renewed.grant.accessToken, picture);
  }
  if (answer.status !== 201) return undefined;

  return pictureOn(answer.body, site.endpoint);
}

/** `401 identity-required`: the worker took no session from this token. Any other refusal is final. */
function refusedForItsToken(answer: { status: number; body: string }): boolean {
  if (answer.status !== 401) return false;
  try {
    return (JSON.parse(answer.body) as { error?: unknown }).error === 'identity-required';
  } catch {
    return false;
  }
}

/** The id that the worker gives a picture: 128 random bits. */
const PICTURE_ID = /^shot_[0-9a-f]{32}$/;

/**
 * The picture that the worker kept, at the address the extension reaches that worker by.
 *
 * **The address is built here, from the id and the endpoint of the stored entry**, and the `url` of
 * the answer is not read. A worker behind a proxy sees an inner address for itself when
 * `FRUITBACK_PUBLIC_URL` is not set, and would name a picture nobody reaches (raised in review). The
 * endpoint is the one address of that worker that is known to answer from here.
 */
function pictureOn(body: string, endpoint: string): CapturedPicture | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { id, width, height } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || !PICTURE_ID.test(id)) return undefined;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;

  return { url: `${endpoint}${SCREENSHOT_PATH}/${id}`, width, height };
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
