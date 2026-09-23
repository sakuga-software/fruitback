import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ICON_SIZES, iconPath } from './src/icon-sizes.ts';

/**
 * Render the extension's icon, at every size a browser asks for (SKG-617).
 *
 * **Each size is rendered from the vector, never resized from the big one.** A 16px icon made by
 * shrinking a 128px one keeps the detail of the large drawing as a smudge. The rasteriser is
 * `@resvg/resvg-js`, a devDependency with no system library behind it, so this runs anywhere.
 *
 * The output is committed: a browser reads `public/icon/` from the build, and no build step
 * generates it. `icons.test.ts` is what keeps the committed files honest — it fails on a size the
 * manifest declares and the folder does not hold, and on a file whose pixels are not that size.
 *
 * Run it with `pnpm icons:build` after changing `assets/icon.svg`.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(`${here}assets/icon.svg`, 'utf8');

for (const size of ICON_SIZES) {
  const rendered = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render();
  writeFileSync(`${here}public/${iconPath(size)}`, rendered.asPng());
  console.log(iconPath(size));
}
