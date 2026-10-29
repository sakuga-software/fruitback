import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_CAPTURED } from './app/guide-captured.ts';
import { type GuideCaptured, guideMarkdown, withGuideBlock } from './app/guide-steps.ts';

/**
 * Writes the steps of the guide into `docs/reviewing.md` (FRU-486): `node apps/console/guide-docs.ts`.
 *
 * `guide-steps.ts` is the source. The block in the document is a copy, and `guide-steps.test.ts`
 * fails when the copy differs.
 *
 * `node apps/console/guide-docs.ts --captured <version>` is what `e2e/first-note.spec.ts` runs after
 * it wrote new captures: the captures are copied to the console, and the version of the extension
 * that took them is written in `guide-captured.ts` and in the document. A process of its own: the
 * specs are not modules, and this file reads its own address.
 */

export const REVIEWING = fileURLToPath(new URL('../../docs/reviewing.md', import.meta.url));
/** The captures, where the docs show them. */
export const GUIDE_DOCS = fileURLToPath(new URL('../../docs/assets/guide/', import.meta.url));
/** Their copy in the console, which serves them itself: its image holds no `docs/`. */
export const GUIDE_CONSOLE = fileURLToPath(new URL('./public/guide/', import.meta.url));
/** The module that says which version of the extension took them. */
export const CAPTURED_MODULE = fileURLToPath(new URL('./app/guide-captured.ts', import.meta.url));

/** The document as it should be: its block written from the steps and the version of the captures. */
export function reviewingWithGuide(captured: GuideCaptured = GUIDE_CAPTURED): string {
  return withGuideBlock(readFileSync(REVIEWING, 'utf8'), guideMarkdown(captured));
}

export function writeGuideDocs(captured: GuideCaptured = GUIDE_CAPTURED): void {
  writeFileSync(REVIEWING, reviewingWithGuide(captured));
}

/** Writes the version of the extension that took the captures into `guide-captured.ts`. */
export function writeCaptured(captured: GuideCaptured): void {
  const source = readFileSync(CAPTURED_MODULE, 'utf8');
  const next = source.replace(/\{ extension: '[^']*' \}/, `{ extension: '${captured.extension}' }`);
  if (next === source && !source.includes(`'${captured.extension}'`))
    throw new Error('guide-captured.ts holds no version');
  writeFileSync(CAPTURED_MODULE, next);
}

/** Copies the captures of the docs to the console, which serves its own copy. */
export function copyCaptures(): void {
  mkdirSync(GUIDE_CONSOLE, { recursive: true });
  for (const file of readdirSync(GUIDE_DOCS)) copyFileSync(join(GUIDE_DOCS, file), join(GUIDE_CONSOLE, file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--captured');
  const version = at === -1 ? undefined : process.argv[at + 1];
  if (version === undefined) {
    writeGuideDocs();
  } else {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
    copyCaptures();
    writeCaptured({ extension: version });
    writeGuideDocs({ extension: version });
  }
}
