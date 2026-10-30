import { useEffect, useState } from 'react';
import { t } from './i18n';
import { SERVER_CAUSE, SERVER_PROBLEM, UNREACHABLE_CAUSE, UNREACHABLE_PROBLEM } from './problems';
import { isReachable, onReachability } from './transport';
import { useLocale } from './use-locale';

/**
 * Why a read failed, in one sentence that says what to do (FRU-516).
 *
 * A screen keeps a failed read as `failed`, with no status. The way to the worker knows the cause:
 * no answer at all makes it unreachable (and the banner of the root says so), and an answer that is an
 * error keeps it reachable. « Fruitback did not answer » was said for both, and a `500` is an answer.
 *
 * Beside a « Try again » button the sentence says the cause alone. `alone`: no button is there, so the
 * sentence says to try again too.
 */
export function ReadProblem({ alone = false }: { alone?: boolean }) {
  useLocale();
  // Read at once, so the first paint already says the cause; the subscription follows its changes.
  const [reachable, setReachable] = useState(isReachable);
  useEffect(() => onReachability(setReachable), []);
  if (alone) return <>{t(reachable ? SERVER_PROBLEM : UNREACHABLE_PROBLEM)}</>;

  return <>{t(reachable ? SERVER_CAUSE : UNREACHABLE_CAUSE)}</>;
}
