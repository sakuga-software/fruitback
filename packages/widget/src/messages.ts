import type { SeedStage } from '@fruitback/shared';
import { FRENCH } from './locale-fr.ts';

/**
 * Every word the widget shows, and the catalogs the bundle carries (SKG-530, SKG-531).
 *
 * English and French are maintained in this repository. A host adds or overrides others through
 * `init({ messages })`, and no i18n library ships: records of strings and `Intl` are enough.
 *
 * Rules that a change here must keep:
 *
 * - `ENGLISH` is exhaustive, and so is every bundled catalog. A missing key does not compile.
 * - A host message is parsed like a stored config: field by field. A bad entry costs that entry,
 *   and the next catalog in the chain takes its place. It never costs the mount.
 * - A message is text. The widget writes it with `textContent` or an attribute, never as markup.
 * - `settings.open` and `settings.dialog` must stay different: they are the accessible names of the
 *   gear and of the dialog it opens. The same applies to `widget.label`, `launch.label`,
 *   `composer.dialog` and `composer.label` (SKG-544).
 * - Each bundled catalog weighs on the size guard. If the list grows, load them lazily; do not widen
 *   the guard.
 */

/** One string per plural category. `other` is required, because every locale has it. */
export type PluralMessage = { readonly [Category in Intl.LDMLPluralRule]?: string } & { readonly other: string };

export const ENGLISH = {
  'launch.label': 'Leave feedback',
  'launch.capturing': 'Esc to cancel',
  'widget.label': 'Fruitback feedback',
  'capture.instructions': 'Point at an element, or move with the arrow keys and press Enter.',
  'capture.element': '{tag}: {text}',
  'capture.elementEmpty': '{tag}, no text',

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
  'composer.dialog': 'Leave a note',
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
  'thread.dialog': 'Feedback {identifier}',
  'thread.noNote': 'No note.',
  'thread.noReplies': 'No reply yet.',
  'thread.team': 'Team',
  'thread.anonymous': 'Anonymous',
  'thread.orphan': 'Element not found — approximate position.',
  'thread.uncertain': 'Element found by its position, not by its identity — the page may have changed under the pin.',
  // The arrow is in the message because a right-to-left catalog points it the other way.
  'thread.link': '{identifier} →',

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

/** A catalog maintained in this repository: every key, with the shape English gives it. */
export type Catalog = { readonly [Key in TextKey]: string } & { readonly [Key in PluralKey]: PluralMessage };

/** What a host can override for one locale. A key left out falls back to the next catalog. */
export type FruitbackMessages = { readonly [Key in TextKey]?: string } & {
  readonly [Key in PluralKey]?: PluralMessage;
};

/** The catalogs in the bundle, by locale tag. */
export const BUNDLED_CATALOGS: Readonly<Record<string, Catalog>> = { en: ENGLISH, fr: FRENCH };

export type Direction = 'ltr' | 'rtl';

type Values = Readonly<Record<string, string | number>>;

export type Translator = {
  /** The locale the reader asked for, after validation. Absolute dates follow it. */
  readonly locale: string;
  /** The language of the catalog the words come from. Relative dates follow it. */
  readonly lang: string;
  /** The reading direction of that language. Layout follows it; geometry never does. */
  readonly direction: Direction;
  text(key: TextKey, values?: Values): string;
  plural(key: PluralKey, count: number, values?: Values): string;
  stage(stage: SeedStage): string;
  date(date: Date): string;
  /** "3 hours ago", in the language of the words. */
  relative(date: Date): string;
};

export type TranslatorOptions = {
  /** Wins over `language`. */
  locale?: string;
  /** Host catalogs by locale tag, for example `{ fr: {…}, 'pt-BR': {…} }`. */
  messages?: Readonly<Record<string, FruitbackMessages>>;
  /**
   * The browser's language. Read it from the mounted document's own window, never from
   * `globalThis`: see `languageOf`.
   */
  language?: string;
  /** The clock relative dates count from. Tests set it; the widget uses `Date.now`. */
  now?: () => number;
};

const FALLBACK_LOCALE = 'en';

type Link = { tag: string; catalog: Readonly<Record<string, unknown>> };

/**
 * Build the functions that read the catalogs for one locale.
 *
 * The chain for `fr-CA` is: the host's `fr-CA`, the bundled `fr-CA`, the host's `fr`, the bundled
 * `fr`, then English. Each key takes the first catalog in the chain that has it in the right shape.
 * The plural rules and the number format follow the catalog that supplied the message, so an English
 * fallback under a French locale still says "0 detached notes".
 */
export function createTranslator(options: TranslatorOptions = {}): Translator {
  const locale = validLocale(options.locale) ?? validLocale(options.language) ?? FALLBACK_LOCALE;
  const chain = catalogsFor(locale, options.messages);
  const lang = chain[0]?.tag ?? FALLBACK_LOCALE;
  const now = options.now ?? Date.now;
  const pluralRules = cached((tag) => new Intl.PluralRules(tag));
  const numbers = cached((tag) => new Intl.NumberFormat(tag));
  const relativeTime = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });

  function text(key: TextKey, values?: Values): string {
    const found = chain.find((link) => typeof link.catalog[key] === 'string');

    return format(found === undefined ? ENGLISH[key] : String(found.catalog[key]), values);
  }

  function plural(key: PluralKey, count: number, values?: Values): string {
    const found = chain.find((link) => isPluralMessage(link.catalog[key]));
    const [message, tag]: [PluralMessage, string] =
      found === undefined ? [ENGLISH[key], FALLBACK_LOCALE] : [found.catalog[key] as PluralMessage, found.tag];
    const category = pluralRules(tag).select(count);

    return format(message[category] ?? message.other, { ...values, count: numbers(tag).format(count) });
  }

  return {
    locale,
    lang,
    direction: directionOf(lang),
    text,
    plural,
    stage: (stage) => text(`stage.${stage}`),
    date: (date) => date.toLocaleDateString(locale),
    relative(date) {
      const seconds = (date.getTime() - now()) / 1000;
      const [unit, span] = RELATIVE_UNITS.find(([, length]) => Math.abs(seconds) >= length) ?? ['second', 1];

      return relativeTime.format(Math.round(seconds / span), unit);
    },
  };
}

/** The language of the page the widget is mounted on, from that page's own window. */
export function languageOf(document: Document): string | undefined {
  return document.defaultView?.navigator?.language || undefined;
}

/** Largest first. Under a minute is counted in seconds, and `numeric: 'auto'` says "now" for zero. */
const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/**
 * The scripts written right to left.
 *
 * `Intl.Locale.getTextInfo` would answer directly, but Firefox does not implement it. The likely
 * script of a tag is available everywhere through `maximize`.
 */
const RIGHT_TO_LEFT_SCRIPTS = new Set(['Adlm', 'Arab', 'Hebr', 'Mand', 'Nkoo', 'Rohg', 'Syrc', 'Thaa']);

export function directionOf(tag: string): Direction {
  try {
    const script = new Intl.Locale(tag).maximize().script;

    return script !== undefined && RIGHT_TO_LEFT_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
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

function catalogsFor(locale: string, messages: TranslatorOptions['messages']): Link[] {
  const host = new Map<string, Link>();
  if (typeof messages === 'object' && messages !== null) {
    for (const [tag, catalog] of Object.entries(messages)) {
      const valid = validLocale(tag);
      if (valid === undefined || !suppliesAMessage(catalog)) continue;
      host.set(valid.toLowerCase(), { tag: valid, catalog });
    }
  }

  const bundled = new Map<string, Link>(
    Object.entries(BUNDLED_CATALOGS).map(([tag, catalog]) => [tag.toLowerCase(), { tag, catalog }]),
  );
  const primary = locale.split('-')[0] ?? locale;
  const tags = [...new Set([locale.toLowerCase(), primary.toLowerCase()])];

  return tags.flatMap((tag) => [host.get(tag), bundled.get(tag)]).filter((link) => link !== undefined);
}

/**
 * The first catalog in the chain sets the language and the reading direction. A catalog with no
 * usable message must not set them, because its reader sees English words.
 */
function suppliesAMessage(catalog: unknown): catalog is Readonly<Record<string, unknown>> {
  if (typeof catalog !== 'object' || catalog === null) return false;
  const entries = catalog as Readonly<Record<string, unknown>>;

  return (Object.keys(ENGLISH) as MessageKey[]).some((key) =>
    typeof ENGLISH[key] === 'string' ? typeof entries[key] === 'string' : isPluralMessage(entries[key]),
  );
}

function isPluralMessage(value: unknown): value is PluralMessage {
  if (typeof value !== 'object' || value === null) return false;

  return (
    Object.values(value).every((form) => typeof form === 'string') && typeof (value as PluralMessage).other === 'string'
  );
}

function cached<T>(build: (tag: string) => T): (tag: string) => T {
  const built = new Map<string, T>();

  return (tag) => {
    let value = built.get(tag);
    if (value === undefined) {
      value = build(tag);
      built.set(tag, value);
    }

    return value;
  };
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
