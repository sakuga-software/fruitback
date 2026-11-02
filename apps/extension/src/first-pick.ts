import type { TabCommandAnswer } from './tab-command.ts';

/**
 * The first activation of a site from the welcome page opens the choice of an element (FRU-485):
 * the person turned the site on to leave a note, so « Leave a note » is pressed for them, once.
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

function picked(stored: unknown): string[] {
  return Array.isArray(stored) ? stored.filter((each): each is string => typeof each === 'string') : [];
}

/**
 * Whether the choice of an element opened on `origin` already. A second activation, after
 * « Turn off », or in another tab, finds it there: the choice opens once per origin.
 */
export async function pickedAlready(area: FirstPickArea, origin: string): Promise<boolean> {
  return picked((await area.get(FIRST_PICK_KEY))[FIRST_PICK_KEY]).includes(origin);
}

/** Keeps `origin` as one where the choice opened, or is opening. */
export async function markPicked(area: FirstPickArea, origin: string): Promise<void> {
  const done = picked((await area.get(FIRST_PICK_KEY))[FIRST_PICK_KEY]);
  if (!done.includes(origin)) await area.set({ [FIRST_PICK_KEY]: [...done, origin] });
}

/** Gives `origin` back: the choice did not open there, so the next activation tries again. */
export async function unmarkPicked(area: FirstPickArea, origin: string): Promise<void> {
  const done = picked((await area.get(FIRST_PICK_KEY))[FIRST_PICK_KEY]);
  if (done.includes(origin)) await area.set({ [FIRST_PICK_KEY]: done.filter((each) => each !== origin) });
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
  // Marked before the pick, so that a second activation during the pick (another tab) does not
  // open the choice a second time.
  try {
    if (await pickedAlready(area, origin)) return false;
    await markPicked(area, origin);
  } catch (error) {
    log(error);

    return false;
  }
  // Given back when the choice did not open: a widget that did not load in time, or that was busy,
  // gets the choice at the next activation.
  const opened = await pick(ask);
  if (!opened) await unmarkPicked(area, origin).catch(log);

  return opened;
}
