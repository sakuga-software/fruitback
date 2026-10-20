import { locale, t } from './i18n.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
 */
export function ago(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const past = Math.max(0, now - at.getTime());
  if (past < MINUTE) return t('Just now');
  if (past < HOUR) return t('{count} min ago', { count: Math.floor(past / MINUTE) });
  // Hours for a whole day: a note of 22:30 read at 00:30 is « 2 h ago », not « Yesterday ».
  if (past < 24 * HOUR) return t('{count} h ago', { count: Math.floor(past / HOUR) });
  const today = new Date(now);
  const days = Math.round((calendarDayOf(today) - calendarDayOf(at)) / (24 * HOUR));
  if (days <= 1) return t('Yesterday');
  if (days < 7) return t('{count} days ago', { count: days });

  return at.toLocaleDateString(locale(), {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

const DAYS = { en: 'en-GB', fr: 'fr' } as const;

/** A day, as « 18 Sep », with its year when it is not this year: when a workspace was made, or suspended. */
export function dayOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  return date.toLocaleDateString(DAYS[locale()], {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' as const }),
  });
}
