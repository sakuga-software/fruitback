import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button, Problem } from '../ui';
import { ReadProblem } from '../read-problem';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { NOTES_KEPT } from '../notes-chunks';

/** The read of the next notes: none on its way, on its way, or failed (FRU-724). */
export type More = 'idle' | 'reading' | 'failed';

/** The read of the next notes, and the notes the last one added, said to a screen reader. */
type MoreState = { state: More; arrived: number | undefined };

/**
 * Where the screen keeps the read of the next notes (FRU-724). Not a state of the screen: a change of
 * it (« Loading… », the words said to a screen reader) draws the end of the list again, not every
 * row above it. At 450 rows a draw of the whole list was 140 ms of script (measured), and one went
 * with each press of « Load more ».
 */
export type MoreStore = {
  get: () => MoreState;
  set: (changes: Partial<MoreState>) => void;
  subscribe: (listener: () => void) => () => void;
};

export function moreStore(): MoreStore {
  let value: MoreState = { state: 'idle', arrived: undefined };
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set(changes) {
      const next = { ...value, ...changes };
      if (next.state === value.state && next.arrived === value.arrived) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
  };
}

/**
 * How far before the end of the list the next notes are read: about twenty rows of 36 px, so that a
 * person who scrolls rarely reaches the end before they are drawn.
 */
const AHEAD = 720;

/**
 * The end of the list of the notes (FRU-724): the next notes are read as it comes near the bottom of
 * the window, and « Load more » reads them too, for the keyboard, a screen reader, and a browser whose
 * observer does not fire. A read that failed says so here, with « Try again », and leaves the notes
 * above it on the screen (FRU-682). A screen reader hears how many notes came.
 *
 * Nothing above the end moves: what this draws is under the last note.
 */
export function NotesMore({
  shown,
  total,
  more,
  store,
  onMore,
}: {
  /** The notes on the screen, and in the whole list. */
  shown: number;
  total: number;
  /** Whether the list has next notes to read: a cursor, and fewer notes than the screen keeps. */
  more: boolean;
  /** The read of the next notes, and the notes the last one added. */
  store: MoreStore;
  onMore: () => void;
}) {
  useLocale();
  const { state, arrived } = useSyncExternalStore(store.subscribe, store.get);
  const end = useRef<HTMLDivElement>(null);
  // Whether the end of the list is near the window: the observer says it, and a read that ends reads
  // on while it stays there (a tall window, a chunk that did not fill it).
  const near = useRef(false);
  const ask = useRef(onMore);
  ask.current = onMore;
  const ready = more && state === 'idle';
  const readyNow = useRef(ready);
  readyNow.current = ready;

  useEffect(() => {
    const element = end.current;
    if (element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        near.current = entries.some((entry) => entry.isIntersecting);
        if (near.current && readyNow.current) ask.current();
      },
      { rootMargin: `0px 0px ${AHEAD}px 0px` },
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  // A read that ended with the end still near: the next one, until the window is full. The observer
  // said it was near before the notes came; where it is now is measured, as its next word can come
  // after this effect.
  useEffect(() => {
    const element = end.current;
    if (!ready || !near.current || element === null) return;
    if (element.getBoundingClientRect().top <= window.innerHeight + AHEAD) ask.current();
  }, [ready, shown]);

  const capped = !more && shown >= NOTES_KEPT && shown < total;

  return (
    <div className="mt-[12px] flex flex-col items-start gap-[8px] text-small text-muted" data-notes-end="">
      <div ref={end} aria-hidden="true" className="h-px w-full" data-notes-ahead="" />
      {/* Always in the page, so that a screen reader hears it change. */}
      <p role="status" className="sr-only">
        {arrived === undefined ? '' : <Arrived count={arrived} shown={shown} total={total} />}
      </p>
      {state === 'failed' ? (
        <div className="flex flex-col items-start gap-[8px]" data-notes-more-failed="">
          <Problem>
            {t('The next notes did not load.')} <ReadProblem />
          </Problem>
          <Button tone="outline" onClick={onMore}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[6px]">
        <span className="tabular-nums">{t('{shown} of {total}', { shown, total })}</span>
        {more && state !== 'failed' ? (
          <Button tone="outline" onClick={onMore}>
            {t('Load more')}
          </Button>
        ) : null}
        {state === 'reading' ? <span>{t('Loading…')}</span> : null}
        {capped ? (
          <span>
            {t('The first {count} notes are shown. A filter or the search finds the others.', { count: NOTES_KEPT })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** What a screen reader hears once the next notes are drawn. */
function Arrived({ count, shown, total }: { count: number; shown: number; total: number }) {
  useLocale();
  if (count === 1) return <>{t('1 more note. {shown} of {total} shown.', { shown, total })}</>;

  return <>{t('{count} more notes. {shown} of {total} shown.', { count, shown, total })}</>;
}
