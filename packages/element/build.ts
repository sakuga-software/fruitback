import { execFile } from 'node:child_process';
import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';

/**
 * Two builds (FRU-126).
 *
 * The modules are compiled, not bundled: `@fruitback/widget` is a real dependency, so a consumer has
 * one copy of the widget. The script for a page with no build step is the opposite case: it lands on
 * a page as it is, so it holds the widget and it is minified.
 */
const OUT = 'dist';

await rm(OUT, { recursive: true, force: true });
// The script below holds the widget, and with it `react-grab` and `zod`. Their MIT notices must travel
// with it. The text has one home, the widget's: it is copied here for the tarball, and not committed.
await copyFile('../widget/THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md');
await promisify(execFile)(process.execPath, ['../../node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);

await build({
  bundle: true,
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  entryPoints: ['src/auto.ts'],
  format: 'iife',
  minify: true,
  outfile: `${OUT}/fruitback-element.iife.js`,
});

// `rewriteRelativeImportExtensions` rewrites the emitted JavaScript and leaves the declarations.
const emitted = (await readdir(OUT)).filter(
  (name) => name.endsWith('.d.ts') || (name.endsWith('.js') && !name.includes('.iife.')),
);

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
