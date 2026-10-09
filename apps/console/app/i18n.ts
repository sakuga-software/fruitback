import { FRENCH } from './messages.fr.ts';

/**
 * The words of the console, in the language of the person (FRU-120).
 *
 * **The English sentence is the key.** A screen reads `t('Create your workspace')`, so it stays
 * readable, and a language is one map from the English sentence to its own. English needs no map. A
 * sentence with no translation is shown in English: a missing word must not empty a button.
 *
 * `messages.test.ts` reads the sources: every sentence a screen shows is in the French map, and the
 * map holds no sentence that no screen shows.
 */
export const LOCALES = [
  { tag: 'en', name: 'English' },
  { tag: 'fr', name: 'Français' },
] as const;
export type LocaleTag = (typeof LOCALES)[number]['tag'];

const CATALOGS: Record<LocaleTag, Readonly<Record<string, string>> | undefined> = { en: undefined, fr: FRENCH };
const STORED = 'fruitback:locale';

/** The language we have words for that is nearest to a tag: `fr-CA` reads French, `ja` reads English. */
export function nearest(tag: string | undefined | null): LocaleTag {
  const base = (tag ?? '').toLowerCase().split('-')[0];

  return LOCALES.some((locale) => locale.tag === base) ? (base as LocaleTag) : 'en';
}

function remembered(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORED) ?? null;
  } catch {
    // Private browsing can refuse storage. The language of the browser applies.
    return null;
  }
}

let current: LocaleTag = nearest(remembered() ?? globalThis.navigator?.language);
const listeners = new Set<() => void>();

export function locale(): LocaleTag {
  return current;
}

/** Changes the language of every screen. `remember` keeps it for the next visit of this browser. */
export function setLocale(tag: string, remember = true): void {
  const next = nearest(tag);
  if (remember) {
    try {
      globalThis.localStorage?.setItem(STORED, next);
    } catch {
      // Not kept: the account still holds the choice.
    }
  }
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function onLocale(listener: () => void): () => void {
  listeners.add(listener);

  return () => void listeners.delete(listener);
}

/**
 * Takes the language an account holds, when it holds one. The choice of a person follows them to a
 * browser that was set to another language.
 */
export function adoptLanguage(account: { locale?: string }): void {
  if (account.locale !== undefined) setLocale(account.locale);
}

/** A sentence that a table holds, to translate where it is shown. It marks the sentence for the guard. */
export function msg(sentence: string): string {
  return sentence;
}

/** The sentence in the language of the person, with each `{name}` replaced. */
export function t(sentence: string, values: Readonly<Record<string, string | number>> = {}): string {
  return translate(current, sentence, values);
}

export function translate(
  tag: LocaleTag,
  sentence: string,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const words = CATALOGS[tag]?.[sentence] ?? sentence;

  return words.replaceAll(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
