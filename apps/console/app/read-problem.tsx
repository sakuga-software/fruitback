import { useEffect, useState } from 'react';
import { t } from './i18n';
import { SERVER_PROBLEM, UNREACHABLE_PROBLEM } from './problems';
import { onReachability } from './transport';
import { useLocale } from './use-locale';

/**
 * Why a read failed, in one sentence that says what to do (FRU-516).
 *
 * A screen keeps a failed read as `failed`, with no status. The way to the worker knows the cause:
 * no answer at all makes it unreachable (and the banner of the root says so), and an answer that is an
 * error keeps it reachable. « Fruitback did not answer » was said for both, and a `500` is an answer.
 */
export function ReadProblem() {
  useLocale();
  const [reachable, setReachable] = useState(true);
  useEffect(() => onReachability(setReachable), []);

  return <>{t(reachable ? SERVER_PROBLEM : UNREACHABLE_PROBLEM)}</>;
}
