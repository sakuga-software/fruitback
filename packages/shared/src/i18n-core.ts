/**
 * What the words of the console and of the extension share (FRU-512): which language a tag reads,
 * and a sentence with its `{name}` filled. Each keeps its own catalogs and how it loads them.
 */

/** The language of `languages` nearest to a tag: `fr-CA` reads `fr`; an unknown tag reads `fallback`. */
export function nearestLanguage<L extends string>(
  tag: string | undefined | null,
  languages: readonly L[],
  fallback: L,
): L {
  const base = (tag ?? '').toLowerCase().split('-')[0];

  return languages.find((language) => language === base) ?? fallback;
}

/** The sentence with each `{name}` that `values` holds replaced, and any other left as written. */
export function fillSentence(sentence: string, values: Readonly<Record<string, string | number>> = {}): string {
  return sentence.replaceAll(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
