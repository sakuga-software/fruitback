/**
 * The language of the reviewer's account, kept for the next popup and for the widget (FRU-131).
 *
 * It is a locale tag under its own key of `chrome.storage.local`. It is no credential: the bridge
 * reads it and sends it to the page with `mount`, so the widget the extension mounts speaks the
 * language of its reviewer.
 */
export const LANGUAGE_KEY = 'language';

export type LanguageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

/** A locale tag is short. A longer value is not one, and it would travel to the page. */
const MAX_TAG_LENGTH = 35;

export function readTag(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_TAG_LENGTH ? value : undefined;
}

export async function storedLanguage(area: LanguageArea): Promise<string | undefined> {
  try {
    return readTag((await area.get(LANGUAGE_KEY))[LANGUAGE_KEY]);
  } catch {
    return undefined;
  }
}
