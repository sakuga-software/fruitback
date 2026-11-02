import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The source of the popup, for the tests that read it as text (FRU-560).
 *
 * The popup binds `browser` at import, so `node --test` cannot load it. Its code is split by screen
 * over the modules of `entrypoints/popup/`: a guard that read `main.ts` alone would read a part of
 * it and pass. This reads every module, sorted by name, as one text.
 */
const DIRECTORY = fileURLToPath(new URL('../entrypoints/popup/', import.meta.url));

/** The modules of the popup, as paths from this folder. `main.ts` is one of them, or this throws. */
export const POPUP_FILES: readonly string[] = (() => {
  const names = readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .toSorted();
  if (!names.includes('main.ts')) throw new Error(`no main.ts in ${DIRECTORY}`);

  return names.map((name) => `../entrypoints/popup/${name}`);
})();

/** Every module of the popup, as one text. */
export function popupSource(): string {
  return POPUP_FILES.map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')).join('\n');
}
