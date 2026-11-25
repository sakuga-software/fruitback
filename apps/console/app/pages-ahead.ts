import { useEffect, useLayoutEffect, useRef } from 'react';
import { type Fetched } from './listed';

/** A page of a list read by a cursor: its list and its cursor, as one key. */
const placeOf = (list: string, cursor: string) => JSON.stringify([list, cursor]);

/**
 * The presses of « Next page » and « Previous page » of a list read by a cursor, each from the page
 * asked last (FRU-709).
 *
 * « Next page » goes on from the cursor of an answer. While the page asked last is on its way, the
 * answer on the screen is the one of the page before: a press from it asks the same cursor again, and
 * the press is lost. So a press that comes before the answer of the page asked last waits for it, and
 * goes on from it once it is shown. « Previous page » takes back a press that waits. Nothing on the
 * screen changes: no button is turned off.
 *
 * WARNING: the page asked last is kept here, not read from the address. React Router writes a new
 * address in a transition, and a press can come before the screen draws it.
 */
export function usePagesAhead<Answer extends { next?: string }>({
  list,
  cursor,
  shown,
  forward,
  stay,
}: {
  /** The list (its filters, its view) and the cursor of the address. */
  list: string;
  cursor: string;
  shown: Fetched<Answer>;
  /** Goes to the page after this answer, which is the answer of the address. */
  forward: (answer: Answer) => void;
  /** Goes back to the address, before the page that « Next page » asked from it is drawn. */
  stay: () => void;
}) {
  const place = placeOf(list, cursor);
  // The page asked last; the page « Next page » left for it, until its address is drawn; and the
  // presses of « Next page » past it, which wait for its answer.
  const asked = useRef(place);
  const left = useRef<string | undefined>(undefined);
  const ahead = useRef(0);
  // The page of each answer shown: a press reads the answer of its render, not the latest one.
  const drawn = useRef(new WeakMap<Answer, string>());

  function step(answer: Answer) {
    if (answer.next === undefined) {
      ahead.current = 0;
      return;
    }
    left.current = asked.current;
    asked.current = placeOf(list, answer.next);
    forward(answer);
  }

  function next(answer: Answer) {
    if (ahead.current === 0 && drawn.current.get(answer) === asked.current) step(answer);
    else ahead.current += 1;
  }

  // Before any press can read it: a new address is the page asked last.
  useLayoutEffect(() => {
    left.current = undefined;
    if (place === asked.current) return;
    // An address that no press of the pages asked: the buttons of the browser, a link, a filter.
    asked.current = place;
    ahead.current = 0;
  }, [place]);

  useEffect(() => {
    if (ahead.current === 0 || asked.current !== place) return;
    if (shown === 'failed') {
      ahead.current = 0;
      return;
    }
    if (typeof shown !== 'object' || drawn.current.get(shown) !== place) return;
    ahead.current -= 1;
    step(shown);
    // Only an answer, or a new address, lets a press go on. `step` is the one of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, place]);

  return {
    /** The read shows this answer, of this list and this cursor. */
    drawn(answer: Answer, of: string, at: string) {
      drawn.current.set(answer, placeOf(of, at));
    },
    /** A press of « Next page », with the answer its screen shows. */
    next,
    /** A press that goes to the page after the address, by its number: from there, not from the page asked. */
    after(answer: Answer) {
      asked.current = place;
      left.current = undefined;
      ahead.current = 0;
      next(answer);
    },
    /**
     * A press of « Previous page »: whether it was the page before the one asked last, and is done. A
     * press of « Next page » that waits is taken back; one not drawn yet goes back to the address.
     * Otherwise the screen goes to the page before its address.
     */
    back(): boolean {
      if (ahead.current > 0) {
        ahead.current -= 1;
        return true;
      }
      if (left.current !== place) return false;
      asked.current = place;
      left.current = undefined;
      stay();

      return true;
    },
    /** A press that goes to a page by its cursor: it is the page asked last, and no press waits. */
    to(at: string) {
      asked.current = placeOf(list, at);
      left.current = undefined;
      ahead.current = 0;
    },
  };
}
