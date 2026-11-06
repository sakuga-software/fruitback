/**
 * Whether the widget asks a visitor for an address after a note (FRU-604), and what it keeps of the
 * answer.
 *
 * - **Once per browser, on this site.** After « Notify me » the question does not come back: the
 *   address served one note. After « No thanks » it comes back after `DECLINE_DAYS` days, not before.
 *   A question closed with no answer is not an answer: it comes back after the next note.
 * - **The address is never kept here.** Only the answer and its day: `yes`, or `no` and when. The
 *   address goes to the worker, for the one note, and to nobody else.
 * - A member, a reporter that the site names, and a worker that offers no token are never asked:
 *   `embed.ts` decides that before it asks this.
 */

/** The key, beside the preferences of the widget (`fruitback:config`). */
export const NOTIFY_ASK_KEY = 'fruitback:notify-ask';

/** How long a « No thanks » holds: 30 days. */
export const DECLINE_DAYS = 30;
const DECLINE_MS = DECLINE_DAYS * 24 * 60 * 60 * 1000;

export type NotifyAsk = {
  /** Whether the question may be asked now. */
  asks(): boolean;
  /** « Notify me » was answered, and the worker took the address. */
  accepted(): void;
  /** « No thanks » was answered. */
  declined(): void;
};

/**
 * The answer, in `area` (the `localStorage` of the page), or in memory when the browser refuses
 * it: then the question is asked once for this page, and comes back on the next load.
 */
export function createNotifyAsk(area: Storage | null, now: () => number = Date.now): NotifyAsk {
  let memory: string | null = null;
  const read = (): unknown => {
    let raw: string | null = memory;
    try {
      raw = area?.getItem(NOTIFY_ASK_KEY) ?? memory;
    } catch {
      raw = memory;
    }
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const write = (value: object): void => {
    memory = JSON.stringify(value);
    try {
      area?.setItem(NOTIFY_ASK_KEY, memory);
    } catch {
      // A full or refused storage keeps the answer for this page only.
    }
  };

  return {
    asks() {
      const stored = read();
      if (typeof stored !== 'object' || stored === null) return true;
      const { answer, at } = stored as { answer?: unknown; at?: unknown };
      if (answer === 'yes') return false;
      // A day in the future, or no day, is a « No thanks » of now: written by a page, not by us.
      if (answer === 'no') {
        if (typeof at !== 'number' || !Number.isFinite(at) || at > now()) return false;

        return now() - at >= DECLINE_MS;
      }

      return true;
    },
    accepted() {
      write({ answer: 'yes' });
    },
    declined() {
      write({ answer: 'no', at: now() });
    },
  };
}
