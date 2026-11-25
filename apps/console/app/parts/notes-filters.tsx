import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STAGES, STAGE_NAMES } from '../stages';
import { type Connector, type SiteChoice } from '../api';
import { type Listed } from '../listed';
import { Field, FilterTag, LinkButton, Mark, Menu, MenuTree, type TreeBranch, ViewTab } from '../ui';
import { ConnectorMark } from '../connector-marks';
import { KINDS } from './connector-parts';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import { type Filter, type NotesAnswer, type View } from './notes-model';
import { ownsKeys } from './task-selection';

/** The list and its head go from one edge of the screen to the other (FRU-685, FRU-686). */
const BLEED = '-mx-[clamp(16px,4vw,48px)]';

/**
 * The filters stay at the top of the window while the notes scroll under them, whatever the view and
 * the width (FRU-586, Mathieu). Their height is written in `--kit-pinned-top`, under which the table
 * pins its heads; it changes when the bar wraps on another line.
 */
export function Pinned({ bar, children }: { bar: ReactNode; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const filters = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = filters.current;
    if (element === null) return;
    const measure = () =>
      list.current?.style.setProperty('--kit-pinned-top', `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={list}>
      <div ref={filters} className="sticky top-0 z-[3] bg-page" data-pinned-filters="">
        {bar}
      </div>
      {children}
    </div>
  );
}

/**
 * The head of the screen (FRU-686): « Notes », a tab per place the notes went (FRU-548), then
 * « New task » at the end. 48 px, from one edge of the screen to the other.
 */
export function NotesHead({ tabs, action }: { tabs: ReactNode; action: ReactNode }) {
  useLocale();

  return (
    <header
      className={`${BLEED} -mt-[40px] mb-0 flex min-h-[48px] flex-wrap items-center gap-x-[12px] gap-y-[6px] border-b border-line py-[10px] pr-[16px] pl-[20px] min-[640px]:py-0`}
    >
      <h1 className="text-step font-semibold text-ink">{t('Notes')}</h1>
      {tabs}
      <div className="ml-auto flex items-center gap-[8px]">{action}</div>
    </header>
  );
}

/**
 * The tabs of where the notes went: every note, and each place that has notes, when there are two
 * places or more (FRU-548, FRU-686). Each has the mark of its place and its count. A place is a
 * connector of the workspace, as the filter `place` of the worker reads it: two connectors of one
 * kind are two tabs. The mockup draws a tab « Webhook and REST » of a kind; a tab of a kind would ask
 * the worker for several places at once, which it does not read.
 */
export function Places({
  counts,
  connectors,
  chosen,
  onChoose,
}: {
  counts: NotesAnswer['counts'];
  connectors: readonly Connector[];
  chosen: string;
  onChoose: (place: string) => void;
}) {
  useLocale();
  // A place is named by the name its workspace gave it (FRU-404), else by its kind, and by the label
  // of the worker when two connectors with no name are of the same kind.
  const nameOf = (id: string): string => {
    if (id === 'fruitback') return t('In Fruitback');
    const connector = connectors.find((each) => each.id === id);
    if (connector === undefined) return t('A connector that was removed');
    if (connector.name !== undefined) return connector.name;
    const twins = connectors.filter((each) => each.kind === connector.kind).length > 1;

    return twins ? connector.label : t(KINDS[connector.kind].name);
  };
  const markOf = (id: string): ReactNode => {
    if (id === 'fruitback') return <Mark size={14} />;
    const connector = connectors.find((each) => each.id === id);

    return connector === undefined ? null : <ConnectorMark kind={connector.kind} />;
  };
  // In the order of the sources of the workspace, then Fruitback, then a source that is gone: the
  // order of the answer is no order a person can learn.
  const rank = (id: string) => {
    const at = connectors.findIndex((each) => each.id === id);
    if (at >= 0) return at;

    return id === 'fruitback' ? connectors.length : connectors.length + 1;
  };
  const places = Object.entries(counts.byPlace ?? {})
    .filter(([, count]) => count > 0)
    .sort(([one], [other]) => rank(one) - rank(other));
  // FRU-548: with one place, « All » and that place are the same notes, and the tabs choose nothing.
  // A place chosen by the address keeps its tabs, so that « All » takes it back.
  if (places.length <= 1 && chosen === '') return null;

  return (
    <div role="group" aria-label={t('Where the notes went')} className="flex min-w-0 flex-wrap items-center gap-[2px]">
      <ViewTab pressed={chosen === ''} count={counts.all} onChange={() => onChoose('')}>
        {t('All')}
      </ViewTab>
      {places.map(([id, count]) => (
        <ViewTab
          key={id}
          pressed={chosen === id}
          count={count}
          mark={markOf(id)}
          onChange={() => onChoose(chosen === id ? '' : id)}
        >
          {nameOf(id)}
        </ViewTab>
      ))}
    </div>
  );
}

const PRIORITY = {
  urgent: msg('Urgent'),
  high: msg('High'),
  medium: msg('Medium'),
  low: msg('Low'),
  none: msg('No priority'),
} as const;
const DUE = { overdue: msg('Overdue'), week: msg('Due this week'), none: msg('No due day') } as const;

type People = readonly { id: string; name: string }[];
type Tasks = { people: People; labels: readonly { id: string; name: string }[] };

/** A filter that is on, as its chip says it: the fields it clears when its cross is pressed. */
type On = { key: string; field: string; value: string; off: Partial<Record<Filter, string>> };

/**
 * The filters that are on, in the order of the menu, each as its chip says it (FRU-686). They are
 * read from the address, which the list is read from: a chip says exactly what the list shows.
 */
export function filtersOn(
  filters: Readonly<Record<Filter, string>>,
  sites: Listed<SiteChoice>,
  tasks: Tasks | undefined,
): On[] {
  const on: On[] = [];
  const status = t('Status');
  if (filters.archived === '1')
    on.push({ key: 'status', field: status, value: t('Archived'), off: { archived: '', stage: '', unresolved: '' } });
  else if (filters.unresolved === '1')
    on.push({ key: 'status', field: status, value: t('Unresolved'), off: { unresolved: '', stage: '' } });
  else if ((STAGES as readonly string[]).includes(filters.stage))
    on.push({
      key: 'status',
      field: status,
      value: t(STAGE_NAMES[filters.stage as (typeof STAGES)[number]]),
      off: { stage: '' },
    });
  if (filters.site !== '') {
    const site = typeof sites === 'string' ? undefined : sites.find((each) => each.id === filters.site);
    on.push({
      key: 'site',
      field: t('Site'),
      value: site === undefined ? filters.site : siteLabel(site.origin),
      off: { site: '' },
    });
  }
  if (filters.mine === '1') on.push({ key: 'mine', field: t('Left by'), value: t('Me'), off: { mine: '' } });
  if (filters.assignee !== '') {
    let value = tasks?.people.find((person) => person.id === filters.assignee)?.name ?? t('a member');
    if (filters.assignee === 'me') value = t('Me');
    if (filters.assignee === 'none') value = t('Nobody');
    on.push({ key: 'assignee', field: t('Assignee'), value, off: { assignee: '' } });
  }
  if (filters.priority in PRIORITY)
    on.push({
      key: 'priority',
      field: t('Priority'),
      value: t(PRIORITY[filters.priority as keyof typeof PRIORITY]),
      off: { priority: '' },
    });
  if (filters.label !== '')
    on.push({
      key: 'label',
      field: t('Label'),
      value: tasks?.labels.find((label) => label.id === filters.label)?.name ?? filters.label,
      off: { label: '' },
    });
  if (filters.due in DUE)
    on.push({ key: 'due', field: t('Due day'), value: t(DUE[filters.due as keyof typeof DUE]), off: { due: '' } });

  return on;
}

/** The value of the status filter in its menu: « Archived », « Unresolved », a stage, or « Any status ». */
function statusChoiceOf(filters: { stage: string; archived: string; unresolved: string }): string {
  if (filters.archived === '1') return 'archived';
  if (filters.unresolved === '1') return 'unresolved';

  return filters.stage === '' ? 'any' : filters.stage;
}

/** The submenus of « Filter », one per field, each a choice that shows the value of the address. */
function branchesOf(
  filters: Readonly<Record<Filter, string>>,
  sites: Listed<SiteChoice>,
  tasks: Tasks | undefined,
  onFilter: (changes: Partial<Record<Filter, string>>) => void,
): TreeBranch[] {
  const branches: TreeBranch[] = [
    {
      id: 'status',
      label: t('Status'),
      choice: 'single',
      checked: [statusChoiceOf(filters)],
      // FRU-665: « Archived » is the last choice: the archived tasks, of every status.
      // FRU-667: « Unresolved », after « Any status »: every status but Done and Closed.
      items: [
        { id: 'any', label: t('Any status') },
        { id: 'unresolved', label: t('Unresolved') },
        ...STAGES.map((stage) => ({ id: stage, label: t(STAGE_NAMES[stage]) })),
        { id: 'archived', label: t('Archived') },
      ],
      onAction: (stage) =>
        onFilter(
          stage === 'archived' || stage === 'unresolved'
            ? { stage: '', archived: stage === 'archived' ? '1' : '', unresolved: stage === 'unresolved' ? '1' : '' }
            : { stage: stage === 'any' ? '' : stage, archived: '', unresolved: '' },
        ),
    },
    {
      id: 'site',
      label: t('Site'),
      choice: 'single',
      checked: [filters.site === '' ? 'every' : filters.site],
      items: [
        { id: 'every', label: t('Every site') },
        ...(typeof sites === 'string' ? [] : sites.map((site) => ({ id: site.id, label: siteLabel(site.origin) }))),
      ],
      onAction: (site) => onFilter({ site: site === 'every' ? '' : site }),
    },
    {
      id: 'mine',
      label: t('Left by'),
      choice: 'single',
      checked: [filters.mine === '1' ? 'me' : 'anyone'],
      items: [
        { id: 'anyone', label: t('Anyone') },
        { id: 'me', label: t('Me') },
      ],
      onAction: (who) => onFilter({ mine: who === 'me' ? '1' : '' }),
    },
  ];
  if (tasks === undefined) return branches;

  // FRU-655: the filters on the fields of the tasks Fruitback keeps.
  return [
    ...branches,
    {
      id: 'assignee',
      label: t('Assignee'),
      choice: 'single',
      checked: [filters.assignee === '' ? 'anyone' : filters.assignee],
      items: [
        { id: 'anyone', label: t('Anyone assigned') },
        { id: 'me', label: t('Assigned to me') },
        { id: 'none', label: t('Assigned to nobody') },
        ...tasks.people.map((person) => ({ id: person.id, label: person.name })),
      ],
      onAction: (assignee) => onFilter({ assignee: assignee === 'anyone' ? '' : assignee }),
    },
    {
      id: 'priority',
      label: t('Priority'),
      choice: 'single',
      checked: [filters.priority === '' ? 'any' : filters.priority],
      items: [
        { id: 'any', label: t('Any priority') },
        ...Object.entries(PRIORITY).map(([id, words]) => ({ id, label: t(words) })),
      ],
      onAction: (priority) => onFilter({ priority: priority === 'any' ? '' : priority }),
    },
    {
      id: 'label',
      label: t('Label'),
      choice: 'single',
      checked: [filters.label === '' ? 'any' : filters.label],
      items: [
        { id: 'any', label: t('Any label') },
        ...tasks.labels.map((label) => ({ id: label.id, label: label.name })),
      ],
      onAction: (label) => onFilter({ label: label === 'any' ? '' : label }),
    },
    {
      id: 'due',
      label: t('Due day'),
      choice: 'single',
      checked: [filters.due === '' ? 'any' : filters.due],
      items: [
        { id: 'any', label: t('Any due day') },
        ...Object.entries(DUE).map(([id, words]) => ({ id, label: t(words) })),
      ],
      onAction: (due) => onFilter({ due: due === 'any' ? '' : due }),
    },
  ];
}

/** « / » gives the focus to the search (FRU-686), unless a field, a menu or a dialog has the key. */
function useSlashKey(field: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (ownsKeys(event.target)) return;
      event.preventDefault();
      field.current?.focus();
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [field]);
}

/**
 * The bar of the list (FRU-686), as Linear draws it: « Filter » and a menu by field, a chip per filter
 * that is on with its cross, « Clear »; at the end the count of the notes, the search (« / » gives it
 * the focus) and « Display », which shows the list or the board. 44 px, from one edge of the screen
 * to the other; under 640 px it goes on a second line.
 */
export function NotesToolbar({
  total,
  sites,
  filters,
  onFilter,
  typed,
  onType,
  tasks,
  view,
  onView,
}: {
  /** The notes of the whole list under the filters. */
  total: number;
  sites: Listed<SiteChoice>;
  filters: Readonly<Record<Filter, string>>;
  /** Sets filters, and goes back to the first page. */
  onFilter: (changes: Partial<Record<Filter, string>>) => void;
  /** The search as it is typed: the address takes it 300 ms after the last key (`useTypedSearch`). */
  typed: string;
  onType: (typed: string) => void;
  /**
   * FRU-655: the people and the labels of the filters on the tasks. Absent: their submenus are not
   * offered, as on a list with no task Fruitback keeps.
   */
  tasks?: Tasks | undefined;
  view: View;
  onView: (view: View) => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  useSlashKey(search);
  const on = filtersOn(filters, sites, tasks);
  const clear = () => {
    const off: Partial<Record<Filter, string>> = {};
    for (const each of on) Object.assign(off, each.off);
    onType('');
    onFilter({ ...off, q: '' });
  };

  return (
    <div
      className={`${BLEED} flex min-h-[44px] flex-wrap items-center gap-x-[8px] gap-y-[6px] border-b border-line py-[8px] pr-[16px] pl-[20px] min-[640px]:flex-nowrap min-[640px]:py-0`}
      data-notes-toolbar=""
    >
      <MenuTree
        trigger="plain"
        triggerClassName={TOOL_BUTTON}
        branches={branchesOf(filters, sites, tasks, onFilter)}
        items={[]}
        onAction={() => undefined}
        open={open}
        onOpenChange={setOpen}
      >
        <ToolIcon path="M4 6h16M7 12h10M10 18h4" />
        {t('Filter')}
      </MenuTree>
      {on.length === 0 ? null : (
        <div role="group" aria-label={t('Filters on')} className="flex min-w-0 flex-wrap items-center gap-[6px]">
          {on.map((each) => (
            <FilterTag
              key={each.key}
              field={each.field}
              value={each.value}
              removeLabel={t('Remove the filter {field}: {value}', { field: each.field, value: each.value })}
              onRemove={() => onFilter(each.off)}
            />
          ))}
          <LinkButton onClick={clear} space="flush">
            {t('Clear')}
          </LinkButton>
        </div>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-[8px]">
        <span className="hidden flex-none text-hint text-muted tabular-nums min-[640px]:inline" aria-live="polite">
          {total === 1 ? t('1 note') : t('{count} notes', { count: total })}
        </span>
        <div className="relative w-[220px] min-w-0 flex-shrink">
          <Field
            label={t('Search notes')}
            labelHidden
            compact
            type="search"
            inputRef={search}
            // 220 px, as the mockup: « Search notes ». The index searches the 64 characters, the page
            // and, for whoever sees the tracker, the reference (`searched` of FRU-244).
            placeholder={t('Search notes')}
            value={typed}
            onChange={(event) => onType(event.target.value)}
          />
          {typed === '' ? (
            <kbd
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-[6px] inline-flex h-[18px] min-w-[18px] -translate-y-1/2 items-center justify-center rounded-inner border border-line bg-page px-[4px] font-sans text-tiny leading-none font-medium text-muted"
            >
              /
            </kbd>
          ) : null}
        </div>
        <Menu
          items={[
            { id: 'table', label: t('Table') },
            { id: 'board', label: t('Board') },
          ]}
          chosen={view}
          choiceLabel={t('Show the notes as')}
          onAction={(chosen) => onView(chosen === 'board' ? 'board' : 'table')}
          triggerClassName={TOOL_BUTTON}
        >
          <ToolIcon path="M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4" />
          {t('Display')}
        </Menu>
      </div>
    </div>
  );
}

/** « Filter » and « Display »: a button of the bar, its picture and its words, at the height of a control. */
const TOOL_BUTTON =
  'inline-flex flex-none items-center gap-[6px] h-control-md px-[10px] border border-line rounded-control bg-page text-(length:--text-body) font-medium text-ink whitespace-nowrap [box-shadow:0_1px_1px_rgba(15,23,42,0.04)] [&:hover]:bg-hover data-[hovered=true]:bg-hover';

/** The picture of a button of the bar: 14 px, a stroke of 2 in the colour of its words. */
function ToolIcon({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[14px] flex-none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
