import type { NoteStage } from '@fruitback/shared';
import { FRENCH } from './locale-fr.ts';
import { frenchCatalog } from './typography.ts';

/**
 * Every word the widget shows, and the catalogs the bundle carries (FRU-37, FRU-38).
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
 *   `composer.dialog` and `composer.label` (FRU-51).
 * - Each bundled catalog weighs on the size guard. If the list grows, load them lazily; do not widen
 *   the guard.
 */

/** One string per plural category. `other` is required, because every locale has it. */
export type PluralMessage = { readonly [Category in Intl.LDMLPluralRule]?: string } & { readonly other: string };

export const ENGLISH = {
  'launch.label': 'Leave feedback',
  // The launch button while the session of the extension has ended (FRU-315): it opens the sign-in.
  'launch.signIn': 'Sign in to leave notes',
  // The launch button on a site whose notes are « Members only », for a reader with no session
  // (FRU-330), and what a press of it says. No note starts there.
  'launch.closed': 'Notes from members only',
  'launch.closedSentence': 'Only members of this site leave notes here. Ask its team to invite you.',
  'widget.label': 'Fruitback feedback',
  // The banner of a capture, in the dark capsule (FRU-258, FRU-303). `capture.bannerTouch` is the
  // same sentence on a touch screen, which has no Escape key and no arrows (FRU-157): it then stands
  // alone beside `capture.stop`.
  'capture.banner': 'Point at an element, or use the arrow keys',
  'capture.bannerTouch': 'Tap the part of the page your note is about',
  // The key drawn on the way out, before its word. A drawing: the button is named by `capture.stop`.
  'capture.escape': 'Esc',
  'capture.stop': 'Cancel',
  // Read after the banner by a screen reader, and not drawn: it follows `capture.escape`.
  'capture.instructions': 'Or move with the arrow keys and press Enter.',
  'capture.element': '{tag}: {text}',
  'capture.elementEmpty': '{tag}, no text',

  'settings.open': 'Open Fruitback settings',
  'settings.dialog': 'Fruitback settings',
  'settings.title': 'Settings',
  'settings.close': 'Close settings',
  'settings.stages': 'Pins shown',
  'settings.hideResolved': 'Hide resolved feedback',
  // FRU-472: the corner of the dock, under the statuses.
  'settings.position': 'Position',
  'settings.position.topLeft': 'Top left',
  'settings.position.topRight': 'Top right',
  'settings.position.bottomLeft': 'Bottom left',
  'settings.position.bottomRight': 'Bottom right',
  'settings.screenshot': 'Attach a picture of the element',
  'settings.copy': 'Copy the feedback as text',
  'settings.copied': 'Copied',
  'settings.copyManually': 'Copy the text from here',

  // FRU-332: the files of a note. The worker takes them only when the note goes to a tracker.
  'composer.attach': 'Attachments',
  'composer.attachMenu': 'Attach',
  'composer.attachFile': 'Add an attachment',
  'composer.attachArea': 'Capture an area',
  'composer.attachPage': 'Capture the whole page',
  'composer.attachDrop': 'Drag and drop',
  'composer.attachDropHere': 'Drop your files here',
  'composer.attachDropChoose': 'Choose a file',
  // `{keys}`: « ⌘V » on a Mac, « Ctrl+V » elsewhere (FRU-424).
  'composer.attachPaste': 'Paste a screenshot ({keys})',
  // Said in place of the four ways, when the note stays in Fruitback (`canAttach: false`).
  'composer.attachNoTracker': 'This note stays in Fruitback, with no tracker: it takes no file.',
  'composer.attachRemove': 'Remove {name}',
  'composer.attachSending': 'Sending…',
  // Why a file did not go, under its name. The text of the note stays in every case.
  'composer.attachTooLarge': 'Too large: 10 MB for an image, a PDF or a file, 2 MB for a text, 25 MB for a note',
  'composer.attachType': 'This file’s content does not match its extension. Choose another file.',
  'composer.attachTooMany': 'A note takes 5 files at most',
  'composer.attachNoTrackerShort': 'This destination takes no file',
  'composer.attachFull': 'Too many files on their way: send your notes first',
  'composer.attachSignedOut': 'Your session has ended. Sign in again.',
  'composer.attachCapture': 'The capture was not taken',
  // FRU-423: the browser refused the capture for want of a gesture on the extension.
  'composer.attachCapturePermission': 'Click the Fruitback icon in the toolbar, then try again.',
  'composer.attachRetry': 'Upload failed. Remove the file, then add it again.',
  'composer.failedAttachmentGone':
    'A file of this note is no longer on its way. Your text is still here. Remove the file, then send again.',
  'composer.failedNoTracker':
    'This destination takes no file. Your text is still here. Remove the files, then send again.',
  // The area that a capture takes (FRU-332). The keyboard is enough, and the help says how.
  'area.dialog': 'Choose an area of the page',
  'area.help':
    'Drag to draw an area. The arrows move it, Shift and the arrows change its size, Enter takes it, Esc cancels.',
  'area.take': 'Take this area',
  'area.cancel': 'Cancel',
  'composer.placeholder': 'What should change?',
  // The label above the field of the note (FRU-305), which names it.
  'composer.label': 'Your comment',
  // The name of the dialog.
  'composer.dialog': 'New note',
  // The button of the head that starts a capture again, keeping the text (FRU-305).
  'composer.pickAgain': 'Choose another element',
  // The same preference as `settings.screenshot`, said beside the note it applies to.
  'composer.picture': 'Attach a picture of the element',
  'composer.namePlaceholder': 'Your name',
  'composer.nameLabel': 'Name (optional)',
  'composer.remember': 'Remember me on this site',
  'composer.cancel': 'Cancel',
  'composer.send': 'Send',
  'composer.sending': 'Sending…',
  'composer.sent': 'Sent',
  // The card of a sent note (FRU-305): its identifier, what its pin does, and the way to the issue.
  'composer.sentAs': 'Sent as {identifier}',
  'composer.sentFollows': 'The pin stays here and follows the issue’s status.',
  'composer.sentOpen': 'Open →',
  // Where the note lands, in the foot (FRU-305): the place a member sees, or the team.
  'composer.lands': 'Creates a new issue in {destination}',
  'composer.landsTeam': 'Sent to the team',
  // The title of the card of a failed send (FRU-305), above the sentence of its cause.
  'composer.failedTitle': 'Not sent',
  // The sentence of a send that can be tried again, under that title.
  'composer.failedRetry': 'Your text is still here. Try again, or copy it before you close the page.',
  'composer.sentWithoutPicture':
    'Sent without the picture, which could not be taken. The pin stays here and follows the issue’s status.',
  'composer.keptWithoutPicture': 'Kept for later, without the picture',
  // A note kept for later rather than sent (FRU-124): the second action, and what it says once done.
  'composer.keep': 'Keep for later',
  // The text left on this element came back, from a reload or a closed composer (FRU-311).
  'composer.restored': 'Draft restored',
  'composer.kept': 'Kept for later',
  'composer.failed': 'Not sent. Your text is still here. Try again.',
  // Why a send failed, when trying again at once will not help (FRU-156).
  'composer.failedWait': 'Too many notes just now. Your text is still here. Send it again in a minute.',
  'composer.failedRefused':
    'This site refused the note from this address. Your text is still here. Tell the site’s team.',
  // A `401`: the session of the extension ended, or the token of the site is out of date (FRU-193).
  'composer.failedSignedOut': 'Your session has ended. Your text is still here. Sign in again, then send it.',
  // A `401` on a site whose notes are « Members only », for a page with no session (FRU-394).
  'composer.failedMembersOnly':
    'This site is for members only. Your text is still here. Sign in to Fruitback from the extension, then send it again.',
  // The button beside that sentence, when the host can open the sign-in (FRU-315).
  'composer.signIn': 'Sign in again',
  'composer.failedTooLarge':
    'This note is too large. Your text is still here. Shorten it, or turn the picture off in the settings.',
  // The line that says where the note goes (FRU-123). A member of the team reads it, nobody else.
  // `{destination}` is the name the worker gives a place, or `composer.destinationUnnamed`.
  'composer.destination': 'Send to: {destination}',
  'composer.destinations': 'Where this note goes',
  'composer.destinationUnnamed': 'Destination {position}',
  'composer.destinationGone':
    'Sending to {destination} is no longer possible. This note will go to the default destination.',

  // The name of a pin (FRU-252): its number and its status, as the mock-up names it, then the note.
  // `{stage}` is the name of the stage in lower case.
  'pin.label': 'Note {number}, {stage}: {note}',
  'pin.labelUncertain': 'Note {number}, {stage}, approximate position: {note}',
  'pin.labelDraft': 'Not sent yet · {note}',
  'pin.previewClick': 'Click to open',
  'pin.previewKey': 'Press Enter to open',

  'thread.close': 'Close the note',
  // The handle of the bubble (FRU-420): its name says every way to use it.
  'thread.move':
    'Move the note. The arrow keys move it by 16 px, Shift and an arrow by 48 px. Home or a double click puts it back.',
  'thread.dialog': 'Note {number}',
  'thread.draft': 'Not sent yet',
  // Must not start like `sidebar.dialog`: both can be open at once.
  'thread.draftDialog': 'Note not sent yet',
  'thread.noNote': 'No note.',
  // The title of the word of the status (FRU-419): since when the note is in it.
  'thread.stateSince': '{state} since {date}',
  'thread.replies': 'Replies',
  'thread.team': 'Team',
  /** A reply that an AI agent wrote, beside the name of its key (FRU-465). */
  'thread.agent': 'Agent',
  /** The reply the worker writes when the author edits their note (FRU-475). */
  'thread.edited': 'Edited the note',
  'reply.label': 'Reply',
  'reply.placeholder': 'Reply to {name}',
  'reply.placeholderAnonymous': 'Write a reply',
  'reply.send': 'Send',
  'reply.sendLabel': 'Send reply',
  'reply.sending': 'Sending…',
  'reply.sent': 'Sent',
  'reply.failed': 'Not sent. Your text is still here. Try again.',
  'reply.failedWait': 'Too many replies just now. Your text is still here. Send it again in a minute.',
  'reply.failedSignedOut': 'Your session has ended. Your text is still here. Sign in again, then send it.',
  // FRU-475: the author edits the text of their note, from its thread.
  'edit.open': 'Edit',
  'edit.openLabel': 'Edit your note',
  'edit.label': 'Your note',
  'edit.save': 'Save',
  'edit.cancel': 'Cancel',
  'edit.saving': 'Saving…',
  'edit.saved': 'Saved',
  'edit.failed': 'Not saved. Your text is still here. Try again.',
  'edit.failedWait': 'Too many requests just now. Your text is still here. Save it again in a minute.',
  'edit.failedSignedOut': 'Your session has ended. Your text is still here. Sign in again, then save it.',
  'edit.refused':
    'This note can no longer be edited: the team has started on it. Your text is still here. Send it as a reply.',
  'thread.anonymous': 'Anonymous',
  'thread.orphan': 'Element not found. The position is approximate.',
  'thread.uncertain': 'Element found by its position, not by its identity. The page may have changed under the pin.',
  // The identifier and an arrow, in a chip (FRU-256, FRU-304): the widget does not know the name of
  // the store behind the worker. A message all the same, so that a language can put a word around it.
  'thread.link': '{identifier} →',
  // FRU-332: the files of a sent note, as its tracker keeps them. The widget shows no file.
  'thread.attachments': { one: '{count} attachment', other: '{count} attachments' },
  'thread.attachmentsIn': 'in {identifier}',

  'orphans.count': { one: '{count} detached note', other: '{count} detached notes' },
  // The chip of the capsule of the dock (FRU-303), beside its dashed drop: the drop says « note ».
  'orphans.chip': { one: '{count} detached', other: '{count} detached' },
  'orphans.entry': '{stage} · {note}',

  // The list of every note of the page (FRU-129). `sidebar.open` and `sidebar.dialog` must stay
  // different: they name the button and its dialog.
  // And `sidebar.dialog` must not start like `thread.dialog`: both are open at once, and a reader
  // or a test that looks for « Note … » must find one.
  'sidebar.open': 'Show every note in a sidebar',
  // The same button while the notes of the page could not be read (FRU-316): its dot says why.
  'sidebar.openFailed': 'Show every note in a sidebar. They could not be read.',
  // FRU-394: the same button on a site that its members read, for a page with no session.
  'sidebar.openMembersOnly': 'Show every note in a sidebar. This site is for members only.',
  // The name of the dialog (FRU-259). Its head shows `sidebar.title`, then the host of the page.
  'sidebar.dialog': 'Notes on this page',
  'sidebar.title': 'Notes',
  // The way back from the thread of a note to the rows of the list, where the thread took their place (FRU-312).
  'sidebar.back': 'All notes',
  // The two buttons of the head of the board « Sidebar mode » (FRU-308). Each one closes the list.
  'sidebar.floating': 'Back to floating pins',
  'sidebar.close': 'Close the sidebar',
  // The scope of the board, with its one part: no number until a read answered.
  'sidebar.scope': 'This page',
  'sidebar.scopeCount': 'This page · {count}',
  // FRU-470: the notes of every page, when the host can read them.
  'sidebar.scopes': 'Which notes',
  'sidebar.allPages': 'All pages',
  'sidebar.allPagesCount': 'All pages · {count}',
  'sidebar.thisPage': 'this page',
  'sidebar.siteLoading': 'Reading the notes of every page…',
  'sidebar.siteEmpty': 'No note on this site yet.',
  'sidebar.siteFailed': 'The notes of the other pages could not be read.',
  'sidebar.siteSignedOut': 'Sign in to see the notes of every page.',
  'sidebar.siteUnavailable': 'The notes of the other pages cannot be read here.',
  'sidebar.more': 'Show more',
  'sidebar.search': 'Search notes',
  // The group of the chips of the statuses, and the chip of every status. A number follows each word.
  'sidebar.stages': 'Status',
  'sidebar.all': 'All',
  // A search or a chip that keeps nothing, on a page that has notes.
  'sidebar.noMatch': 'No note matches.',
  'sidebar.replies': { one: '{count} reply', other: '{count} replies' },
  'sidebar.noReply': 'no reply',
  // After the date of a note whose element is under the part of the page in sight.
  'sidebar.below': 'further down',
  'sidebar.unplaced': { one: '{count} detached note', other: '{count} detached notes' },
  'sidebar.unplacedWhy': 'the element it pointed at is gone',
  'sidebar.empty': 'No note on this page yet.',
  'sidebar.loading': 'Reading the notes of this page…',
  'sidebar.failed': 'The notes of this page could not be read. They are not lost.',
  'sidebar.retry': 'Try again',
  // The list while the session of the extension has ended (FRU-315), and its one button.
  'sidebar.signedOut': 'Sign in to see the notes of this page.',
  'sidebar.signIn': 'Sign in',
  // The list of a site that its members read, for a page with no session (FRU-394). Not « could not
  // be read »: a second try is refused the same way.
  'sidebar.membersOnly': 'This site is for members only. Sign in to Fruitback from the extension to see its notes.',
  'sidebar.approximate': 'Approximate position',
  // The notes kept for later in this tab, on every page, and the button that sends them (FRU-124).
  'sidebar.drafts': 'Kept for later, not sent yet',
  'sidebar.sendDrafts': { one: 'Send {count} note', other: 'Send the {count} notes' },
  'sidebar.draftsSent': { one: '{count} note sent', other: '{count} notes sent' },
  // The switch at the foot of the list: off, the pins go while the list is open (FRU-308).
  'sidebar.showPins': 'Show pins on the page',

  // The words of the text a reviewer copies (FRU-109). They are labels in front of a value.
  'export.title': 'Feedback on {url}',
  'export.empty': 'No feedback on this page.',
  'export.element': 'Element: {element}',
  'export.component': 'Component: {component}',
  'export.by': 'By: {name}',
  'export.written': 'Written: {date}',
  'export.approximate': 'Position: approximate, found by its place on the page, not by its identity',
  'export.detached': 'Position: element not found on this page',
  'export.picture': 'Picture: {url}',
  'export.reply': 'Reply from {author}',

  'stage.new': 'New',
  'stage.todo': 'To do',
  'stage.progress': 'In progress',
  'stage.done': 'Done',
  'stage.closed': 'Closed',
} as const satisfies Record<string, string | PluralMessage> & Record<`stage.${NoteStage}`, string>;

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
// French is set with its narrow no-break spaces once, here (FRU-517).
export const BUNDLED_CATALOGS: Readonly<Record<string, Catalog>> = { en: ENGLISH, fr: frenchCatalog(FRENCH) };

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
  stage(stage: NoteStage): string;
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
