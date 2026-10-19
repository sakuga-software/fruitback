import { useSyncExternalStore } from 'react';

/** The width from which a panel has its column beside its list, as on the mockup. */
const WIDE = '(min-width: 80rem)';

/** Whether the screen is wide enough for the column of a panel. The console is built wide. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', listener);

      return () => query.removeEventListener('change', listener);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}
