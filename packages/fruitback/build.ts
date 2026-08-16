import { execFile } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * A re-export shim, compiled (SKG-505).
 *
 * Nothing is bundled here on purpose: the two packages it forwards are real dependencies, so a
 * consumer resolves them the way they resolve anything else, and there is one copy of the widget on
 * disk rather than two. Bundling would make this package self-contained and make its `dist` a second
 * build of code that already has one.
 */

const OUT = 'dist';

await rm(OUT, { recursive: true, force: true });
await promisify(execFile)(process.execPath, ['../../node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);

// `rewriteRelativeImportExtensions` handles the emitted JavaScript and leaves declarations alone —
// the same split the other two builds hit. There are no relative imports in this package today, so
// this is a guard rather than a fix, and it is here so the next file added does not meet it.
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
