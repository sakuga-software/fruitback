import type { TabCommandAnswer } from './tab-command.ts';

/**
 * The first activation of a site from the welcome page opens the choice of an element (FRU-485):
 * the person turned the site on to leave a note, so « Leave feedback » is pressed for them, once.
 * The popup does not do it: there « Turn on » can come before a read of the notes.
 *
 * The seam is the command of the popup (`leave-feedback`, FRU-254): the widget knows no extension,
 * and receives the same command as a press in the popup. Escape leaves the choice, as after a press.
 */

/** The origins whose first activation opened the choice already, in `storage.local`. */
export const FIRST_PICK_KEY = 'fruitback:first-pick';

export type FirstPickArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

/**
 * Whether this activation of `origin` is its first one, and marks it as done. A second activation,
 * after « Turn off », or in another tab, answers `false`: the choice opens once per origin.
 */
export async function firstActivation(area: FirstPickArea, origin: string): Promise<boolean> {
  const stored = (await area.get(FIRST_PICK_KEY))[FIRST_PICK_KEY];
  const done = Array.isArray(stored) ? stored.filter((each): each is string => typeof each === 'string') : [];
  if (done.includes(origin)) return false;
  await area.set({ [FIRST_PICK_KEY]: [...done, origin] });

  return true;
}

/**
 * Sends `leave-feedback` until the widget of the tab answers, or until `within` ms went by. A tab
 * that just opened has no widget yet: its scripts load with the page.
 *
 * A widget that is busy (somebody writes a note there) answers, and is left as it is.
 */
export async function pickWhenReady(
  ask: () => Promise<TabCommandAnswer>,
  options: { within?: number; every?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const { within = 10_000, every = 250, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  for (let waited = 0; waited <= within; waited += every) {
    const answer = await ask().catch((): TabCommandAnswer => ({ done: false }));
    if (answer.done) return true;
    if (answer.busy === true) return false;
    await wait(every);
  }

  return false;
}

/**
 * The first activation as « Turn on <site> » runs it, after the site is written and its tab opened.
 * It never rejects: a storage that fails (quota, no storage) leaves the site on, and the welcome page
 * must not say « could not turn the site on ». The failure goes to `log`, and no choice opens.
 */
export async function pickOnFirstActivation(
  area: FirstPickArea,
  origin: string,
  ask: () => Promise<TabCommandAnswer>,
  options: { log?: (error: unknown) => void; pick?: typeof pickWhenReady } = {},
): Promise<boolean> {
  const {
    log = (error) => console.error('[fruitback] could not read the first activation', error),
    pick = pickWhenReady,
  } = options;
  try {
    if (!(await firstActivation(area, origin))) return false;
  } catch (error) {
    log(error);

    return false;
  }

  return pick(ask);
}
