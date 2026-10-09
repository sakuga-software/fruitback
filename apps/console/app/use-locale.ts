import { useSyncExternalStore } from 'react';
import { type LocaleTag, locale, onLocale } from './i18n.ts';

/**
 * Makes a component render again when the language changes (FRU-120).
 *
 * `t` reads the language when a component renders, and React renders a component again only when
 * something it holds changes. So every component that calls `t` calls this first. The screens are
 * never mounted again for a change of language: a mount again loses what somebody was typing, and
 * runs every effect a second time. `messages.test.ts` fails on a component that calls `t` without it.
 */
export function useLocale(): LocaleTag {
  // The console is built once, in English. The browser then renders in the language of the person.
  return useSyncExternalStore(onLocale, locale, () => 'en');
}
