import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { ICON_SIZES, iconPath } from './icon-sizes.ts';

/**
 * The committed icons, against the sizes the manifest declares (SKG-617).
 *
 * `build-icons.ts` renders them and nothing in the build does, so a stale or missing file reaches a
 * browser as a grey square and a store listing as a refusal. The header of a PNG carries its size,
 * so this needs no image library.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function icon(size: number): Buffer {
  return readFileSync(new URL(`../public/${iconPath(size)}`, import.meta.url));
}

/**
 * Whether a PNG holds a drawing, read from its pixels.
 *
 * **The first byte of every row is the filter, and it is not a pixel.** An empty canvas from this
 * rasteriser carries one `1` per row and zeros for the rest, so a scan of the whole buffer answers
 * "drawn" for a blank image — measured, and a mutant of the empty source is what showed it.
 */
function holdsADrawing(png: Buffer): boolean {
  const width = png.readUInt32BE(16);
  const parts: Buffer[] = [];
  let at = PNG_SIGNATURE.length;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString('ascii', at + 4, at + 8);
    if (kind === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }

  const data = inflateSync(Buffer.concat(parts));
  // RGBA, eight bits a channel: what `build-icons.ts` renders, and `colour type 6` in the header.
  const stride = 1 + width * 4;

  return data.some((byte, index) => byte !== 0 && index % stride !== 0);
}

describe('the extension icons', () => {
  it('holds a PNG of that size for every size the manifest declares', () => {
    for (const size of ICON_SIZES) {
      const png = icon(size);

      assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), `${iconPath(size)} is not a PNG`);
      assert.equal(png.toString('ascii', 12, 16), 'IHDR', `${iconPath(size)} has no header`);
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `${iconPath(size)} is another size`);
    }
  });

  /**
   * Each size is rendered from the vector, so a source that draws nothing renders a canvas of the
   * right size holding nothing at all. An empty canvas deflates to zeros, drawing does not.
   */
  it('draws something at every size, the smallest included', () => {
    for (const size of ICON_SIZES) {
      assert.ok(holdsADrawing(icon(size)), `${iconPath(size)} is an empty canvas`);
    }
  });

  /** The manifest builds its list from `ICON_SIZES`; a second list here would drift from it. */
  it('is declared from the one list of sizes', () => {
    const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');

    assert.match(config, /icons: Object\.fromEntries\(ICON_SIZES\.map\(\(size\) => \[size, iconPath\(size\)\]\)\)/);
  });
});
