import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { STAGES, STAGE_NAMES } from '../stages';
import { type Connector, type SiteChoice } from '../api';
import { type Listed } from '../listed';
import { Checkbox, Choice, Field, FilterChip } from '../ui';
import { KINDS } from './connector-parts';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import { type Filter, type NotesAnswer, type View } from './notes-model';

/**
 * The filters stay at the top of the window while the notes scroll under them, whatever the view and
 * the width (FRU-586, Mathieu). Their height is written in `--kit-pinned-top`, under which the table
 * pins its heads; it changes when the filters wrap on another line.
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
      {/* The padding above is taken back by the margin: at rest the filters are where they were. */}
      <div ref={filters} className="sticky top-0 z-[3] -mt-[12px] bg-page pt-[12px] pb-[16px]" data-pinned-filters="">
        {bar}
      </div>
      {children}
    </div>
  );
}

/**
 * The chips of where the notes went: every note, and each place that has notes, when there are two
 * places or more (FRU-548). The mockup draws a
 * chip « Not delivered » too: the route of FRU-244 counts those notes and does not filter them, so a
 * chip would choose nothing. Each of them says « Not delivered yet » on its row.
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
  // FRU-548: with one place, « All » and that place are the same notes, and the chips choose nothing.
  // A place chosen by the address keeps its chips, so that « All » takes it back.
  if (places.length <= 1 && chosen === '') return null;

  return (
    <div role="group" aria-label={t('Where the notes went')} className="mb-[14px] flex flex-wrap gap-[8px]">
      <FilterChip pressed={chosen === ''} count={counts.all} onChange={() => onChoose('')}>
        {t('All')}
      </FilterChip>
      {places.map(([id, count]) => (
        <FilterChip key={id} pressed={chosen === id} count={count} onChange={() => onChoose(chosen === id ? '' : id)}>
          {nameOf(id)}
        </FilterChip>
      ))}
    </div>
  );
}

/** The choice between the table and the board (FRU-436): two buttons, the one on screen pressed. */
export function ViewChoice({ view, onChoose }: { view: View; onChoose: (view: View) => void }) {
  useLocale();

  return (
    <div role="group" aria-label={t('Show the notes as')} className="flex flex-none gap-[8px]">
      <FilterChip pressed={view === 'table'} onChange={() => onChoose('table')}>
        {t('Table')}
      </FilterChip>
      <FilterChip pressed={view === 'board'} onChange={() => onChoose('board')}>
        {t('Board')}
      </FilterChip>
    </div>
  );
}

/** The filters of the notes (FRU-245, FRU-548): where they went, a search, the site, the status, mine. */
export function NotesFilters({
  counts,
  connectors,
  sites,
  seesTracker,
  filters,
  onFilter,
  typed,
  onType,
}: {
  counts: NotesAnswer['counts'];
  connectors: readonly Connector[];
  sites: Listed<SiteChoice>;
  seesTracker: boolean;
  filters: Readonly<Record<Filter, string>>;
  /** Sets filters, and goes back to the first page. */
  onFilter: (changes: Partial<Record<Filter, string>>) => void;
  /** The search as it is typed: the address takes it 300 ms after the last key (`useTypedSearch`). */
  typed: string;
  onType: (typed: string) => void;
}) {
  useLocale();

  return (
    <>
      {seesTracker ? (
        <Places
          counts={counts}
          connectors={connectors}
          chosen={filters.place}
          onChoose={(place) => onFilter({ place })}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[10px]">
        <div className="min-w-0 flex-[999_1_240px]">
          <Field
            label={t('Search notes')}
            labelHidden
            compact
            type="search"
            // What the index searches (`searched` of FRU-244): the 64 characters, the page and the
            // reference in the tracker. Not the author, which the mockup says.
            // A guest reads no reference, and the route does not search one for them.
            placeholder={
              seesTracker ? t('Search the text, the page or the reference') : t('Search the text or the page')
            }
            value={typed}
            onChange={(event) => onType(event.target.value)}
          />
        </div>
        <div className="min-w-0 flex-[1_1_170px]">
          <Choice
            label={t('Site')}
            labelHidden
            compact
            value={filters.site === '' ? 'every' : filters.site}
            onChange={(site) => onFilter({ site: site === 'every' ? '' : site })}
            options={[
              { value: 'every', label: t('Every site') },
              ...(typeof sites === 'string'
                ? []
                : sites.map((site) => ({ value: site.id, label: siteLabel(site.origin) }))),
            ]}
          />
        </div>
        <div className="min-w-0 flex-[1_1_150px]">
          <Choice
            label={t('Status')}
            labelHidden
            compact
            value={filters.stage === '' ? 'any' : filters.stage}
            onChange={(stage) => onFilter({ stage: stage === 'any' ? '' : stage })}
            options={[
              { value: 'any', label: t('Any status') },
              ...STAGES.map((stage) => ({ value: stage, label: t(STAGE_NAMES[stage]) })),
            ]}
          />
        </div>
        <Checkbox
          label={t('Only my notes')}
          checked={filters.mine === '1'}
          onChange={(mine) => onFilter({ mine: mine ? '1' : '' })}
        />
      </div>
    </>
  );
}
