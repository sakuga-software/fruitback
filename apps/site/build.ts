import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The stylesheets of fruitback.com, built by the CLI of Tailwind (FRU-681).
 *
 * GitHub Pages publishes `docs/` from `main` with no workflow of ours, and serves the files as they
 * are committed. So the built CSS is committed beside the pages, and `css.test.ts` fails when it is
 * not what its source builds today. Edit `src/<sheet>.css`, then run `pnpm --filter @fruitback/site css`.
 *
 * `tailwindcss` and `@tailwindcss/cli` are pinned to one exact version in `package.json`: the output
 * names that version and depends on it. A refresh of the lockfile leaves them alone, and a bump of the
 * pin is a change that builds the sheets again.
 */

/** The sheets, by the name the layouts of `docs/` link. */
export const SHEETS = ['landing', 'docs'] as const;

export type Sheet = (typeof SHEETS)[number];

const HERE = new URL('./', import.meta.url);

/** Where a built sheet is published. */
export function output(sheet: Sheet): URL {
  return new URL(`../../docs/assets/${sheet}.css`, HERE);
}

/**
 * The script of the CLI, run by this Node rather than through `node_modules/.bin`: on Windows that entry
 * is a `.cmd` shim, which `execFileSync` cannot start.
 */
function cli(): string {
  const manifest = createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> };

  return join(dirname(manifest), bin['tailwindcss'] ?? 'dist/index.mjs');
}

/** The CSS of a sheet, as its source builds it now: minified, with a line that says where it comes from. */
export function build(sheet: Sheet): string {
  const css = execFileSync(
    process.execPath,
    [cli(), '--input', fileURLToPath(new URL(`src/${sheet}.css`, HERE)), '--minify'],
    { cwd: fileURLToPath(HERE), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return `/* Built from apps/site/src/${sheet}.css by \`pnpm --filter @fruitback/site css\` (FRU-681). Edit the source, not this file. */\n${css.trimEnd()}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const sheet of SHEETS) writeFileSync(output(sheet), build(sheet));
}
