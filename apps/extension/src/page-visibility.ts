import { coversOrigin } from './site-patterns.ts';

/**
 * « Hide Fruitback on this page » (FRU-444, FRU-590): the origins where the reviewer hid the widget.
 *
 * A list of origins under one key of `chrome.storage.local`. It is no credential and no rule: the
 * rule of the site stays on, and keeps its access. A hidden origin gets no script (`excludeMatches`
 * of its registration) and no mount (the bridge of a tab already open posts `unmount`). Absent, or
 * empty: the widget shows everywhere a rule is on.
 */
export const HIDDEN_ORIGINS_KEY = 'hiddenOrigins';

export type VisibilityArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

/** The longest list kept. A reviewer hides a few sites; a longer value is not one this wrote. */
const MAX_HIDDEN = 500;

/** The stored value, as a list of origins. Anything else is no origin, and is left out. */
export function parseHidden(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter((each): each is string => typeof each === 'string' && isOrigin(each)).slice(0, MAX_HIDDEN);
}

/** Never rejects: a read that fails shows the widget, as before this switch existed. */
export async function readHidden(area: VisibilityArea): Promise<string[]> {
  try {
    return parseHidden((await area.get(HIDDEN_ORIGINS_KEY))[HIDDEN_ORIGINS_KEY]);
  } catch {
    return [];
  }
}

export async function isHidden(area: VisibilityArea, origin: string): Promise<boolean> {
  return (await readHidden(area)).includes(origin);
}

/** Hides or shows the widget on one origin. The last origin shown removes the key. */
export async function setHidden(area: VisibilityArea, origin: string, hidden: boolean): Promise<void> {
  const others = (await readHidden(area)).filter((each) => each !== origin);
  const next = hidden ? [...others, origin] : others;
  if (next.length === 0) {
    await area.remove(HIDDEN_ORIGINS_KEY);

    return;
  }
  await area.set({ [HIDDEN_ORIGINS_KEY]: next });
}

/**
 * « Hide Fruitback on this page » of the settings of the widget (FRU-590), carried by the bridge of
 * `origin`. Written only while the window holds the activation of a gesture of the person (`gesture`,
 * from `hasGesture`). Returns whether it hid.
 *
 * The page can send the request too, as every message of the bridge. A script of a site the reviewer
 * turned on can then hide the widget on its own origin, in this browser, in the seconds after a click
 * or a key of the person on that page. It reads nothing and sends nothing; the eye of the popup shows
 * the widget again.
 */
export async function hideAsked(area: VisibilityArea, origin: string, gesture: boolean): Promise<boolean> {
  if (!gesture || !isOrigin(origin)) return false;
  await setHidden(area, origin, true);

  return true;
}

/** The hidden origins a rule covers, which its scripts leave out. Sorted, so two lists compare. */
export function hiddenUnder(pattern: string, hidden: readonly string[]): string[] {
  return hidden.filter((origin) => coversOrigin(pattern, origin)).sort();
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);

    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}
