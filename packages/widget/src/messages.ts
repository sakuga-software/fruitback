import type { SeedStage } from '@fruitback/shared';

/**
 * Every word the widget shows, and the one language the bundle carries (SKG-530).
 *
 * English is the only catalog in the bundle. A host adds others through `init({ messages })`, and
 * no i18n library ships: a record of strings and `Intl.PluralRules` are enough.
 *
 * Rules that a change here must keep:
 *
 * - `ENGLISH` is exhaustive. A key the code asks for and English lacks is a type error.
 * - A host message is parsed like a stored config: field by field. A bad entry costs that entry,
 *   and the English one takes its place. It never costs the mount.
 * - A message is text. The widget writes it with `textContent` or an attribute, never as markup.
 * - `settings.open` and `settings.dialog` must stay different: they are the accessible names of the
 *   gear and of the dialog it opens.
 */

/** One string per plural category. `other` is required, because every locale has it. */
export type PluralMessage = { readonly [Category in Intl.LDMLPluralRule]?: string } & { readonly other: string };

export const ENGLISH = {
  'launch.label': 'Leave feedback',
  'launch.capturing': 'Esc to cancel',

  'settings.open': 'Open Fruitback settings',
  'settings.dialog': 'Fruitback settings',
  'settings.title': 'Settings',
  'settings.close': 'Close settings',
  'settings.endpoint': 'Worker',
  'settings.client': 'Client',
  'settings.stages': 'Pins shown',
  'settings.hideResolved': 'Hide resolved feedback',
  'settings.screenshot': 'Attach a picture of the element',

  'composer.placeholder': 'What is wrong here?',
  'composer.label': 'Your comment',
  'composer.identify': 'Add my name (optional)',
  'composer.namePlaceholder': 'Your name',
  'composer.nameLabel': 'Your name (optional)',
  'composer.emailPlaceholder': 'you@example.com',
  'composer.emailLabel': 'Your email (optional)',
  'composer.cancel': 'Cancel',
  'composer.send': 'Plant',
  'composer.sending': 'planting…',
  'composer.harvested': 'harvested',
  'composer.failed': 'did not go through — your text is kept, try again',

  'pin.label': '{stage} · {note}',
  'pin.labelUncertain': '{stage} · {note} (approximate position)',

  'thread.close': 'Close',
  'thread.noNote': 'No note.',
  'thread.noReplies': 'No reply yet.',
  'thread.team': 'Team',
  'thread.anonymous': 'Anonymous',
  'thread.orphan': 'Element not found — approximate position.',
  'thread.uncertain': 'Element found by its position, not by its identity — the page may have changed under the pin.',

  'orphans.count': { one: '{count} detached note', other: '{count} detached notes' },
  'orphans.entry': '{stage} · {note}',

  'stage.seeded': 'Seeded',
  'stage.green': 'Green',
  'stage.ripening': 'Ripening',
  'stage.ripe': 'Ripe',
  'stage.composted': 'Composted',
} as const satisfies Record<string, string | PluralMessage> & Record<`stage.${SeedStage}`, string>;

export type MessageKey = keyof typeof ENGLISH;

type PluralKey = { [Key in MessageKey]: (typeof ENGLISH)[Key] extends string ? never : Key }[MessageKey];
type TextKey = Exclude<MessageKey, PluralKey>;

/** What a host can override for one locale. A key left out falls back to English. */
export type FruitbackMessages = { readonly [Key in TextKey]?: string } & {
  readonly [Key in PluralKey]?: PluralMessage;
};

type Values = Readonly<Record<string, string | number>>;

export type Translator = {
  /** The locale the reader asked for, after validation. Dates follow it. */
  readonly locale: string;
  text(key: TextKey, values?: Values): string;
  plural(key: PluralKey, count: number, values?: Values): string;
  stage(stage: SeedStage): string;
  date(date: Date): string;
};

export type TranslatorOptions = {
  /** Wins over `language`. */
  locale?: string;
  /** Catalogs by locale tag, for example `{ fr: {…}, 'pt-BR': {…} }`. */
  messages?: Readonly<Record<string, FruitbackMessages>>;
  /**
   * The browser's language. Read it from the mounted document's own window, never from
   * `globalThis`: see `languageOf`.
   */
  language?: string;
};

const FALLBACK_LOCALE = 'en';

/**
 * Choose a catalog and build the functions that read it.
 *
 * The catalog match is the exact tag first, then the primary subtag, then English. The plural rules
 * follow the catalog that supplied the message, so an English fallback under a French locale still
 * says "0 detached notes".
 */
export function createTranslator(options: TranslatorOptions = {}): Translator {
  const locale = validLocale(options.locale) ?? validLocale(options.language) ?? FALLBACK_LOCALE;
  const match = catalogFor(locale, options.messages);
  const rules = new Map<string, Intl.PluralRules>();

  function rulesFor(tag: string): Intl.PluralRules {
    let found = rules.get(tag);
    if (found === undefined) {
      found = new Intl.PluralRules(tag);
      rules.set(tag, found);
    }

    return found;
  }

  function text(key: TextKey, values?: Values): string {
    const own = match?.catalog[key];

    return format(typeof own === 'string' ? own : ENGLISH[key], values);
  }

  function plural(key: PluralKey, count: number, values?: Values): string {
    const own = match?.catalog[key];
    const [message, tag]: [PluralMessage, string] =
      isPluralMessage(own) && match !== undefined ? [own, match.tag] : [ENGLISH[key], FALLBACK_LOCALE];
    const category = rulesFor(tag).select(count);

    return format(message[category] ?? message.other, { ...values, count });
  }

  return {
    locale,
    text,
    plural,
    stage: (stage) => text(`stage.${stage}`),
    date: (date) => date.toLocaleDateString(locale),
  };
}

/** The language of the page the widget is mounted on, from that page's own window. */
export function languageOf(document: Document): string | undefined {
  return document.defaultView?.navigator?.language || undefined;
}

/**
 * A canonical tag, or `undefined` for anything `Intl` refuses.
 *
 * `new Intl.PluralRules('not a locale')` throws a `RangeError`. A host typo must cost the
 * translation, never the mount.
 */
function validLocale(tag: string | undefined): string | undefined {
  if (typeof tag !== 'string' || tag.trim() === '') return undefined;

  try {
    const [canonical] = Intl.getCanonicalLocales(tag.trim());
    if (canonical === undefined) return undefined;
    new Intl.PluralRules(canonical);

    return canonical;
  } catch {
    return undefined;
  }
}

function catalogFor(
  locale: string,
  messages: TranslatorOptions['messages'],
): { tag: string; catalog: Readonly<Record<string, unknown>> } | undefined {
  if (typeof messages !== 'object' || messages === null) return undefined;

  const byTag = new Map<string, { tag: string; catalog: Readonly<Record<string, unknown>> }>();
  for (const [tag, catalog] of Object.entries(messages)) {
    const valid = validLocale(tag);
    if (valid === undefined || typeof catalog !== 'object' || catalog === null) continue;
    byTag.set(valid.toLowerCase(), { tag: valid, catalog: catalog as Readonly<Record<string, unknown>> });
  }

  const primary = locale.split('-')[0] ?? locale;

  return byTag.get(locale.toLowerCase()) ?? byTag.get(primary.toLowerCase());
}

function isPluralMessage(value: unknown): value is PluralMessage {
  if (typeof value !== 'object' || value === null) return false;

  return (
    Object.values(value).every((form) => typeof form === 'string') && typeof (value as PluralMessage).other === 'string'
  );
}

/**
 * Replace each `{name}` with its value, in one pass.
 *
 * One pass, so a value that contains `{count}` stays as the reader wrote it. A name with no value
 * stays literal, which a translator sees and a reader survives.
 */
function format(message: string, values?: Values): string {
  if (values === undefined) return message;

  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}
