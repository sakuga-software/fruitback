import { FRENCH } from './messages.fr.ts';

/**
 * The words of the popup and of the options page, in the language of the reviewer (FRU-131).
 *
 * The English sentence is the key. A constant keeps its English sentence, and the sentence is
 * translated where it is written on the screen: `remedyFor` finds a problem by its English text, and
 * the guide is checked against the English words of the popup. A sentence with no French is shown in
 * English: a missing word must not empty a button.
 */
export const LANGUAGES = ['en', 'fr'] as const;
export type Language = (typeof LANGUAGES)[number];

const CATALOGS: Record<Language, Readonly<Record<string, string>>> = { en: {}, fr: FRENCH };

/** The language of the catalog for a locale tag: `fr-CA` reads French, an unknown tag reads English. */
export function nearest(tag: string | undefined): Language {
  const base = tag?.toLowerCase().split('-')[0];

  return LANGUAGES.find((language) => language === base) ?? 'en';
}

let current: Language = 'en';

export function setLanguage(tag: string | undefined): void {
  current = nearest(tag);
}

export function language(): Language {
  return current;
}

type Values = Readonly<Record<string, string | number>>;

export function translate(to: Language, sentence: string, values: Values = {}): string {
  const words = CATALOGS[to][sentence] ?? sentence;

  return words.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** The sentence in the language of the reviewer. Call it where the text goes on the screen. */
export function t(sentence: string, values?: Values): string {
  return translate(current, sentence, values);
}

/** Marks a sentence that is kept in a constant and translated where it is shown. */
export function msg(sentence: string): string {
  return sentence;
}
