import { locale, t } from './i18n.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The calendar day of a moment, in the time zone of the browser: « Yesterday » is a day, not 24 h. */
function calendarDayOf(at: Date): number {
  return Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
}

/**
 * How long ago something happened, in the words of the mockup: « 12 min ago », « 2 h ago » for the
 * 24 hours before, then by the day of the calendar:
 * « Yesterday », « 3 days ago » for a week, then the day (« Oct 3 », with its year when it is not this
 * year).
 *
 * A moment that the browser cannot read is shown as the worker wrote it, and one in the future (a
 * clock of the worker ahead of the browser) reads as now.
 *
 * This is the word of a cell, which starts with a capital. Inside a sentence, use `agoInSentence`.
 */
export function ago(iso: string, now: number = Date.now()): string {
  return said(iso, now, false);
}

/**
 * `ago` in the middle of a sentence (FRU-516): « used just now », « used yesterday », « used on Oct 3 ».
 * `ago` there read « used Just now », and French « utilisée le il y a 2 h ».
 */
export function agoInSentence(iso: string, now: number = Date.now()): string {
  return said(iso, now, true);
}

/** « Yesterday », or « 3 days ago », for 1 to 6 days before; `undefined` past the week. */
function inTheWeek(days: number, inSentence: boolean): string | undefined {
  if (days <= 1) return inSentence ? t('yesterday') : t('Yesterday');
  if (days < 7) return t('{count} days ago', { count: days });

  return undefined;
}

function said(iso: string, now: number, inSentence: boolean): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const past = Math.max(0, now - at.getTime());
  if (past < MINUTE) return inSentence ? t('just now') : t('Just now');
  if (past < HOUR) return t('{count} min ago', { count: Math.floor(past / MINUTE) });
  // Hours for a whole day: a note of 22:30 read at 00:30 is « 2 h ago », not « Yesterday ».
  if (past < DAY) return t('{count} h ago', { count: Math.floor(past / HOUR) });
  const today = new Date(now);
  const week = inTheWeek(Math.round((calendarDayOf(today) - calendarDayOf(at)) / DAY), inSentence);
  if (week !== undefined) return week;
  const day = at.toLocaleDateString(locale(), {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });

  return inSentence ? t('on {day}', { day }) : day;
}

/** « 3 Oct », as the mockup writes a day: the day first, in the language of the console. */
const DAYS = { en: 'en-GB', fr: 'fr' } as const;

/**
 * When a day shows its year: `auto` when it is not this year, `always`, or `never`. A list of
 * accounts says the year of each, an invitation of a few days says none.
 */
type YearShown = 'auto' | 'always' | 'never';

/** A day, as « 18 Sep », or `undefined` for a date that is not one. */
export function dayIn(iso: string | undefined, year: YearShown = 'auto'): string | undefined {
  const date = new Date(iso ?? '');
  if (Number.isNaN(date.getTime())) return undefined;
  const shown = year === 'always' || (year === 'auto' && date.getFullYear() !== new Date().getFullYear());

  return date.toLocaleDateString(DAYS[locale()], {
    day: 'numeric',
    month: 'short',
    ...(shown ? { year: 'numeric' as const } : {}),
  });
}

/**
 * A day, as « 18 Sep », with its year when it is not this year: when a workspace was made, or
 * suspended. A date that is not one is shown as the worker wrote it.
 */
export function dayOf(iso: string, year: YearShown = 'auto'): string {
  return dayIn(iso, year) ?? iso;
}

/** A day and a time, in the language of the console. A date that is not one is shown as written. */
export function moment(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * « Last seen » (FRU-249, Q7): the worker keeps a day of UTC and no hour, so that a colleague does not
 * learn when somebody works. « Today », « Yesterday », « 3 days ago » for the week, then the day.
 */
export function seenOn(day: string | undefined, now: number = Date.now()): string {
  if (day === undefined) return t('Not seen yet');
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) return day;
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.max(0, Math.round((today - at) / DAY));
  if (days === 0) return t('Today');

  return (
    inTheWeek(days, false) ??
    new Date(at).toLocaleDateString(DAYS[locale()], { day: 'numeric', month: 'short', timeZone: 'UTC' })
  );
}
