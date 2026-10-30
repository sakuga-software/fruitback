/**
 * The words of the console, in the language of the person (FRU-120).
 *
 * **The English sentence is the key.** A screen reads `t('Create your workspace')`, so it stays
 * readable, and a language is one map from the English sentence to its own. English needs no map. A
 * sentence with no translation is shown in English: a missing word must not empty a button.
 *
 * `messages.test.ts` reads the sources: every sentence a screen shows is in the French map, and the
 * map holds no sentence that no screen shows.
 *
 * **A map is loaded when its language is asked for** (FRU-494). The French map is 112 kB, and a
 * person who reads English never downloads it. `setLocale` loads the map first, and changes the
 * language only when it is there: a screen never shows a mix of the two languages. The root waits
 * for `ready()` before its first render, so a French browser shows French from the first frame.
 */
export const LOCALES = [
  { tag: 'en', name: 'English' },
  { tag: 'fr', name: 'Français' },
] as const;
export type LocaleTag = (typeof LOCALES)[number]['tag'];

type Catalog = Readonly<Record<string, string>>;

/**
 * WARNING: `import()` only. A static import puts the map in the chunk that every page loads, and
 * `catalog-chunk.test.ts` fails on it.
 */
const LOADERS: Record<LocaleTag, (() => Promise<Catalog>) | undefined> = {
  en: undefined,
  fr: () => import('./messages.fr.ts').then((module) => module.FRENCH),
};
const CATALOGS: Partial<Record<LocaleTag, Catalog>> = {};
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

/** The language of the screens. It changes only when its map is loaded. */
let current: LocaleTag = 'en';
/** The language asked for last. A map that arrives for a language asked for before it is not used. */
let wanted: LocaleTag = 'en';
let loading: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

export function locale(): LocaleTag {
  return current;
}

function loaded(tag: LocaleTag): boolean {
  return LOADERS[tag] === undefined || CATALOGS[tag] !== undefined;
}

function show(tag: LocaleTag): void {
  if (tag === current) return;
  current = tag;
  for (const listener of listeners) listener();
}

/**
 * Changes the language of every screen, once its map is loaded. `remember` keeps it for the next
 * visit of this browser. A language whose map is loaded already changes before this returns.
 *
 * A map that fails to load leaves the language as it is: English words are better than no words.
 */
export function setLocale(tag: string, remember = true): Promise<void> {
  const next = nearest(tag);
  if (remember) {
    try {
      globalThis.localStorage?.setItem(STORED, next);
    } catch {
      // Not kept: the account still holds the choice.
    }
  }
  wanted = next;
  if (loaded(next)) {
    show(next);
    loading = Promise.resolve();

    return loading;
  }
  loading = (LOADERS[next] as () => Promise<Catalog>)().then(
    (catalog) => {
      CATALOGS[next] = catalog;
      if (wanted === next) show(next);
    },
    () => {
      // Shown again in English. The next `setLocale` asks for the map again.
    },
  );

  return loading;
}

/** Done when the map of the language asked for last has loaded, or failed to. */
export function ready(): Promise<void> {
  return loading;
}

// The language of this browser, asked for when the bundle starts. `ready()` waits for it.
void setLocale(remembered() ?? globalThis.navigator?.language ?? 'en', false);

export function onLocale(listener: () => void): () => void {
  listeners.add(listener);

  return () => void listeners.delete(listener);
}

/** What keeps a choice between two visits. A browser can refuse it: every use is guarded. */
export type Kept = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Sends a language to the account. `false` when the account did not take it. */
export type SaveLanguage = (tag: LocaleTag) => Promise<boolean>;

const UNSENT = 'fruitback:locale-unsent';

function browserStorage(): Kept | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function unsent(kept: Kept | undefined): LocaleTag | undefined {
  try {
    const tag = kept?.getItem(UNSENT);

    return tag === null || tag === undefined ? undefined : nearest(tag);
  } catch {
    return undefined;
  }
}

function markUnsent(kept: Kept | undefined, tag: LocaleTag | undefined): void {
  try {
    if (tag === undefined) kept?.removeItem(UNSENT);
    else kept?.setItem(UNSENT, tag);
  } catch {
    // Not kept: the next visit reads the language of the account.
  }
}

/**
 * The person chose a language. The screen changes at once, and the account is told.
 *
 * WARNING: the account can fail to hear it. The choice is then marked as not sent, so the language
 * of the account does not take the place of what the person chose at the next visit. `false` says so
 * to the caller, for the screen.
 */
export async function chooseLanguage(tag: string, save: SaveLanguage, kept = browserStorage()): Promise<boolean> {
  const chosen = nearest(tag);
  const shown = setLocale(chosen);
  markUnsent(kept, chosen);
  const heard = await save(chosen).catch(() => false);
  if (heard) markUnsent(kept, undefined);
  await shown;

  return heard;
}

/**
 * Takes the language an account holds, when it holds one. The choice of a person follows them to a
 * browser that was set to another language.
 *
 * A choice the account never heard wins over the account, and is sent again: the person chose it
 * after the account was last written.
 */
export function adoptLanguage(account: { locale?: string }, save?: SaveLanguage, kept = browserStorage()): void {
  const waiting = unsent(kept);
  if (waiting !== undefined) {
    void setLocale(waiting);
    if (save !== undefined) {
      void save(waiting)
        .catch(() => false)
        .then((heard) => {
          if (heard) markUnsent(kept, undefined);
        });
    }

    return;
  }
  if (account.locale !== undefined) void setLocale(account.locale);
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
