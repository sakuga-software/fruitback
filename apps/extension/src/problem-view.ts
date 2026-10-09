import { PAIRING_GUIDE, REMEDY_LABEL, type Remedy, remedyFor } from './remedy.ts';
import { t } from './i18n.ts';

/**
 * A problem and the one thing to do about it, drawn the same way on the popup and on the options
 * page (FRU-90).
 */

/** What each button does on the page that shows it. A remedy with no handler here gets no button. */
export type RemedyHandlers = Partial<Record<Exclude<Remedy, 'guide'>, () => void>>;

/**
 * Writes `text` into `target`, with the button of its remedy.
 *
 * The handler runs in the click of that button. A handler that asks for a permission must ask
 * before it awaits anything: the browser drops the gesture after an `await`, and no prompt shows.
 */
export function showProblem(target: HTMLElement, text: string, handlers: RemedyHandlers = {}): void {
  // The English text finds the remedy. The screen shows the sentence in the language of the reviewer.
  target.replaceChildren(t(text));
  if (text === '') return;

  const remedy = remedyFor(text);
  if (remedy === null) return;

  const document = target.ownerDocument;
  if (remedy === 'guide') {
    const link = document.createElement('a');
    link.textContent = t(REMEDY_LABEL.guide);
    link.href = PAIRING_GUIDE;
    link.target = '_blank';
    link.rel = 'noreferrer';
    target.append(' ', link);

    return;
  }

  const run = handlers[remedy];
  if (run === undefined) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'remedy';
  button.textContent = t(REMEDY_LABEL[remedy]);
  button.addEventListener('click', run);
  target.append(' ', button);
}
