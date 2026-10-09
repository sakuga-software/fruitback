import { type CloudSeams, accountLanguage } from './cloud.ts';
import { LANGUAGE_KEY, type LanguageArea, storedLanguage } from './language.ts';

/**
 * Asks the workers this browser is paired with, and keeps the answer.
 *
 * - An account that holds a language: the language is kept.
 * - A worker that answers, and no account holds a language: the kept language is removed.
 * - No session: the kept language is removed. A reviewer who logged out reads their browser's language.
 * - A worker that does not answer, and no other one says a language: nothing changes. An outage must
 *   not change the language, and the worker that is down can be the one that holds the account.
 */
export async function rememberLanguage(area: LanguageArea, seams: CloudSeams): Promise<void> {
  const answer = await accountLanguage(seams);
  if (answer === 'no-answer') return;

  // WARNING: the answer took a call to the worker, and a log out can land in that time. The sessions
  // are read again here: the language of an account must not be kept for a browser that left it.
  let locale = answer.locale;
  if (answer.from !== undefined) {
    const paired = await seams.endpoints();
    if (!paired.includes(answer.from)) {
      // The session that said this language is gone. With another session left, nothing is known
      // about its language: the log out asks again, and that answer decides.
      if (paired.length > 0) return;
      locale = undefined;
    }
  }

  const kept = await storedLanguage(area);
  if (locale === kept) return;
  if (locale === undefined) await area.remove(LANGUAGE_KEY);
  else await area.set({ [LANGUAGE_KEY]: locale });
}
