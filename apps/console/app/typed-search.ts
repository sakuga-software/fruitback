import { useEffect, useRef, useState } from 'react';

/** How long the search waits after a key before it reads: a word is typed, not each letter read. */
export const TYPING_MS = 300;

/**
 * A search field whose value lives in the address (FRU-279). `q` is the search of the address, and
 * `write` puts a search in it, 300 ms after the last key.
 *
 * The field takes the address only when the address holds a search that the field did not write: a
 * navigation, back or forward, or a link. WARNING: a key can come after `write` and before the screen
 * draws the new address. If the field took every new address, that key would be lost.
 */
export function useTypedSearch(q: string, write: (q: string) => void): [string, (typed: string) => void] {
  const [typed, setTyped] = useState(q);
  const written = useRef(q);

  useEffect(() => {
    if (q === written.current) return;
    written.current = q;
    setTyped(q);
  }, [q]);

  useEffect(() => {
    const next = typed.trim() === '' ? '' : typed;
    if (next === written.current) return;
    const waiting = setTimeout(() => {
      written.current = next;
      write(next);
    }, TYPING_MS);

    return () => clearTimeout(waiting);
    // Only a key starts the wait. `write` reads the latest address itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  return [typed, setTyped];
}
