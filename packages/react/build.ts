import { execFile } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * The component, compiled (FRU-127).
 *
 * Nothing is bundled: `@fruitback/widget` is a real dependency and `react` is the host's own, so a
 * consumer has one copy of each.
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
