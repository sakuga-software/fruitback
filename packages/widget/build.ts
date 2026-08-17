import { execFile } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';

/**
 * Two files, both self-contained (SKG-505).
 *
 * `react-grab` and `zod` are bundled rather than declared as peers: the acceptance criterion is that
 * the widget imposes no heavy dependency on the host, and a client site should not have to install —
 * or resolve a version conflict over — a library it never asked for. It costs bytes on our side and
 * nothing on theirs.
 *
 * Declarations come from `tsc` against `public.ts` rather than the whole index, which is why that
 * entry exists: the published surface is `init` and what it hands back, and a narrow one is the
 * difference between a contract and an accident.
 */

const OUT = 'dist';

await rm(OUT, { recursive: true, force: true });

const shared = { bundle: true, target: 'es2022', sourcemap: true, logLevel: 'info' } as const;

// Left readable on purpose: it goes through the consumer's own bundler, which will minify it with
// everything else. Minifying twice buys nothing and costs them a legible stack trace.
await build({
  ...shared,
  entryPoints: ['src/public.ts'],
  format: 'esm',
  minify: false,
  outfile: `${OUT}/fruitback.mjs`,
});

// Minified, because this one lands on someone's page exactly as it is built. A feedback widget that
// costs its host half a megabyte is one they remove, and the sourcemap next to it is what keeps the
// thing debuggable.
await build({
  ...shared,
  entryPoints: ['src/global.ts'],
  format: 'iife',
  globalName: 'Fruitback',
  minify: true,
  outfile: `${OUT}/fruitback.iife.js`,
});

// Ordered here rather than chained in the package script: `rm -rf dist` above would otherwise
// delete declarations emitted by a previous step, and the rewrite below has to run after them.
await promisify(execFile)(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
await rewriteDeclarationExtensions();

/**
 * `./resolve.ts` becomes `./resolve.js` in the emitted declarations.
 *
 * The sources import each other with the `.ts` extension, which is what lets `node --test` and
 * `node --watch` run them with no build step. `tsc` carries that extension into the `.d.ts` files,
 * where it resolves to nothing: `dist` holds declarations, not sources. Rewritten to `.js`, which is
 * the extension TypeScript already knows to look for a `.d.ts` beside.
 *
 * Checked rather than assumed — a silent miss here ships a package whose types do not load.
 */
async function rewriteDeclarationExtensions(): Promise<void> {
  const files = (await readdir(OUT)).filter((name) => name.endsWith('.d.ts'));

  for (const name of files) {
    const path = `${OUT}/${name}`;
    const rewritten = (await readFile(path, 'utf8')).replaceAll(/(from '\.[^']*)\.ts'/g, "$1.js'");
    await writeFile(path, rewritten);
  }

  const leftovers = (
    await Promise.all(files.map(async (name) => ({ name, body: await readFile(`${OUT}/${name}`, 'utf8') })))
  ).filter(({ body }) => /from '\.[^']*\.ts'/.test(body));

  if (leftovers.length > 0) {
    throw new Error(`declarations still import .ts: ${leftovers.map(({ name }) => name).join(', ')}`);
  }
}
