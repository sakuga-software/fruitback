import { locale, t } from './i18n.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The calendar day of a moment, in the time zone of the browser: « Yesterday » is a day, not 24 h. */
function dayOf(at: Date): number {
  return Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
}

/**
 * How long ago something happened, in the words of the mockup: « 12 min ago », « 2 h ago »,
 * « Yesterday », then the day (« 3 Oct », with its year when it is not this year).
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
  const today = new Date(now);
  const days = Math.round((dayOf(today) - dayOf(at)) / (24 * HOUR));
  if (days === 0) return t('{count} h ago', { count: Math.floor(past / HOUR) });
  if (days === 1) return t('Yesterday');

  return at.toLocaleDateString(locale(), {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}
