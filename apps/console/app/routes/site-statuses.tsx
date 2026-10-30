import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { readableTextColor } from '@fruitback/shared';
import { type Connector, STAGES, type Site, type Stage, call, placesOf, readSite } from '../api';
import { Confirmation } from '../confirm';
import { locale, msg, t } from '../i18n';
import { problemOf } from '../problems';
import { siteLabel } from '../site-address';
import {
  type ListKind,
  MAX_STATUSES,
  MIN_TEXT_CONTRAST,
  OWN,
  type ScreenStatus,
  type StatusRow,
  type TrackerState,
  colourOf,
  isChanged,
  isDeletable,
  keyFor,
  listOf,
  moved,
  ratioOf,
  reads,
  resetOf,
  rowOf,
  statusesOf,
} from '../site-statuses';
import { Button, Choice, Field, IconButton, LinkButton, LoadFailed, Problem, Radios, StatusDot, Toggle } from '../ui';
import { useLocale } from '../use-locale';
import { STAGE_NAMES, placeLabel } from './connector-parts';
import { PageHead, useWorkspace } from './workspace';

/**
 * The statuses of a site (FRU-371), as the board `design/site-statuses/` draws them: the list of the
 * worker's store and of a GitHub destination, with their name, stage, colour and the contrast of their
 * text; adding, editing, ordering by keyboard, deleting. docs/decisions/statuses.md is the model.
 *
 * - **One status is written at a time** (`POST …/statuses`), as the API takes them: a page-wide « Save »
 *   would be several writes that can half fail. The order and a reset write at once.
 * - **One write at a time** (FRU-123): the controls of the lists wait while one is written.
 * - **A Linear destination is said, not drawn**: its states take their stage on the panel of Linear
 *   (FRU-102) until the worker reads the statuses of a site for Linear (FRU-368).
 * - **The colours of the stages are read from the tokens** of `app.css`, so the ratios here are the ones
 *   of the colours on screen, and no value is written twice.
 */

/** The four states of a GitHub issue, in GitHub's words. */
const GITHUB_NAMES: Readonly<Record<string, string>> = {
  open: msg('Open'),
  'closed:completed': msg('Closed as completed'),
  'closed:not_planned': msg('Closed as not planned'),
  'closed:duplicate': msg('Closed as duplicate'),
};

const NOT_CHANGED = msg('This status did not change. Try again.');

/**
 * What `writeOne` answers when another write holds the lock: nothing was sent. It is never a success:
 * an editor stays open with what was typed, and nothing is said as done.
 */
const BUSY = Symbol('busy');
const STATUS_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace sets the statuses of a site.'),
  'too-many-statuses': msg('A site holds {count} statuses at most.'),
};

/** The states of one Linear team of the site, or why there are none (FRU-368). */
type TrackerList = { connector: string; teamId?: string; label?: string; states?: TrackerState[]; error?: string };

/** What the page read: the site, the sources of the workspace, the rows of the site, and its trackers. */
type Loaded = {
  site: Site;
  connectors: readonly Connector[];
  rows: readonly StatusRow[];
  /**
   * The notes in each status of the worker's store, by key (FRU-386). `undefined`: a worker of before,
   * which says the number only when it refuses a delete (`409 status-in-use`).
   */
  notes: Readonly<Record<string, number>> | undefined;
  /** `failed`: the worker did not say the states of the trackers. The other lists are still drawn. */
  tracker: { trackerColours: boolean; trackers: readonly TrackerList[] } | 'failed';
};

/** A list of the page: the worker's store, or a destination of the site. */
type Section =
  | { kind: 'own' }
  | { kind: 'github'; connector: Connector; teamId: string | undefined; label: string | undefined }
  | { kind: 'linear'; connector: Connector; teamId: string | undefined; label: string | undefined };

/** The key of a list of a tracker: its connector and its team, as a site can send to two teams of one. */
function sectionKey(section: Section): string {
  return section.kind === 'own' ? OWN : `${section.connector.id}:${section.teamId ?? ''}`;
}

/** The states the worker read for a list of Linear: the ones of its connector and of its team. */
function trackerOf(trackers: readonly TrackerList[], section: Section): TrackerList | undefined {
  if (section.kind !== 'linear') return undefined;

  return trackers.find((one) => one.connector === section.connector.id && one.teamId === section.teamId);
}

/** The lists of a site: the worker's store when its notes stay there, then each tracker it sends to. */
function sectionsOf(site: Site, connectors: readonly Connector[]): Section[] {
  const places = placesOf(site);
  const kindOf = (id: string): string | undefined => connectors.find((each) => each.id === id)?.kind;
  const sections: Section[] = [];
  // A site with no destination, or one that sends to an address, keeps its notes in the worker's store.
  if (places.length === 0 || places.some((place) => kindOf(place.connector) === 'rest')) sections.push({ kind: 'own' });
  const seen = new Set<string>();
  for (const place of places) {
    const connector = connectors.find((each) => each.id === place.connector);
    if (connector === undefined) continue;
    // One list per team of Linear, one per connector of GitHub (FRU-369): `listOf`.
    const list = listOf(connector.kind, place.connector, place.teamId);
    if (seen.has(list.key)) continue;
    seen.add(list.key);
    const kind: string = connector.kind;
    // A source its workspace named says its name in place of its kind (FRU-404): « Clients · Design ».
    if (kind === 'linear')
      sections.push({ kind, connector, teamId: list.teamId, label: placeLabel(connector, place.label) });
    // A list of GitHub is its connector's, and says every repository of it the site sends to: the label
    // of one would name the others wrongly. One repository keeps the label the worker gave its place.
    if (kind === 'github') {
      const repositories = places.filter((each) => each.connector === place.connector);
      const label =
        repositories.length < 2
          ? place.label
          : `GitHub · ${repositories.map((each) => each.teamId ?? each.connector).join(', ')}`;
      sections.push({ kind, connector, teamId: undefined, label: placeLabel(connector, label) });
    }
  }

  return sections;
}

/** The value of a token of `app.css`, as `#rrggbb`. */
function token(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;

  return colourOf(getComputedStyle(document.documentElement).getPropertyValue(name));
}

/** The colours of a status as it is drawn: the team's, or its default (the tracker's, or its stage's). */
function drawnOf(status: ScreenStatus) {
  return coloursOf(
    status.stage,
    status.color ?? status.defaultColor ?? null,
    status.color === null ? null : status.textColor,
  );
}

/** The colours a status is drawn with: what the style takes, and the `#rrggbb` its contrast is measured on. */
function coloursOf(stage: Stage, color: string | null, textColor: string | null) {
  const background = color ?? token(`--color-status-${stage}`);
  const ink = token('--color-ink');
  const text =
    textColor ?? (background === undefined || ink === undefined ? undefined : readableTextColor(background, ink));

  return {
    style: { background: color ?? `var(--color-status-${stage})`, ...(text === undefined ? {} : { color: text }) },
    ratio: ratioOf(background, text),
  };
}

/** A ratio as the language writes a number: « 9.90:1 », « 9,90:1 ». */
function ratioText(ratio: number): string {
  const number = new Intl.NumberFormat(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Rounded as the board writes it, except that a text under 4.5:1 never reads « 4.50:1 ».
  const shown = ratio < MIN_TEXT_CONTRAST ? Math.floor(ratio * 100) / 100 : ratio;

  return `${number.format(shown)}:1`;
}

/** The name a status shows: the one the team gave, or the tracker's, or the word of its stage. */
function nameOf(status: ScreenStatus): string {
  if (status.name !== null && status.name !== '') return status.name;
  if (status.trackerName !== undefined) return status.trackerName;
  const github = GITHUB_NAMES[status.key];
  if (status.source !== OWN && github !== undefined) return t(github);

  return t(STAGE_NAMES[status.defaultStage]);
}

export default function SiteStatuses() {
  useLocale();
  const { workspace } = useWorkspace();
  const { site: siteId = '' } = useParams();
  const base = `/console/workspaces/${workspace.id}`;
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const [read, setRead] = useState<Loaded | 'loading' | 'failed' | 'gone'>('loading');
  const [writing, setWriting] = useState(false);
  // The lock itself, set before the first await: `writing` is state, so two presses in one render both
  // read it as false, and two writes would leave at once (FRU-123, the lite review of pull request 493).
  const busy = useRef(false);
  const writeOne = useCallback(async <T,>(write: () => Promise<T>): Promise<T | typeof BUSY> => {
    if (busy.current) return BUSY;
    busy.current = true;
    setWriting(true);
    try {
      return await write();
    } finally {
      busy.current = false;
      setWriting(false);
    }
  }, []);
  // What the live region says: a move, a deletion. Set to the same words twice, it is said again.
  const [said, setSaid] = useState('');

  const load = useCallback(async () => {
    // A read again keeps the rows on the screen until its answer replaces them (FRU-271).
    setRead((current) => (typeof current === 'string' ? 'loading' : current));
    // The one site (FRU-497): the notes of the other sites are not counted for it.
    const [one, connectors, statuses, tracker] = await Promise.all([
      readSite(workspace.id, siteId),
      call<{ connectors: Connector[] }>('GET', `${base}/connectors`),
      call<{ statuses: StatusRow[]; notes?: Record<string, number> }>(
        'GET',
        `${base}/sites/${encodeURIComponent(siteId)}/statuses`,
      ),
      // FRU-368: the states of the Linear teams of the site, read now, and the switch of their colours.
      call<{ trackerColours: boolean; trackers: TrackerList[] }>(
        'GET',
        `${base}/sites/${encodeURIComponent(siteId)}/statuses/tracker`,
      ),
    ]);
    const site = one.ok && typeof one.data?.origin === 'string' ? one.data : undefined;
    if ((!one.ok && one.status === 404) || (!statuses.ok && statuses.status === 404)) return setRead('gone');
    // An answer with no list is no list (FRU-162): the page says it did not load.
    if (site === undefined || !connectors.ok || !statuses.ok || !Array.isArray(statuses.data?.statuses))
      return setRead('failed');
    setRead({
      site,
      connectors: connectors.data.connectors,
      rows: statuses.data.statuses,
      notes: notesOf(statuses.data.notes),
      tracker: tracker.ok && Array.isArray(tracker.data?.trackers) ? tracker.data : 'failed',
    });
  }, [base, siteId, workspace.id]);

  useEffect(() => {
    if (manages) void load();
  }, [load, manages]);

  const host = typeof read === 'string' ? undefined : siteLabel(read.site.origin);
  // The crumbs are in the room above the title (21 px of words and 10 px under them, in the 40 px of
  // the top of the screen): the title of every page is at the same place (FRU-405).
  const crumbs = (
    <nav
      aria-label={t('Breadcrumb')}
      className="-mt-[31px] mb-[10px] flex flex-wrap items-center gap-[8px] text-small text-muted"
    >
      <LinkButton space="inline" to={`/w/${workspace.id}/sites`}>
        {t('Sites')}
      </LinkButton>
      {host === undefined ? null : (
        <>
          <span aria-hidden="true">›</span>
          {/* The site has a page of its own (FRU-433), and the crumbs lead back to it. */}
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <LinkButton space="inline" to={`/w/${workspace.id}/sites/${encodeURIComponent(siteId)}`}>
              {host}
            </LinkButton>
          </span>
        </>
      )}
    </nav>
  );
  const head = (
    <PageHead
      title={t('Statuses')}
      lead={t(
        'The name and the colour of each status, and the stage it belongs to. The stage decides the filters and the counts.',
      )}
    />
  );

  if (!manages)
    return (
      <>
        {crumbs}
        {head}
        <p className="text-body text-muted">
          {t('Only an owner or an admin of the workspace sets the statuses of a site.')}
        </p>
      </>
    );

  const tracker = typeof read === 'string' || read.tracker === 'failed' ? undefined : read.tracker;
  const sections = typeof read === 'string' ? [] : sectionsOf(read.site, read.connectors);
  // The switch is the site's (FRU-368): drawn once, above the first list of Linear that was read, or
  // above the first Linear section when none was, so it can always be turned off (lite reviews of
  // pull request 495).
  const isRead = (section: Section) =>
    section.kind === 'linear' &&
    (tracker === undefined ? undefined : trackerOf(tracker.trackers, section))?.states !== undefined;
  const firstRead = sections.findIndex(isRead);
  const switchAt = firstRead === -1 ? sections.findIndex((section) => section.kind === 'linear') : firstRead;
  const setTrackerColours = async (on: boolean): Promise<string | undefined> => {
    const set = await writeOne(() =>
      call('POST', `${base}/sites/${encodeURIComponent(siteId)}/statuses/settings`, {
        trackerColours: on,
      }),
    );
    if (set === BUSY || !set.ok) return set === BUSY ? NOT_CHANGED : problemOf(set, STATUS_PROBLEMS, NOT_CHANGED);
    setRead((current) =>
      typeof current === 'string' || current.tracker === 'failed'
        ? current
        : { ...current, tracker: { ...current.tracker, trackerColours: on } },
    );

    return undefined;
  };

  const onRows = (change: (rows: readonly StatusRow[]) => readonly StatusRow[]) =>
    setRead((current) => (typeof current === 'string' ? current : { ...current, rows: change(current.rows) }));
  // A status deleted: it counts nothing, and the status that took its notes counts them too.
  const onDeleted = (key: string, moved: number, to: string | undefined) =>
    setRead((current) => {
      if (typeof current === 'string' || current.notes === undefined) return current;
      const { [key]: _gone, ...notes } = current.notes;

      return { ...current, notes: to === undefined ? notes : { ...notes, [to]: (notes[to] ?? 0) + moved } };
    });

  return (
    <>
      {crumbs}
      {head}
      {read === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {read === 'gone' ? (
        <p className="text-body text-muted">{t('This site is not in the workspace any more.')}</p>
      ) : null}
      {read === 'failed' ? (
        <LoadFailed
          title={t('The statuses did not load')}
          detail={t('Fruitback did not answer. Your statuses are safe.')}
          retry={t('Try again')}
          onRetry={() => void load()}
        />
      ) : null}
      {typeof read === 'string' ? null : (
        <div className="flex flex-col gap-[36px]">
          {sections.map((section, index) => {
            const linear =
              section.kind === 'linear' && read.tracker !== 'failed'
                ? trackerOf(read.tracker.trackers, section)
                : undefined;
            if (section.kind === 'linear' && linear?.states === undefined)
              return (
                <LinearUnread
                  key={sectionKey(section)}
                  id={`statuses-${sectionKey(section)}`}
                  label={section.label}
                  onRetry={() => void load()}
                  {...(index === switchAt && tracker !== undefined
                    ? {
                        colours: (
                          <TrackerColours
                            value={tracker.trackerColours}
                            disabled={writing}
                            onChange={setTrackerColours}
                          />
                        ),
                      }
                    : {})}
                />
              );
            return (
              <StatusList
                key={sectionKey(section)}
                id={`statuses-${sectionKey(section)}`}
                kind={section.kind}
                source={section.kind === 'own' ? OWN : section.connector.id}
                label={section.kind === 'own' ? undefined : section.label}
                states={linear?.states ?? []}
                trackerColours={tracker?.trackerColours === true}
                {...(index === switchAt ? { onTrackerColours: setTrackerColours } : {})}
                rows={read.rows}
                notes={section.kind === 'own' ? read.notes : undefined}
                onRows={onRows}
                onDeleted={onDeleted}
                path={`${base}/sites/${encodeURIComponent(siteId)}/statuses`}
                writing={writing}
                writeOne={writeOne}
                onSay={(words) => setSaid((before) => (before === words ? `${words} ` : words))}
              />
            );
          })}
        </div>
      )}
      {/* Says a move and a deletion, which change the list without moving focus. */}
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </>
  );
}

/** A Linear destination whose states the worker could not read: it says so, and reads them again. */
function LinearUnread({
  id,
  label,
  onRetry,
  colours,
}: {
  id: string;
  label: string | undefined;
  onRetry: () => void;
  /** The switch of the site, when this section is where it is drawn. */
  colours?: ReactNode;
}) {
  useLocale();

  return (
    <section aria-labelledby={id} className="max-w-[760px]">
      <h2 id={id} className="mb-[12px] text-section font-semibold [overflow-wrap:anywhere]">
        {label ?? t('Linear')}
      </h2>
      {colours}
      <div className="mt-[8px] flex flex-wrap items-center gap-[12px]">
        <p role="alert" className="min-w-0 flex-1 text-small text-muted">
          {t('Fruitback could not read the states of Linear. The statuses you set are not lost.')}
        </p>
        <Button tone="outline" onClick={onRetry}>
          {t('Try again')}
        </Button>
      </div>
    </section>
  );
}

/** What is open under a status: its editor, the first and the second time of its deletion. */
type Open = { key: string; what: 'edit' | 'delete' } | { key: string; what: 'move'; notes: number };

type StatusListProps = {
  /** The id of its heading, unique on the page. */
  id: string;
  kind: ListKind;
  source: string;
  /** The words of the destination, as the worker wrote them: « GitHub · acme/website ». */
  label: string | undefined;
  /** The states of the tracker, for a Linear list (FRU-368). */
  states: readonly TrackerState[];
  /** The site draws its tracker's states in the tracker's colours. */
  trackerColours: boolean;
  /** Turns that switch: the list that shows it. The sentence of a refusal, or `undefined`. */
  onTrackerColours?: (on: boolean) => Promise<string | undefined>;
  rows: readonly StatusRow[];
  /** The notes in each status, for the list of the worker's store when the worker says them (FRU-386). */
  notes: Readonly<Record<string, number>> | undefined;
  onRows: (change: (rows: readonly StatusRow[]) => readonly StatusRow[]) => void;
  /** The status `key` was deleted, and `moved` of its notes went to the status `to`. */
  onDeleted: (key: string, moved: number, to: string | undefined) => void;
  path: string;
  writing: boolean;
  /** Runs one write, or nothing while another is running: one write at a time for the whole page. */
  writeOne: <T>(write: () => Promise<T>) => Promise<T | typeof BUSY>;
  onSay: (words: string) => void;
};

/** The statuses of one source of the site, in their order, and what can be done to each. */
function StatusList({
  id,
  kind,
  source,
  label,
  states,
  trackerColours,
  onTrackerColours,
  rows,
  notes,
  onRows,
  onDeleted,
  path,
  writing,
  writeOne,
  onSay,
}: StatusListProps) {
  useLocale();
  const statuses = statusesOf(kind, source, rows, states).map((status) =>
    trackerColours && status.trackerColor !== undefined ? { ...status, defaultColor: status.trackerColor } : status,
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const list = useRef<HTMLDivElement>(null);
  // Where focus goes once the list is drawn again: a button of a row, by the key of its status.
  const [focus, setFocus] = useState<{ key: string; control: string } | undefined>();
  const heading = id;

  useEffect(() => {
    if (focus === undefined || writing) return;
    const row = list.current?.querySelector(`[data-status-key="${CSS.escape(focus.key)}"]`);
    const wanted = row?.querySelector<HTMLElement>(`[data-control="${focus.control}"] button:not([disabled])`);
    // A move to an end disables the button that made it: the other one of the row takes focus.
    (wanted ?? row?.querySelector<HTMLElement>('[data-control^="move"] button:not([disabled])'))?.focus();
    setFocus(undefined);
  }, [focus, writing, rows]);

  /** Adds or changes a status at the worker. The sentence of the refusal, or `undefined` once it is kept. */
  async function save(status: ScreenStatus): Promise<string | undefined> {
    const answer = await call<{ status: StatusRow }>('POST', path, rowOf(status));
    if (!answer.ok) return problemOf(answer, STATUS_PROBLEMS, NOT_CHANGED);
    const kept = answer.data.status;
    onRows((current) => [...current.filter((row) => row.source !== kept.source || row.key !== kept.key), kept]);

    return undefined;
  }

  async function move(index: number, step: -1 | 1) {
    const next = moved(statuses, index, step);
    const status = statuses[index];
    if (next === undefined || status === undefined) return;
    setProblem(undefined);
    setOpen(undefined);
    await writeOne(async () => {
      // The worker orders the statuses it keeps: a default with no row gets one first, at its new place.
      for (const each of next.filter((one) => !one.kept)) {
        const refused = await save(each);
        if (refused !== undefined) return setProblem(msg('The order did not change. Try again.'));
      }
      const order = next.map((each) => ({ source: each.source, key: each.key }));
      const ordered = await call('POST', `${path}/order`, { order });
      if (!ordered.ok)
        return setProblem(problemOf(ordered, STATUS_PROBLEMS, msg('The order did not change. Try again.')));
      onRows((current) =>
        current.map((row) => {
          const position = next.findIndex((each) => each.source === row.source && each.key === row.key);

          return position === -1 ? row : { ...row, position };
        }),
      );
      onSay(
        t('{name} is now {position} of {total}.', {
          name: nameOf(status),
          position: index + step + 1,
          total: next.length,
        }),
      );
    });
    setFocus({ key: status.key, control: step === -1 ? 'move-up' : 'move-down' });
  }

  async function reset(status: ScreenStatus) {
    setProblem(undefined);
    const refused = await writeOne(() => save(resetOf(status)));
    if (refused === BUSY) return;
    if (refused !== undefined) setProblem(refused);
    else onSay(t('{name} is back to what it was.', { name: nameOf(resetOf(status)) }));
    setFocus({ key: status.key, control: 'edit' });
  }

  async function remove(status: ScreenStatus, moveTo?: ScreenStatus) {
    setProblem(undefined);
    const query = moveTo === undefined ? '' : `?moveTo=${encodeURIComponent(moveTo.key)}`;
    const removed = await writeOne(() =>
      call<{ moved: number }>(
        'DELETE',
        `${path}/${encodeURIComponent(source)}/${encodeURIComponent(status.key)}${query}`,
      ),
    );
    if (removed === BUSY) return;
    if (!removed.ok && removed.error === 'status-in-use' && removed.notes !== undefined && moveTo === undefined)
      return setOpen({ key: status.key, what: 'move', notes: removed.notes });
    if (!removed.ok)
      return setProblem(problemOf(removed, STATUS_PROBLEMS, msg('This status is still here. Try again.')));
    setOpen(undefined);
    onRows((current) => current.filter((row) => row.source !== status.source || row.key !== status.key));
    // A worker that answers with no body (204) says no number: the target takes the notes the list
    // counted in the status deleted (lite reviews of PR 541).
    const moved = removed.data?.moved;
    onDeleted(status.key, typeof moved === 'number' ? moved : (notes?.[status.key] ?? 0), moveTo?.key);
    onSay(
      moveTo === undefined
        ? t('« {name} » was deleted.', { name: nameOf(status) })
        : t('« {name} » was deleted, and its notes are in « {target} ».', {
            name: nameOf(status),
            target: nameOf(moveTo),
          }),
    );
    document.getElementById(heading)?.focus();
  }

  const close = (key: string, control: string) => {
    setOpen(undefined);
    setFocus({ key, control });
  };

  return (
    <section aria-labelledby={heading}>
      <div className="mb-[12px] flex flex-wrap items-end justify-between gap-x-[24px] gap-y-[12px]">
        <div className="min-w-0 max-w-[720px]">
          <h2 id={heading} tabIndex={-1} className="text-section font-semibold [overflow-wrap:anywhere]">
            {kind === 'own' ? t('Notes kept in Fruitback') : (label ?? (kind === 'linear' ? t('Linear') : t('GitHub')))}
          </h2>
          <p className="mt-[4px] text-small text-muted">{leadOf(kind)}</p>
        </div>
        {kind === 'own' ? (
          <Button
            disabled={writing || adding || statuses.length >= MAX_STATUSES}
            onClick={() => {
              setOpen(undefined);
              setAdding(true);
            }}
          >
            {t('Add a status')}
          </Button>
        ) : null}
      </div>

      {onTrackerColours === undefined ? null : (
        <TrackerColours value={trackerColours} disabled={writing} onChange={onTrackerColours} />
      )}
      <div ref={list} className="@container">
        <div
          aria-hidden="true"
          className="hidden px-[20px] pb-[8px] text-label font-semibold text-muted @min-[860px]:flex @min-[860px]:gap-x-[12px]"
        >
          <span className="w-[84px] flex-none">{t('Order')}</span>
          <span className="grid flex-1 grid-cols-[minmax(200px,1.6fr)_140px_minmax(150px,1fr)_120px_minmax(150px,auto)] gap-x-[12px]">
            <span>{t('Status')}</span>
            <span>{t('Stage')}</span>
            <span>{t('Colour')}</span>
            <span>{t('Text')}</span>
            <span />
          </span>
        </div>
        <ol aria-labelledby={heading} className="overflow-hidden rounded-frame border border-line">
          {statuses.map((status, index) => (
            <StatusItem
              key={status.key}
              status={status}
              first={index === 0}
              last={index === statuses.length - 1}
              writing={writing}
              open={open?.key === status.key ? open : undefined}
              onMove={(step) => void move(index, step)}
              onEdit={() => {
                setAdding(false);
                setProblem(undefined);
                setOpen({ key: status.key, what: 'edit' });
              }}
              onReset={() => void reset(status)}
              {...(notes === undefined ? {} : { notes: notes[status.key] ?? 0 })}
              onDelete={() => {
                setAdding(false);
                setProblem(undefined);
                // FRU-386: notes are in it, so the first step is where they go. The `409` of the
                // worker stays the net for a note written since the list was read.
                const held = notes?.[status.key] ?? 0;
                setOpen(
                  held > 0 ? { key: status.key, what: 'move', notes: held } : { key: status.key, what: 'delete' },
                );
              }}
            >
              {open?.key === status.key && open.what === 'edit' ? (
                <StatusEditor
                  status={status}
                  disabled={writing}
                  onSave={async (next) => {
                    const refused = await writeOne(() => save(next));
                    // Another write held the lock: nothing was sent, and the editor keeps what was typed.
                    if (refused === BUSY) return NOT_CHANGED;
                    if (refused === undefined) close(status.key, 'edit');

                    return refused;
                  }}
                  onCancel={() => close(status.key, 'edit')}
                />
              ) : null}
              {open?.key === status.key && open.what === 'delete' ? (
                <Confirmation
                  confirmLabel={t('Delete {name}', { name: nameOf(status) })}
                  consequence={t(
                    '« {name} » goes from this site. If notes are in it, you choose where they go first.',
                    { name: nameOf(status) },
                  )}
                  onConfirm={() => void remove(status)}
                  onKeep={() => close(status.key, 'delete')}
                />
              ) : null}
              {open?.key === status.key && open.what === 'move' ? (
                <MoveNotes
                  status={status}
                  notes={open.notes}
                  targets={statuses.filter((each) => each.key !== status.key)}
                  disabled={writing}
                  onMove={(target) => void remove(status, target)}
                  onKeep={() => close(status.key, 'delete')}
                />
              ) : null}
            </StatusItem>
          ))}
        </ol>
      </div>
      {/* FRU-538: the « 3 » of each pin is a sample, and the list says so once. */}
      <p className="mt-[8px] text-hint text-muted">
        {t('Each pin shows how a note in that status looks on the page. The 3 is an example number.')}
      </p>
      {statuses.some(stageColoured) ? (
        <p className="mt-[4px] text-hint text-muted">
          {t('A swatch with no code is the colour of the stage of its status.')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <div className="mt-[12px]">
          <Problem>{t(problem, { count: MAX_STATUSES })}</Problem>
        </div>
      )}
      {adding ? (
        <div className="mt-[16px]">
          <StatusEditor
            status={{
              source: OWN,
              key: '',
              name: '',
              stage: 'todo',
              color: null,
              textColor: null,
              position: statuses.length,
              origin: 'team',
              hidden: false,
              defaultStage: 'todo',
              builtIn: false,
              kept: false,
              rank: statuses.length,
            }}
            adding
            disabled={writing}
            onSave={async (next) => {
              const status = {
                ...next,
                key: keyFor(
                  next.name ?? '',
                  statuses.map((each) => each.key),
                ),
              };
              const refused = await writeOne(() => save(status));
              if (refused === BUSY) return NOT_CHANGED;
              if (refused === undefined) {
                setAdding(false);
                setFocus({ key: status.key, control: 'edit' });
                onSay(t('« {name} » was added.', { name: nameOf(status) }));
              }

              return refused;
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : null}
    </section>
  );
}

/** What a list says under its title. */
function leadOf(kind: ListKind): string {
  if (kind === 'own')
    return t('Five statuses are built in, one for each stage. Rename them, recolour them, or add your own.');
  if (kind === 'github') return t('A GitHub issue has four states. Rename them, recolour them, or change their stage.');

  return t(
    'The states of the Linear team this site sends to. Rename them, recolour them, or change their stage. A state added in Linear appears here.',
  );
}

/**
 * « Use Linear's colours » (FRU-368): a switch of the site, off by default, written at once. A refusal
 * puts it back and says why.
 */
function TrackerColours({
  value,
  disabled,
  onChange,
}: {
  value: boolean;
  disabled: boolean;
  onChange: (on: boolean) => Promise<string | undefined>;
}) {
  useLocale();
  const [problem, setProblem] = useState<string | undefined>();

  return (
    <div className="mb-[20px] max-w-[760px] rounded-frame border border-line px-[20px] py-[16px]">
      <Toggle
        strong
        label={t("Use Linear's colours")}
        hint={t('A status with no colour chosen here takes its colour in Linear. Off: the colours of Fruitback.')}
        value={value}
        disabled={disabled}
        onChange={(on) => {
          setProblem(undefined);
          void onChange(on).then(setProblem);
        }}
      />
      {problem === undefined ? null : (
        <div className="mt-[12px]">
          <Problem>{t(problem)}</Problem>
        </div>
      )}
    </div>
  );
}

/** The drop of a pin and the chip of a name, in the colours of a status, as the widget draws them. */
function StatusMark({ name, style }: { name: string; style: ReturnType<typeof coloursOf>['style'] }) {
  return (
    <span className="flex min-w-0 items-center gap-[14px]">
      <span aria-hidden="true" className="kit-pin" style={style}>
        <span>3</span>
      </span>
      <span className="kit-status-chip [overflow-wrap:anywhere]" style={style}>
        {name}
      </span>
    </span>
  );
}

const ARROW_UP = 'M6 15l6-6 6 6';
const ARROW_DOWN = 'M6 9l6 6 6-6';

type StatusItemProps = {
  status: ScreenStatus;
  first: boolean;
  last: boolean;
  writing: boolean;
  open: Open | undefined;
  /** How many notes are in it: the worker's store only, and a worker that says it (FRU-386). */
  notes?: number;
  onMove: (step: -1 | 1) => void;
  onEdit: () => void;
  onReset: () => void;
  onDelete: () => void;
  /** What is open under the row. */
  children: ReactNode;
};

/** The row of a status: its order, the status as a pin draws it, its stage, its colour, its text, its actions. */
function StatusItem({
  status,
  first,
  last,
  writing,
  open,
  notes,
  onMove,
  onEdit,
  onReset,
  onDelete,
  children,
}: StatusItemProps) {
  useLocale();
  const name = nameOf(status);
  const { style, ratio } = drawnOf(status);
  const arrow = (path: string) => (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  let from = t('Added by your team');
  if (status.builtIn) from = t('Built in');
  else if (status.trackerName !== undefined) from = t('In Linear: {name}', { name: status.trackerName });
  else if (status.source !== OWN) from = t('In GitHub: {name}', { name: t(GITHUB_NAMES[status.key] ?? status.key) });
  const label = 'shrink-0 text-hint text-muted @min-[860px]:sr-only';

  return (
    <li
      data-status-key={status.key}
      className={`flex flex-wrap items-start gap-x-[12px] gap-y-[8px] border-b border-line px-[20px] py-[12px] text-table last:border-b-0 max-[480px]:px-[12px] ${open === undefined ? '' : 'bg-subtle'}`}
    >
      {/* Ordering is two buttons, for a keyboard and a pointer alike: no drag only. */}
      <span className="flex w-[84px] flex-none items-center gap-[4px] @max-[859px]:w-[36px] @max-[859px]:flex-col">
        <span data-control="move-up" className="contents">
          <IconButton label={t('Move {name} up', { name })} disabled={first || writing} onClick={() => onMove(-1)}>
            {arrow(ARROW_UP)}
          </IconButton>
        </span>
        <span data-control="move-down" className="contents">
          <IconButton label={t('Move {name} down', { name })} disabled={last || writing} onClick={() => onMove(1)}>
            {arrow(ARROW_DOWN)}
          </IconButton>
        </span>
      </span>
      <span className="grid min-w-0 flex-1 grid-cols-1 items-center gap-x-[12px] gap-y-[6px] @min-[860px]:grid-cols-[minmax(200px,1.6fr)_140px_minmax(150px,1fr)_120px_minmax(150px,auto)]">
        <span className="flex min-w-0 flex-col gap-[3px]">
          <StatusMark name={name} style={style} />
          <span className="pl-[42px] text-hint text-muted">
            {from}
            {notes === undefined ? null : ` · ${notesText(notes)}`}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className={`${label} w-[64px]`}>{t('Stage')}</span>
          <StatusDot status={status.stage} size={10} />
          {t(STAGE_NAMES[status.stage])}
        </span>
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className={`${label} w-[64px]`}>{t('Colour')}</span>
          <span aria-hidden="true" className="kit-swatch" style={{ background: style.background }} />
          {/* FRU-504: the colour of the stage is said once, under the list; a screen reader hears it here. */}
          {status.color === null ? (
            <span className={stageColoured(status) ? 'sr-only' : ''}>{t(defaultColourOf(status))}</span>
          ) : (
            <code className="font-mono">{status.color}</code>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className={`${label} w-[64px]`}>{t('Text')}</span>
          <Ratio ratio={ratio} auto={status.textColor === null} />
        </span>
        <span className="flex flex-wrap items-center gap-[6px] @min-[860px]:justify-end">
          <span data-control="edit" className="contents">
            <Button tone="outline" size="small" label={t('Edit {name}', { name })} disabled={writing} onClick={onEdit}>
              {t('Edit')}
            </Button>
          </span>
          {isDeletable(status) ? (
            <span data-control="delete" className="contents">
              <Button
                tone="quiet"
                size="small"
                label={t('Delete {name}', { name })}
                disabled={writing}
                onClick={onDelete}
              >
                {t('Delete')}
              </Button>
            </span>
          ) : null}
          {isChanged(status) ? (
            <span data-control="reset" className="contents">
              <Button
                tone="quiet"
                size="small"
                label={t('Reset {name}', { name })}
                disabled={writing}
                onClick={onReset}
              >
                {t('Reset')}
              </Button>
            </span>
          ) : null}
        </span>
      </span>
      {open === undefined ? null : <div className="w-full basis-full">{children}</div>}
    </li>
  );
}

/** How many notes are in a status, in words. */
function notesText(notes: number): string {
  if (notes === 0) return t('No notes');

  return notes === 1 ? t('1 note') : t('{count} notes', { count: notes });
}

/** The notes of each status as the worker says them, or `undefined` for anything that is not such a map. */
function notesOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => Number.isInteger(entry[1]) && (entry[1] as number) >= 0,
  );

  return Object.fromEntries(entries);
}

/** A status drawn in the colour of its stage: no colour of the team, and none of a tracker. */
function stageColoured(status: ScreenStatus): boolean {
  return status.color === null && status.defaultColor === undefined;
}

/** The words of the colour a status has when the team chose none: the tracker's, or its stage's. */
function defaultColourOf(status: ScreenStatus): string {
  return status.defaultColor === undefined ? msg('Colour of the stage') : msg("Linear's colour");
}

/**
 * The contrast of a text on its status, in words and with a mark, never by its colour alone (FRU-504):
 * « Readable » or « Low contrast ». The ratio and whether the text is Auto are in the tooltip and for a
 * screen reader; the editor says the ratio in a sentence.
 */
function Ratio({ ratio, auto }: { ratio: number | undefined; auto: boolean }) {
  useLocale();
  if (ratio === undefined) return <span className="text-muted">{auto ? t('Auto') : '·'}</span>;
  const detail = auto
    ? t('Contrast {ratio}, text colour Auto', { ratio: ratioText(ratio) })
    : t('Contrast {ratio}', { ratio: ratioText(ratio) });

  return reads(ratio) ? (
    <span title={detail} className="inline-flex items-center gap-[5px] text-done">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[16px] w-[16px] flex-none">
        <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      {t('Readable')}
      <span className="sr-only">, {detail}</span>
    </span>
  ) : (
    <span title={detail} className="inline-flex items-center gap-[5px] font-semibold text-accent-strong">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[16px] w-[16px] flex-none">
        <path d="M12 3l10 18H2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M12 10v5M12 18v.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      {t('Low contrast')}
      <span className="sr-only">, {detail}</span>
    </span>
  );
}

/** What an empty name gives, said under the field: the word of a built-in stage, or the tracker's name. */
function nameHintOf(status: ScreenStatus): string | undefined {
  if (status.builtIn)
    return t('Empty: « {name} », in the language of each person.', { name: t(STAGE_NAMES[status.defaultStage]) });
  if (status.trackerName !== undefined)
    return t('Empty: the name in Linear, « {name} ».', { name: status.trackerName });

  return undefined;
}

/** What the preview says of the contrast of its text, as the field of the text will be judged. */
function RatioSentence({ ratio }: { ratio: number | undefined }) {
  useLocale();
  if (ratio === undefined) return t('Type a colour to see how its text reads.');
  if (reads(ratio)) return t('Text on this colour: {ratio}. It reads well.', { ratio: ratioText(ratio) });

  return t('Text on this colour: {ratio}. Text needs 4.5:1 at least: choose Auto, or a darker or lighter text.', {
    ratio: ratioText(ratio),
  });
}

type EditorProps = {
  status: ScreenStatus;
  /** A status the team adds: its name is required, and the button says « Add the status ». */
  adding?: boolean;
  disabled: boolean;
  /** Writes it: the sentence of the refusal, or `undefined` once it is kept. */
  onSave: (status: ScreenStatus) => Promise<string | undefined>;
  onCancel: () => void;
};

/**
 * The name, the stage and the colours of a status, with a preview and the contrast of its text.
 *
 * WARNING: no refusal clears a field (FRU-164). A text under 4.5:1 is not sent: the press gives focus to
 * the field of the text, which the sentence describes. The worker refuses it anyway (`text-under-contrast`).
 */
function StatusEditor({ status, adding = false, disabled, onSave, onCancel }: EditorProps) {
  useLocale();
  const [name, setName] = useState(status.name ?? '');
  const [stage, setStage] = useState<Stage>(status.stage);
  const [background, setBackground] = useState<'stage' | 'own'>(status.color === null ? 'stage' : 'own');
  const [typedBackground, setTypedBackground] = useState(status.color ?? '');
  const [text, setText] = useState<'auto' | 'own'>(status.textColor === null ? 'auto' : 'own');
  const [typedText, setTypedText] = useState(status.textColor ?? '');
  const [errors, setErrors] = useState<{ name?: string; background?: string; text?: string }>({});
  const [problem, setProblem] = useState<string | undefined>();
  const title = useRef<HTMLHeadingElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const backgroundField = useRef<HTMLInputElement>(null);
  const textField = useRef<HTMLInputElement>(null);

  // A press of « Edit » or « Add a status » opened it: focus goes to it, and the field of the name first
  // for a new one.
  useEffect(() => {
    (adding ? nameField.current : title.current)?.focus();
  }, [adding]);

  const color = background === 'own' ? (colourOf(typedBackground) ?? null) : null;
  // A text colour goes with a colour of the team only: the worker refuses one on the colour of a stage
  // or of the tracker (`text-without-color`), and the list would not draw it (lite review of pull
  // request 495). With no colour of its own, the text is Auto.
  const textChoice = background === 'own' ? text : 'auto';
  const textColor = textChoice === 'own' ? (colourOf(typedText) ?? null) : null;
  // With no colour of its own, the status takes its default: the tracker's when the site asks, else its stage's.
  const drawn = coloursOf(stage, background === 'own' ? color : (status.defaultColor ?? null), textColor);
  // A colour that is not typed yet draws nothing of its own: the stage, until it is one.
  const ownTyped = background === 'own' && color === null;
  const fallback = adding ? t('New status') : nameOf({ ...status, name: null });
  const nameShown = name.trim() === '' ? fallback : name.trim();
  // A built-in status keeps its stage (`400 built-in-stage`): the notes with no status of their own are in it.
  const editable = !status.builtIn;
  const typeColour = msg('Type a colour as # and six digits or letters from a to f.');

  async function submit() {
    const found: typeof errors = {};
    if (adding && name.trim() === '') found.name = t('Give the status a name.');
    if (background === 'own' && color === null) found.background = t(typeColour);
    if (textChoice === 'own' && textColor === null) found.text = t(typeColour);
    else if (textChoice === 'own' && !reads(drawn.ratio))
      found.text = t('Text needs 4.5:1 at least: choose Auto, or a darker or lighter text.');
    setErrors(found);
    setProblem(undefined);
    // Focus goes to the first field the press refused, which its sentence describes.
    if (found.name !== undefined) return nameField.current?.focus();
    if (found.background !== undefined) return backgroundField.current?.focus();
    if (found.text !== undefined) return textField.current?.focus();
    const refused = await onSave({
      ...status,
      name: name.trim() === '' ? null : name.trim(),
      stage,
      color: background === 'own' ? color : null,
      textColor: textChoice === 'own' ? textColor : null,
    });
    if (refused !== undefined) setProblem(refused);
  }

  const heading = adding ? t('Add a status') : t('Edit {name}', { name: nameOf(status) });

  return (
    <section
      aria-label={heading}
      className="mt-[4px] rounded-frame border border-line bg-surface p-[20px] max-[480px]:p-[14px]"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <h3 ref={title} tabIndex={-1} className="mb-[14px] text-step font-semibold [overflow-wrap:anywhere]">
        {heading}
      </h3>
      <div className="grid grid-cols-1 gap-[24px] min-[960px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex max-w-[440px] min-w-0 flex-col gap-[18px]">
          <Field
            label={t('Name')}
            value={name}
            maxLength={200}
            inputRef={nameField}
            onChange={(event) => setName(event.target.value)}
            {...(adding ? {} : { placeholder: nameOf({ ...status, name: null }) })}
            {...(nameHintOf(status) === undefined ? {} : { hint: nameHintOf(status) })}
            {...(errors.name === undefined ? {} : { error: errors.name })}
          />
          <Choice
            label={t('Stage')}
            value={stage}
            status={stage}
            disabled={!editable}
            onChange={(value) => setStage(value as Stage)}
            options={STAGES.map((each) => ({ value: each, label: t(STAGE_NAMES[each]) }))}
            hint={
              editable
                ? t('The stage decides the filters, the counts, and when a note looks fixed.')
                : t('A built-in status keeps its stage: the notes with no status of their own are in it.')
            }
          />
          <div className="flex flex-col gap-[8px]">
            <Radios
              label={t('Colour')}
              value={background}
              onChange={setBackground}
              options={[
                { value: 'stage', label: t(defaultColourOf(status)) },
                { value: 'own', label: t('Your colour') },
              ]}
            />
            {background === 'own' ? (
              <span className="flex items-start gap-[10px] pl-[26px]">
                <span
                  aria-hidden="true"
                  className="kit-swatch mt-[35px]"
                  style={{ background: drawn.style.background }}
                />
                <span className="w-[180px]">
                  <Field
                    code
                    label={t('Hex code of the colour')}
                    placeholder="#rrggbb"
                    value={typedBackground}
                    inputRef={backgroundField}
                    onChange={(event) => setTypedBackground(event.target.value)}
                    {...(errors.background === undefined ? {} : { error: errors.background })}
                  />
                </span>
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-[8px]">
            <Radios
              label={t('Text')}
              value={textChoice}
              onChange={setText}
              disabled={background !== 'own'}
              {...(background === 'own'
                ? {}
                : { hint: t('A text colour of your own goes with a colour of your own.') })}
              options={[
                { value: 'auto', label: t('Auto: dark or white, whichever reads better') },
                { value: 'own', label: t('Your colour') },
              ]}
            />
            {textChoice === 'own' ? (
              <span className="flex items-start gap-[10px] pl-[26px]">
                <span
                  aria-hidden="true"
                  className="kit-swatch mt-[35px]"
                  style={{ background: textColor ?? undefined }}
                />
                <span className="w-[180px]">
                  <Field
                    code
                    label={t('Hex code of the text')}
                    placeholder="#rrggbb"
                    value={typedText}
                    inputRef={textField}
                    onChange={(event) => setTypedText(event.target.value)}
                    {...(errors.text === undefined ? {} : { error: errors.text })}
                  />
                </span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-[10px]">
          <span className="text-label font-semibold">{t('Preview')}</span>
          {/* The preview is a picture of the colours chosen, even those the screen refuses: hidden from
              a screen reader, which reads the sentence under it (the contrast, in words). */}
          <div aria-hidden="true" data-sample className="flex flex-col gap-[10px]">
            <div className="flex flex-col gap-[10px] rounded-box border border-line bg-subtle p-[14px]">
              <span className="text-tiny text-muted">{t('On a light page')}</span>
              <StatusMark name={nameShown} style={drawn.style} />
            </div>
            <div className="flex flex-col gap-[10px] rounded-box bg-rail p-[14px]">
              <span className="text-tiny text-rail-text">{t('On a dark page')}</span>
              <StatusMark name={nameShown} style={drawn.style} />
            </div>
          </div>
          <p role="status" className="text-small">
            {ownTyped ? t('Type a colour to see how its text reads.') : <RatioSentence ratio={drawn.ratio} />}
          </p>
        </div>
      </div>
      {problem === undefined ? null : (
        <div className="mt-[14px]">
          <Problem>{t(problem, { count: MAX_STATUSES })}</Problem>
        </div>
      )}
      <div className="mt-[18px] flex flex-wrap gap-[10px]">
        <Button size="panel" disabled={disabled} onClick={() => void submit()}>
          {adding ? t('Add the status') : t('Save')}
        </Button>
        <Button tone="outline" onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </div>
    </section>
  );
}

type MoveNotesProps = {
  status: ScreenStatus;
  notes: number;
  targets: readonly ScreenStatus[];
  disabled: boolean;
  onMove: (target: ScreenStatus) => void;
  onKeep: () => void;
};

/** The second step of deleting a status that holds notes: where they go. The built-in status of its stage first. */
function MoveNotes({ status, notes, targets, disabled, onMove, onKeep }: MoveNotesProps) {
  useLocale();
  const ordered = [
    ...targets.filter((each) => each.builtIn && each.defaultStage === status.stage),
    ...targets.filter((each) => !(each.builtIn && each.defaultStage === status.stage)),
  ];
  const [chosen, setChosen] = useState(ordered[0]?.key ?? '');
  const target = ordered.find((each) => each.key === chosen);
  const name = nameOf(status);

  return (
    <div
      role="group"
      aria-label={t('Delete {name}', { name })}
      className="mt-[4px] flex flex-col gap-[12px] rounded-frame border border-line bg-surface p-[20px] max-[480px]:p-[14px]"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onKeep();
      }}
    >
      <p className="text-body">
        <strong className="font-semibold">
          {notes === 1
            ? t('1 note is in « {name} ».', { name })
            : t('{count} notes are in « {name} ».', { count: notes, name })}
        </strong>{' '}
        {t('Choose where they go, then it is deleted. They take the stage of their new status.')}
      </p>
      <Radios
        label={t('Move them to')}
        value={chosen}
        onChange={setChosen}
        options={ordered.map((each) => ({
          value: each.key,
          label: `${nameOf(each)} · ${t(STAGE_NAMES[each.stage])}`,
        }))}
      />
      <div className="flex flex-wrap gap-[10px]">
        <Button tone="quiet" autoFocus onClick={onKeep}>
          {t('Keep it')}
        </Button>
        <Button tone="danger" disabled={disabled || target === undefined} onClick={() => target && onMove(target)}>
          {notes === 1 ? t('Move 1 note and delete') : t('Move {count} notes and delete', { count: notes })}
        </Button>
      </div>
    </div>
  );
}
