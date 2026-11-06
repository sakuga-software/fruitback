import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { type Connector, type Site, call, placesOf, readSite } from '../api';
import { t } from '../i18n';
import { problemOf } from '../problems';
import { siteLabel } from '../site-address';
import { OWN, type StatusRow, type TrackerState, listOf } from '../site-statuses';
import { Button, LinkButton, LoadFailed } from '../ui';
import { useLocale } from '../use-locale';
import { placeLabel } from '../parts/connector-parts';
import { PageHead, useWorkspace } from './workspace';
import { ReadProblem } from '../read-problem';
import { type Fetched } from '../listed';
import { StatusList, TrackerColours } from '../parts/status-list';
import { BUSY, NOT_CHANGED, STATUS_LIST_PROBLEMS, notesOf } from '../parts/status-shown';

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

export default function SiteStatuses() {
  useLocale();
  const { workspace } = useWorkspace();
  const { site: siteId = '' } = useParams();
  const base = `/console/workspaces/${workspace.id}`;
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const [read, setRead] = useState<Fetched<Loaded> | 'gone'>('loading');
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
    if (set === BUSY || !set.ok) return set === BUSY ? NOT_CHANGED : problemOf(set, STATUS_LIST_PROBLEMS, NOT_CHANGED);
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
          detail={
            <>
              <ReadProblem /> {t('Your statuses are safe.')}
            </>
          }
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
