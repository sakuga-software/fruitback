import { readFile } from 'node:fs/promises';
import { sheetOfSource } from '../build-styles.ts';

/**
 * The CSS of a module, for the guard tests that read it (FRU-680).
 *
 * A module that is not converted yet has its `STYLES` in `<module>.styles.ts` (FRU-509). A module
 * converted to Tailwind has none: its CSS is the rules of the utilities its source writes, built by
 * the same compiler as the sheet of the widget. A selector there is a utility (`.fruitback\:end-4`)
 * or a corner of the dock (`:host([data-fruitback-position$=-left]) .fruitback\:…`).
 */
export async function moduleSheet(file: string): Promise<string> {
  const url = new URL(`./${file.replace(/\.ts$/, '.styles.ts')}`, import.meta.url);
  const source = await readFile(url, 'utf8').catch(() => undefined);
  if (source !== undefined) {
    const sheet = /const STYLES = `([^`]*)`/.exec(source)?.[1];
    if (sheet === undefined) throw new Error(`${file} has a styles file with no STYLES literal`);

    return sheet;
  }

  return sheetOfSource(await readFile(new URL(`./${file}`, import.meta.url), 'utf8'));
}

/** Whether `file` is converted: no `*.styles.ts` beside it. */
export async function converted(file: string): Promise<boolean> {
  const url = new URL(`./${file.replace(/\.ts$/, '.styles.ts')}`, import.meta.url);

  return readFile(url, 'utf8').then(
    () => false,
    () => true,
  );
}

/**
 * The class list of each part of a converted module, by the class of the part: the array that
 * starts with it, `['fruitback-orphans', 'fruitback:fixed …'].join(' ')`.
 */
export async function partsOf(file: string): Promise<Map<string, string>> {
  const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
  const parts = new Map<string, string>();
  for (const [, hook, rest] of source.matchAll(/\[\s*'(fruitback-[a-z-]+)[^']*',([\s\S]*?)\]\.join\(' '\)/g)) {
    if (hook !== undefined && rest !== undefined) parts.set(hook, `${parts.get(hook) ?? ''} ${rest}`);
  }

  return parts;
}
