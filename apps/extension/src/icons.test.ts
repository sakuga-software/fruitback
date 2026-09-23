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
 * Whether a PNG paints anything a reader can see: a pixel whose alpha is not zero.
 *
 * **The pixels have to be unfiltered to be read.** Every row of a PNG is stored as a difference
 * from the row above or from the pixel to its left, so a byte of the compressed stream is not a
 * channel. The first version scanned the stream and called any non-zero byte a drawing — which is
 * the filter byte of every row, so a blank canvas read as drawn (raised in review).
 */
function holdsADrawing(png: Buffer): boolean {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const parts: Buffer[] = [];
  let at = PNG_SIGNATURE.length;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString('ascii', at + 4, at + 8);
    if (kind === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }

  // RGBA, eight bits a channel: what `build-icons.ts` renders, and colour type 6 in the header.
  const CHANNELS = 4;
  const data = inflateSync(Buffer.concat(parts));
  const stride = width * CHANNELS;
  let above = Buffer.alloc(stride);
  let read = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = data[read] ?? 0;
    const row = Buffer.from(data.subarray(read + 1, read + 1 + stride));
    read += stride + 1;

    for (let index = 0; index < stride; index += 1) {
      const left = index >= CHANNELS ? (row[index - CHANNELS] as number) : 0;
      const up = above[index] as number;
      const upLeft = index >= CHANNELS ? (above[index - CHANNELS] as number) : 0;
      row[index] = ((row[index] as number) + predictor(filter, left, up, upLeft)) & 0xff;
    }

    for (let alpha = CHANNELS - 1; alpha < stride; alpha += CHANNELS) {
      if (row[alpha] !== 0) return true;
    }
    above = row;
  }

  return false;
}

/** What the row's filter subtracted, by its number: none, left, above, their mean, or Paeth. */
function predictor(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paeth(left, up, upLeft);

  return 0;
}

/** The neighbour the Paeth filter predicted from, as the specification defines it. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;

  return toUp <= toUpLeft ? up : upLeft;
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
   * Each size is rendered from the vector, so a source that draws nothing — or draws in a colour
   * nobody can see — renders a canvas of the right size with every pixel transparent.
   */
  it('paints something at every size, the smallest included', () => {
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
