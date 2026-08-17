import { execFile } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * The seed contract, compiled (SKG-505).
 *
 * This package was internal for a long time, and `main` pointed straight at `src/index.ts` — which
 * works everywhere in this repo and nowhere outside it. The sources import each other with the `.ts`
 * extension, a convention that needs `allowImportingTsExtensions`; a consumer running an ordinary
 * `tsc` gets `TS5097` and nothing type-checks. Publishing the package without this step defeated the
 * whole reason for publishing it.
 */

const OUT = 'dist';

await rm(OUT, { recursive: true, force: true });
await promisify(execFile)(process.execPath, ['../../node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);

/**
 * `./seed.ts` becomes `./seed.js` in the **declarations**.
 *
 * `rewriteRelativeImportExtensions` in the tsconfig handles the emitted JavaScript and stops there —
 * declarations keep the source's extension, where `dist` has no `.ts` to find. Measured, not
 * assumed: the same split showed up in the widget's build.
 *
 * Checked afterwards, because a silent miss here ships a package whose types resolve to nothing —
 * which is exactly what shipped once already.
 */
const emitted = (await readdir(OUT)).filter((name) => name.endsWith('.js') || name.endsWith('.d.ts'));

for (const name of emitted) {
  const path = `${OUT}/${name}`;
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll(/(from '\.[^']*)\.ts'/g, "$1.js'"));
}

const leftovers = (
  await Promise.all(emitted.map(async (name) => ({ name, body: await readFile(`${OUT}/${name}`, 'utf8') })))
).filter(({ body }) => /from '\.[^']*\.ts'/.test(body));

if (leftovers.length > 0) {
  throw new Error(`emitted files still import .ts: ${leftovers.map(({ name }) => name).join(', ')}`);
}
