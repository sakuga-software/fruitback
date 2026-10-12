/**
 * The picture that the extension takes with a note (FRU-44): what the worker keeps, and its limits.
 *
 * The extension captures the tab, cuts the picture to the element, and sends the PNG to
 * `POST /screenshot`. The worker keeps it in its database and answers an address, which the widget
 * writes in the seed. **Only a member of the workspace reads that address**: a picture of a page of
 * a staging site can show anything that page shows.
 *
 * This file imports nothing of the database: every worker loads it. The store on PostgreSQL is
 * `screenshots-postgres.ts`, which `postgres-stores.ts` loads at its first call.
 */

/** The path of both routes: `POST /screenshot`, and `GET /screenshot/<id>`. */
export const SCREENSHOT_PATH = '/screenshot';

/** One megabyte. The picture of one element is tens of kilobytes; a whole screen at 2x can pass this, and is refused. */
export const MAX_SCREENSHOT_BYTES = 1_024 * 1_024;

/** No picture is wider or taller. A PNG of a few bytes can declare a size that a reader would allocate. */
export const MAX_SCREENSHOT_SIDE = 8_192;

export type StoredScreenshot = {
  id: string;
  workspace: string;
  /** Who sent it: the account of the session. */
  account: string;
  png: Uint8Array;
  width: number;
  height: number;
  createdAt: number;
};

export type ScreenshotStore = {
  put(screenshot: StoredScreenshot): Promise<void>;
  get(id: string): Promise<StoredScreenshot | undefined>;
};

/** For the tests of the routes. A worker keeps its pictures in PostgreSQL, or keeps none. */
export function createMemoryScreenshotStore(): ScreenshotStore & { size(): number } {
  const held = new Map<string, StoredScreenshot>();

  return {
    size: () => held.size,
    async put(screenshot) {
      held.set(screenshot.id, { ...screenshot, png: new Uint8Array(screenshot.png) });
    },
    async get(id) {
      return held.get(id);
    },
  };
}

/** 128 bits that nobody guesses. The address is no secret all the same: the route asks who reads. */
export function newScreenshotId(): string {
  return `shot_${crypto.randomUUID().replaceAll('-', '')}`;
}

const ID = /^shot_[0-9a-f]{32}$/;

/** The id that a path names, or `undefined`: `/screenshot/shot_…` and nothing after it. */
export function screenshotIdOf(pathname: string): string | undefined {
  const id = pathname.startsWith(`${SCREENSHOT_PATH}/`) ? pathname.slice(SCREENSHOT_PATH.length + 1) : '';

  return ID.test(id) ? id : undefined;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** `IHDR`, the chunk that every PNG starts with: its width and its height follow. */
const HEADER = [0x49, 0x48, 0x44, 0x52];

/**
 * The size that a PNG declares, or `undefined` when the bytes are not the start of a PNG.
 *
 * The signature, then the `IHDR` chunk: nothing is decoded. This keeps a file that is not a picture
 * out of the database. It does not say that the picture is whole, and a reader must not trust it to.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < 24) return undefined;
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) return undefined;
  if (!HEADER.every((byte, index) => bytes[12 + index] === byte)) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > MAX_SCREENSHOT_SIDE || height > MAX_SCREENSHOT_SIDE) return undefined;

  return { width, height };
}
