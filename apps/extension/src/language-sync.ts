import { type CloudSeams, accountLanguage } from './cloud.ts';
import { LANGUAGE_KEY, type LanguageArea, storedLanguage } from './language.ts';

/**
 * Asks the workers this browser is paired with, and keeps the answer.
 *
 * - An account that holds a language: the language is kept.
 * - A worker that answers, and no account holds a language: the kept language is removed.
 * - No session: the kept language is removed. A reviewer who logged out reads their browser's language.
 * - Sessions, and no worker answers: nothing changes. An outage must not change the language.
 */
export async function rememberLanguage(area: LanguageArea, seams: CloudSeams): Promise<void> {
  const answer = await accountLanguage(seams);
  if (answer === 'no-answer') return;

  const kept = await storedLanguage(area);
  if (answer.locale === kept) return;
  if (answer.locale === undefined) await area.remove(LANGUAGE_KEY);
  else await area.set({ [LANGUAGE_KEY]: answer.locale });
}
