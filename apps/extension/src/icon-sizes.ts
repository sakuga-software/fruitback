/**
 * The sizes the icon is rendered at, and where each one lands (SKG-617).
 *
 * One list, read by three places that would otherwise drift: `wxt.config.ts` declares them in the
 * manifest, `build-icons.ts` renders them, and `icons.test.ts` checks the files on disk. A size
 * declared and not rendered is a browser asking for a file that is not in the build.
 *
 * 96 is Firefox's; the other four are Chrome's, from the toolbar button to the store listing.
 */
export const ICON_SIZES = [16, 32, 48, 96, 128] as const;

/** Where a size lives in the extension's output, which is also its path in `public/`. */
export function iconPath(size: number): string {
  return `icon/${size}.png`;
}
