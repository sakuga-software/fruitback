import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { t } from '../i18n';
import { Choice, Field, LinkButton, type Option, SidePanel } from '../ui';
import { useTypedSearch } from '../typed-search';
import { useLocale } from '../use-locale';

/**
 * What « Workspaces » and « Users » of the administration share (FRU-263): the search and the filter
 * in the address, the read of a list, and the panel of the row that is chosen.
 *
 * WARNING: each read of a list writes a trace in each workspace of the answer that the administrator
 * is not a member of (FRU-261). So the search reads 300 ms after the last key, and never on each key.
 */

/** The id of the open panel, which its row names in `aria-controls`. */
export const PANEL = 'admin-panel';
/** The id of the title of the open panel. */
export const PANEL_TITLE = 'admin-panel-title';

/** The id of the link of a row, which takes focus back when its panel closes. */
export function rowId(id: string): string {
  return `admin-row-${id}`;
}

type Address = { q: string; show: string; open: string };

/**
 * The search, the filter and the chosen row, in the address: a reload keeps the view, and a link
 * of another screen opens it. `typed` is the field, written in the address 300 ms after its last key.
 */
export function useListAddress() {
  const [params, setParams] = useSearchParams();
  // The address as the last change wrote it: the search writes 300 ms after its key, and a filter
  // chosen meanwhile must not be undone by it.
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  }, [params]);
  const address: Address = {
    q: params.get('q') ?? '',
    show: params.get('show') ?? 'all',
    open: params.get('open') ?? '',
  };

  const change = useCallback(
    (changes: Partial<Address>, replace = false) => {
      const next = new URLSearchParams(latest.current);
      for (const [name, value] of Object.entries(changes)) {
        if (value === '' || (name === 'show' && value === 'all')) next.delete(name);
        else next.set(name, value);
      }
      latest.current = next;
      setParams(next, { replace });
    },
    [setParams],
  );

  const [typed, setTyped] = useTypedSearch(address.q, (q) => change({ q }, true));

  /** The address that opens the panel of a row, with the search and the filter of this one. */
  const openTo = (id: string): string => {
    const next = new URLSearchParams(params);
    next.set('open', id);

    return `?${next.toString()}`;
  };

  return { ...address, typed, setTyped, change, openTo };
}

/**
 * The answer of a read, read again when `ask` changes. A read again keeps the rows on the screen
 * until its answer replaces them: only the first read says « Loading… ». An answer to a question
 * that is no longer asked is dropped.
 *
 * `patch` changes the answer on the screen with what a write answered. A read again would write a
 * trace in each workspace of the list (FRU-261) for a change of one row.
 */
export function useRead<T>(ask: () => Promise<T | 'failed'>): {
  shown: T | 'loading' | 'failed';
  again: () => void;
  patch: (change: (shown: T) => T) => void;
} {
  const [shown, setShown] = useState<T | 'loading' | 'failed'>('loading');
  const asked = useRef(0);
  const again = useCallback(() => {
    const mine = (asked.current += 1);
    void ask().then((answer) => {
      if (mine === asked.current) setShown(answer);
    });
  }, [ask]);
  // React runs an effect twice when it mounts in development. The question is asked once: each
  // read leaves a trace with the owners of the workspaces.
  const askedFor = useRef<unknown>(undefined);
  useEffect(() => {
    if (askedFor.current === again) return;
    askedFor.current = again;
    again();
  }, [again]);
  const patch = useCallback((change: (shown: T) => T) => {
    setShown((current) => (current === 'loading' || current === 'failed' ? current : change(current)));
  }, []);

  return { shown, again, patch };
}

/** The search and the filter above a list, as the mockup draws them: the field, then the list. */
export function ListBar({
  label,
  placeholder,
  typed,
  onType,
  show,
  onShow,
  options,
}: {
  label: string;
  placeholder: string;
  typed: string;
  onType: (typed: string) => void;
  show: string;
  onShow: (show: string) => void;
  options: readonly Option[];
}) {
  useLocale();

  return (
    <div className="mb-[16px] flex flex-wrap gap-[10px]">
      <div className="min-w-0 flex-[999_1_260px]">
        <Field
          label={label}
          labelHidden
          compact
          type="search"
          placeholder={placeholder}
          value={typed}
          onChange={(event) => onType(event.target.value)}
        />
      </div>
      <div className="min-w-0 flex-[1_1_200px]">
        <Choice label={t('Show')} labelHidden compact value={show} onChange={onShow} options={options} />
      </div>
    </div>
  );
}

/**
 * The name of a row, which opens its panel: a link to the address with `open`, so a keyboard opens
 * it with Enter. A press on the row that is open gives focus to its panel again.
 */
export function RowLink({
  id,
  to,
  chosen,
  onOpen,
  children,
}: {
  id: string;
  to: string;
  chosen: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      id={rowId(id)}
      to={to}
      aria-current={chosen ? 'true' : 'false'}
      {...(chosen ? { 'aria-controls': PANEL } : {})}
      onClick={(event: MouseEvent) => {
        if (chosen) {
          event.preventDefault();
          document.getElementById(PANEL)?.focus();
          return;
        }
        onOpen();
      }}
      className="block font-semibold text-ink no-underline [overflow-wrap:anywhere] hover:underline"
    >
      {children}
    </Link>
  );
}

/**
 * The panel of the chosen row (the rules of FRU-161 and FRU-197). From 1280 px it is the column
 * beside the table; under 1280 px it is under its row, and the page scrolls as little as shows it.
 * A panel that a person opened takes focus, and Escape closes it and gives focus back to the row.
 * A panel that appears by itself takes none: the one of a reload, and the one that a change of
 * width mounts again.
 */
export function AdminPanel({
  wide,
  takesFocus,
  onClose,
  title,
  detail,
  foot,
  children,
}: {
  wide: boolean;
  /** Set by the press that opens the panel, and spent by the panel that appears. */
  takesFocus: { current: boolean };
  onClose: () => void;
  title: string;
  detail?: string;
  /** Under a rule at the bottom of the panel. */
  foot?: ReactNode;
  children: ReactNode;
}) {
  const held = useRef<HTMLElement>(null);

  useEffect(() => {
    if (takesFocus.current) {
      takesFocus.current = false;
      // The scroll is the one below: a focus that scrolls would put the top of a tall panel off the screen.
      held.current?.focus({ preventScroll: true });
    }
    if (wide) return;
    held.current?.scrollIntoView({ block: 'nearest' });
  }, [wide, takesFocus]);

  return (
    <SidePanel
      id={PANEL_TITLE}
      panelId={PANEL}
      panelRef={held}
      title={title}
      {...(detail === undefined ? {} : { detail })}
      {...(foot === undefined ? {} : { foot })}
      spacing="tight"
      className={`scroll-mt-4 ${wide ? 'flex-[1_1_340px]' : ''}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        onClose();
      }}
    >
      {children}
    </SidePanel>
  );
}

/**
 * The row under a row of a table, which holds its panel under 1280 px. It takes no width of its own:
 * on a phone the table scrolls in its frame, and the panel stays at the left of what is seen.
 */
export function UnderRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={columns} className="!p-[12px]">
        <div className="sticky left-[12px] w-0 min-w-[min(100%,calc(100vw-56px))]">{children}</div>
      </td>
    </tr>
  );
}

/** A section of a panel: its title, and what is under it. */
export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-[6px] text-small font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** The rows of a section of a panel: a name, and a word about it at the end of the line. */
export function PanelRows({ rows }: { rows: readonly { key: string; name: ReactNode; value: ReactNode }[] }) {
  return (
    <ul className="text-small">
      {rows.map((row) => (
        <li key={row.key} className="flex justify-between gap-[12px] border-b border-line py-[8px]">
          <span className="min-w-0 [overflow-wrap:anywhere]">{row.name}</span>
          <span className="text-right text-muted">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** A list with no row: empty, or empty for this search and this filter, with a way back to all of it. */
export function NoRows({
  filtered,
  empty,
  noMatch,
  onClear,
}: {
  filtered: boolean;
  empty: string;
  noMatch: string;
  onClear: () => void;
}) {
  useLocale();
  if (!filtered) return <p className="text-small text-muted">{empty}</p>;

  return (
    <div className="flex flex-wrap items-center gap-x-[12px] text-small text-muted">
      <p>{noMatch}</p>
      <LinkButton onClick={onClear}>{t('Clear the filters')}</LinkButton>
    </div>
  );
}

/** « The first 100 of 240 », under a list that the worker cut. */
export function Cut({ shown, total, sentence }: { shown: number; total: number; sentence: string }) {
  if (total <= shown) return null;

  return <p className="mt-[8px] text-hint text-muted">{sentence}</p>;
}
