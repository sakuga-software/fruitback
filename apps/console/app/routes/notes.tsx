import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Answer, type Connector, type SiteChoice, STAGES, type Stage, call, siteChoices } from '../api';
import { ago } from '../ago';
import { type Listed, listedOf } from '../listed';
import {
  Button,
  Checkbox,
  Choice,
  DataTable,
  Field,
  FilterChip,
  IconLink,
  LinkButton,
  LoadFailed,
  Mark,
  PageHead,
  Problem,
  StatusDot,
  Tip,
} from '../ui';
import { KINDS, STAGE_NAMES, connectorName } from './connector-parts';
import { ConnectorMark } from '../connector-marks';
import { useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { DID_NOT_ANSWER, writeProblemOf } from '../problems';
import { useTypedSearch } from '../typed-search';
import { useLocale } from '../use-locale';
import { domainOf, siteLabel } from '../site-address';
import { NoteIcon } from '../note-icons';
import { type StatusChoice, offeredFor, statusName, statusProblemOf } from '../note-status';
import { boardColumns } from '../board-columns';
import { NotesBoard } from './notes-board';

/** Who left a note, as the index of the notes says it (FRU-244). A name only for an account of the workspace. */
export type NoteAuthor = {
  kind: 'you' | 'owner' | 'admin' | 'member' | 'guest' | 'former-member' | 'verified' | 'anonymous';
  name?: string;
};

/** Where a note went: Fruitback, a connector (its id and its name), or a connector removed since. */
export type NotePlace = {
  kind: 'fruitback' | 'linear' | 'rest' | 'github' | 'removed';
  connector?: string;
  label?: string;
};

/** A note of the index (FRU-237, FRU-244): its first 64 characters, never its text (Q6). */
export type IndexedNote = {
  id: string;
  excerpt: string;
  page: { url: string; host: string; path: string };
  site: { id: string };
  stage: Stage;
  author: NoteAuthor;
  /**
   * The id the widget gave the note, which its link opens (`#fruitback-note=`, FRU-253). Absent from a
   * worker that does not send it: the link then names the issue, or opens the page alone.
   */
  note?: string;
  /** Where it went, its reference in the tracker and the address of the issue: not for a guest. */
  place?: NotePlace;
  ref?: string;
  url?: string;
  /** A note that an address did not take yet: `gave-up` when the worker stopped trying. */
  delivery?: { id: string; state: 'waiting' | 'gave-up' };
  /**
   * FRU-384: the status of a note the worker keeps (`own:<key>`), and whether this person may change
   * it: its author, or an owner or an admin. Absent for a note of a tracker, whose status is the tracker's.
   */
  status?: string;
  canSetStatus?: boolean;
  createdAt: string;
};

export type NotesAnswer = {
  notes: IndexedNote[];
  total: number;
  /** `byPlace` and `undelivered` go to whoever sees the tracker: not to a guest. */
  counts: {
    all: number;
    byPlace?: Readonly<Record<string, number>>;
    /** The notes of the list by stage, every page (FRU-551): the counts of the groups of the table. */
    byStage?: Readonly<Partial<Record<Stage, number>>>;
    undelivered?: number;
  };
  next?: string;
  /** The statuses of the worker's store of each site with a note it keeps on this page (FRU-384). */
  statuses?: Readonly<Record<string, StatusChoice[]>>;
};

/** The filters of the page, in its address: a reload keeps the view, and a link shares it. */
const FILTERS = ['place', 'site', 'stage', 'mine', 'q'] as const;

/** How the notes are drawn (FRU-436): the table, or the board, as `?view=board` keeps it. */
type View = 'table' | 'board';

/**
 * The groups of the table, in the order the worker reads them by status (FRU-551, as Linear): what
 * is being done, what is to do, what is new, what was closed without being done, then what is done.
 */
export const GROUPS: readonly Stage[] = ['progress', 'todo', 'new', 'closed', 'done'];

/** The notes of a page in their groups, each group in the order of the page. An empty group is not drawn. */
export function groupsOf<T extends { stage: Stage }>(notes: readonly T[]): { stage: Stage; notes: T[] }[] {
  return GROUPS.map((stage) => ({ stage, notes: notes.filter((note) => note.stage === stage) })).filter(
    (group) => group.notes.length > 0,
  );
}

const AUTHOR_WORDS: Readonly<Record<NoteAuthor['kind'], string>> = {
  you: msg('You'),
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
  'former-member': msg('Former member'),
  verified: msg('Verified by {site}'),
  anonymous: msg('Anonymous'),
};

/**
 * Every note left on the sites of a workspace, and where it went: screen 10 of the mockup of
 * 2026-10-13 (FRU-245), read from the index of the notes (FRU-244). The page shows the first 64
 * characters of a note, which is all that Fruitback keeps of its text (Q6); the whole note is read in
 * the tracker, or on the page.
 *
 * **Nothing that a pointer can reach moves when the list is read again**: the rows that are shown stay
 * until the answer replaces them, and the chips and the filters are above them (the rule of FRU-271).
 */
export default function Notes() {
  useLocale();
  const { workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  // The address as the last change wrote it. A render can still carry the address of before a
  // navigation lands: it is taken only when the address of React Router changes.
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  }, [params]);
  const seesTracker = workspace.role !== 'guest';
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const base = `/console/workspaces/${workspace.id}`;

  // The sites name the filter « Site » and the site of a verified author; the connectors name the
  // chips. Both are read once, with the first page.
  // Their id and address only, by address (FRU-497): no count of the notes of every site.
  const [sites, setSites] = useState<Listed<SiteChoice>>('loading');
  const [connectors, setConnectors] = useState<Connector[]>([]);
  useEffect(() => {
    void siteChoices(workspace.id).then((answer) => setSites(listedOf(answer, (data) => data.sites)));
    if (seesTracker)
      void call<{ connectors: Connector[] }>('GET', `${base}/connectors`).then((answer) => {
        if (answer.ok) setConnectors(answer.data.connectors);
      });
  }, [base, seesTracker, workspace.id]);

  const filters = useMemo(
    () =>
      Object.fromEntries(FILTERS.map((name) => [name, params.get(name) ?? ''])) as Record<
        (typeof FILTERS)[number],
        string
      >,
    [params],
  );
  const cursor = params.get('cursor') ?? '';
  const view: View = params.get('view') === 'board' ? 'board' : 'table';
  const from = Math.max(1, Number(params.get('from')) || 1);

  // The answer that is shown, and whether a read is on its way. A read again keeps the rows on the
  // screen until its answer comes: only the first read says « Loading… ».
  const [shown, setShown] = useState<NotesAnswer | 'loading' | 'failed'>('loading');
  const [reading, setReading] = useState(false);
  // The cursors of the pages before this one, for « Previous ». A reload starts it again: « Previous »
  // then goes to the first page.
  const [before, setBefore] = useState<string[]>([]);
  const asked = useRef(0);
  // A select of the board moved a note (FRU-436). If the read after it leaves no note under the
  // filters, the board is gone with the select that had the focus: « Clear the filters » takes it.
  const [movedOut, setMovedOut] = useState(false);

  const read = useCallback(async () => {
    const mine = (asked.current += 1);
    setReading(true);
    const query = new URLSearchParams();
    for (const name of FILTERS) if (filters[name] !== '') query.set(name, filters[name]);
    if (cursor !== '') query.set('cursor', cursor);
    // The table groups the notes by status (FRU-551): the worker reads them in that order, so that a
    // group goes on from one page to the next. The board draws a page by date in its columns.
    if (view === 'table') query.set('order', 'status');
    const answer = await call<NotesAnswer>('GET', `${base}/notes?${query.toString()}`);
    // An answer to a question that is no longer asked is dropped: the filters moved on.
    if (mine !== asked.current) return;
    setReading(false);
    setShown(answer.ok && Array.isArray(answer.data?.notes) ? answer.data : 'failed');
  }, [base, filters, cursor, view]);
  useEffect(() => void read(), [read]);
  // Only the read that follows the move: once it is drawn, a list emptied later takes no focus.
  useEffect(() => {
    if (movedOut && !reading) setMovedOut(false);
  }, [movedOut, reading, shown]);

  /** Sets filters, and goes back to the first page: a page of another list means nothing. */
  function filter(changes: Partial<Record<(typeof FILTERS)[number], string>>, replace = false) {
    setBefore([]);
    setMovedOut(false);
    // From the address as it is when the change lands, not as it was when it was asked: the search
    // writes 300 ms after its key, and a list chosen meanwhile must not be undone by it. The setter of
    // React Router reads the address of the render that made it, so the latest one is kept here.
    const next = new URLSearchParams(latest.current);
    for (const [name, value] of Object.entries(changes)) {
      if (value === '' || value === undefined) next.delete(name);
      else next.set(name, value);
    }
    next.delete('cursor');
    next.delete('from');
    latest.current = next;
    setParams(next, { replace });
  }

  function page(to: 'next' | 'previous', answer: NotesAnswer) {
    const next = new URLSearchParams(params);
    if (to === 'next' && answer.next !== undefined) {
      setBefore((pages) => [...pages, cursor]);
      next.set('cursor', answer.next);
      next.set('from', String(from + answer.notes.length));
    } else {
      const back = before.at(-1) ?? '';
      setBefore((pages) => pages.slice(0, -1));
      if (back === '') next.delete('cursor');
      else next.set('cursor', back);
      const at = from - answer.notes.length;
      if (back === '' || at <= 1) next.delete('from');
      else next.set('from', String(at));
    }
    setParams(next);
  }

  /**
   * Shows the table or the board. The filters stay; the list starts again on its first page, as the
   * table reads by status and the board by date (FRU-551): a cursor of one is no place in the other.
   */
  function show(next: View) {
    const changed = new URLSearchParams(latest.current);
    if (next === 'board') changed.set('view', 'board');
    else changed.delete('view');
    changed.delete('cursor');
    changed.delete('from');
    setBefore([]);
    latest.current = changed;
    setParams(changed);
  }

  const [typed, setTyped] = useTypedSearch(filters.q, (q) => filter({ q }, true));

  const originOf = (id: string) =>
    typeof sites === 'string' ? undefined : sites.find((site) => site.id === id)?.origin;
  const filtered = FILTERS.some((name) => filters[name] !== '');
  const listed = typeof shown === 'object' && (shown.counts.all > 0 || filtered);
  // The site whose statuses make the columns of the board: the one chosen, or the only one there is.
  let siteInView: string | undefined = filters.site === '' ? undefined : filters.site;
  if (siteInView === undefined && typeof sites === 'object' && sites.length === 1) siteInView = sites[0]?.id;
  const choose = (note: IndexedNote, status: string) =>
    call<{ status: string; stage: Stage }>('POST', `${base}/notes/${encodeURIComponent(note.id)}/status`, { status });
  const sourceOf = (note: IndexedNote) => connectors.find((each) => each.id === note.place?.connector);

  return (
    <>
      <PageHead
        title={t('Notes')}
        lead={t('Every note left on the sites of {workspace}, and where it went.', { workspace: workspace.name })}
        className="mb-[24px]"
        {...(listed ? { action: <ViewChoice view={view} onChoose={show} /> } : {})}
      />

      {shown === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}

      {shown === 'failed' ? <NotesFailed onRetry={() => void read()} /> : null}

      {typeof shown === 'object' && shown.counts.all === 0 && !filtered ? (
        <p className="max-w-[640px] text-body text-muted">
          {t('No note yet. Notes show here as soon as someone leaves one on a site of {workspace}.', {
            workspace: workspace.name,
          })}
        </p>
      ) : null}

      {typeof shown === 'object' && (shown.counts.all > 0 || filtered) ? (
        <>
          {seesTracker ? (
            <Places
              counts={shown.counts}
              connectors={connectors}
              chosen={filters.place}
              onChoose={(place) => filter({ place })}
            />
          ) : null}
          <div className="mb-[16px] flex flex-wrap items-center gap-x-[16px] gap-y-[10px]">
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
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <div className="min-w-0 flex-[1_1_170px]">
              <Choice
                label={t('Site')}
                labelHidden
                compact
                value={filters.site === '' ? 'every' : filters.site}
                onChange={(site) => filter({ site: site === 'every' ? '' : site })}
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
                onChange={(stage) => filter({ stage: stage === 'any' ? '' : stage })}
                options={[
                  { value: 'any', label: t('Any status') },
                  ...STAGES.map((stage) => ({ value: stage, label: t(STAGE_NAMES[stage]) })),
                ]}
              />
            </div>
            <Checkbox
              label={t('Only my notes')}
              checked={filters.mine === '1'}
              onChange={(mine) => filter({ mine: mine ? '1' : '' })}
            />
          </div>

          {shown.notes.length === 0 ? (
            <div className="flex flex-wrap items-center gap-x-[12px] text-body text-muted">
              <p>{t('No note matches.')}</p>
              <LinkButton
                autoFocus={movedOut}
                onClick={() => {
                  setTyped('');
                  filter({ place: '', site: '', stage: '', mine: '', q: '' });
                }}
              >
                {t('Clear the filters')}
              </LinkButton>
            </div>
          ) : (
            <>
              {view === 'board' ? (
                <NotesBoard
                  columns={boardColumns(
                    shown.notes,
                    siteInView === undefined ? undefined : shown.statuses?.[siteInView],
                  )}
                  busy={reading}
                  movable={(note) =>
                    note.canSetStatus === true && siteInView !== undefined && shown.statuses?.[siteInView] !== undefined
                  }
                  move={async (note, status) => {
                    const answer = await choose(note, status);
                    if (!answer.ok) return statusProblemOf(answer);
                    await read();

                    return undefined;
                  }}
                  card={(note, moved) => (
                    <NoteCard
                      note={note}
                      source={sourceOf(note)}
                      seesTracker={seesTracker}
                      statuses={shown.statuses?.[note.site.id]}
                      choose={(status) => choose(note, status)}
                      onSaved={() => {
                        moved();
                        setMovedOut(true);
                        void read();
                      }}
                    />
                  )}
                />
              ) : (
                <div aria-busy={reading}>
                  <DataTable label={t('Notes')} minWidth={960} hover stack>
                    <thead>
                      <tr>
                        <th scope="col">{t('Note')}</th>
                        <th scope="col">{t('Site')}</th>
                        <th scope="col">{t('Left by')}</th>
                        {/* The worker tells a guest nothing of where a note went (FRU-244). */}
                        {seesTracker ? <th scope="col">{t('Went to')}</th> : null}
                        <th scope="col" data-align="end">
                          {t('When')}
                        </th>
                        {/* The column of the link to the page (FRU-546): its head is for a screen reader. */}
                        <th scope="col" className="w-[56px]">
                          <span className="sr-only">{t('Page')}</span>
                        </th>
                      </tr>
                    </thead>
                    {/* FRU-551: a group per status, its head the drop, the name and the notes of the
                      whole list in it. A group that goes on to the next page has its head there too. */}
                    {groupsOf(shown.notes).map((group) => (
                      <tbody key={group.stage} data-group={group.stage}>
                        <tr className="kit-table-group">
                          <th scope="colgroup" colSpan={seesTracker ? 6 : 5}>
                            <span className="inline-flex items-center gap-[8px]">
                              <StatusDot status={group.stage} size={10} />
                              {t(STAGE_NAMES[group.stage])}
                              {/* The notes of the whole list in the group. A worker that does not
                                count them gets no number: the notes of one page are no count. */}
                              {shown.counts.byStage?.[group.stage] === undefined ? null : (
                                <span className="font-normal text-muted tabular-nums">
                                  {shown.counts.byStage[group.stage]}
                                </span>
                              )}
                            </span>
                          </th>
                        </tr>
                        {group.notes.map((note) => (
                          <NoteRow
                            key={`${note.id} ${note.status ?? note.stage}`}
                            note={note}
                            origin={originOf(note.site.id)}
                            source={sourceOf(note)}
                            manages={manages}
                            retry={() => call('POST', `${base}/notes/${encodeURIComponent(note.id)}/retry`)}
                            statuses={shown.statuses?.[note.site.id]}
                            choose={(status) => choose(note, status)}
                            onSent={() => void read()}
                          />
                        ))}
                      </tbody>
                    ))}
                  </DataTable>
                </div>
              )}
              <NotePages
                from={from}
                shown={shown.notes.length}
                total={shown.total}
                first={cursor === ''}
                last={shown.next === undefined}
                onPage={(to) => page(to, shown)}
              />
            </>
          )}
        </>
      ) : null}
    </>
  );
}

/**
 * The chips of where the notes went: every note, and each place that has notes. The mockup draws a
 * chip « Not delivered » too: the route of FRU-244 counts those notes and does not filter them, so a
 * chip would choose nothing. Each of them says « Not delivered yet » on its row.
 */
function Places({
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
    if (connector === undefined) return t('A source that was removed');
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

/** What Fruitback keeps of the text of a note: its first 64 characters (Q6, FRU-237). */
const EXCERPT = 64;

/**
 * The excerpt as a person reads it: one that fills its 64 characters was cut, and says so with « … ».
 * One of 64 characters exactly that was the whole note reads « … » too: the index does not say.
 */
export function excerptOf(excerpt: string): string {
  return [...excerpt].length >= EXCERPT ? `${excerpt.trimEnd()}…` : excerpt;
}

/** The host of the address of a REST connector, from its name: « hooks.acme.dev/feedback ». */
function hostOfLabel(label: string | undefined): string | undefined {
  const address = label
    ?.split(' · ')
    .at(-1)
    ?.replace(/^https?:\/\//, '');
  const host = address?.split('/')[0];

  return host === undefined || host === '' ? undefined : host;
}

function NoteRow({
  note,
  origin,
  source,
  manages,
  retry,
  onSent,
  statuses,
  choose,
}: {
  note: IndexedNote;
  /** The origin of the site of the note, when the sites were read. */
  origin: string | undefined;
  /** The connector the note went to, when the connectors were read: it may have a name (FRU-404). */
  source: Connector | undefined;
  manages: boolean;
  retry: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onSent: () => void;
  statuses: readonly StatusChoice[] | undefined;
  choose: (status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
}) {
  useLocale();
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | undefined>();
  // A status the worker did not save (FRU-551): said under the note, the select keeps the choice.
  const [statusRefused, setStatusRefused] = useState<string | undefined>();
  const { author, place } = note;
  // The link of the widget opens the note by the id it gave it, or by its issue (FRU-253).
  const opened = note.note ?? note.ref;
  const show = opened === undefined ? note.page.url : `${note.page.url}#fruitback-note=${encodeURIComponent(opened)}`;
  // FRU-547: the site is its domain and its extension, `fruitback.com` for `app.fruitback.com`.
  const domain = domainOf(origin ?? note.page.host);

  async function send() {
    setSending(true);
    setRefused(undefined);
    const sent = await retry();
    setSending(false);
    if (!sent.ok) return setRefused(writeProblemOf(sent, DID_NOT_ANSWER));
    onSent();
  }

  return (
    <tr>
      {/* The note keeps 240 px of the row: the columns beside it are short words. */}
      <td className="max-w-[380px] min-[640px]:min-w-[240px]">
        {/* FRU-551: the status is its drop before the note, a list of the statuses for whoever may
          change it; the group above says it in words. */}
        <span className="flex items-start gap-[8px]">
          <span className="-my-[4px] flex h-[28px] w-[28px] flex-none items-center justify-center">
            <NoteStatus
              note={note}
              statuses={statuses}
              choose={choose}
              onSaved={onSent}
              onRefused={setStatusRefused}
              bare
            />
          </span>
          <span className="line-clamp-2 [overflow-wrap:anywhere]">{excerptOf(note.excerpt)}</span>
        </span>
        {statusRefused === undefined ? null : (
          <span className="mt-[6px] block pl-[36px]">
            <Problem>{t(statusRefused)}</Problem>
          </span>
        )}
      </td>
      <td className="whitespace-nowrap">
        <span className="block max-w-[140px] truncate">{domain}</span>
      </td>
      <td className="max-w-[160px]">
        <Author author={author} site={domain} />
      </td>
      {place === undefined ? null : (
        <td>
          <Place
            place={place}
            source={source}
            reference={note.ref}
            address={note.url}
            late={note.delivery !== undefined}
          />
          {note.delivery === undefined ? null : (
            <span className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-hint">
              {/* The worker stopped trying (FRU-122): « Send again » still sends it, and the words say why
                it will not arrive by itself. */}
              <span className="font-semibold text-accent">
                {note.delivery.state === 'gave-up'
                  ? t('Not delivered: Fruitback stopped trying')
                  : t('Not delivered yet')}
              </span>
              {manages ? (
                <Button tone="outline" size="small" disabled={sending} onClick={() => void send()}>
                  {t('Send again')}
                </Button>
              ) : null}
            </span>
          )}
          {refused === undefined ? null : <Problem>{t(refused)}</Problem>}
        </td>
      )}
      <td data-align="end" className="whitespace-nowrap text-muted tabular-nums">
        {ago(note.createdAt)}
      </td>
      <td data-align="end">
        {/* FRU-546: the page of the note, in a new tab, its address in the tooltip. */}
        <IconLink label={t('Show on the page')} href={show} tip={note.page.url}>
          <NoteIcon name="open" />
        </IconLink>
      </td>
    </tr>
  );
}

/**
 * Who left a note (FRU-553): the icon of their role, then their name cut to its room. The tooltip,
 * under the pointer and under the focus, says the name whole and the role.
 */
function Author({ author, site }: { author: NoteAuthor; site: string }) {
  useLocale();
  const visitor = author.kind === 'verified' || author.kind === 'anonymous';
  const who = visitor ? t('Visitor') : (author.name ?? t('Somebody of the workspace'));
  const role = author.kind === 'verified' ? t(AUTHOR_WORDS.verified, { site }) : t(AUTHOR_WORDS[author.kind]);

  return (
    <Tip label={`${who}, ${role}`} tip={`${who} · ${role}`}>
      <span className="text-muted">
        <NoteIcon name={author.kind} />
      </span>
      <span className="min-w-0 truncate">{who}</span>
    </Tip>
  );
}

/**
 * The status of a note (FRU-384). A note the worker keeps shows its status by name; to its author, and
 * to an owner or an admin, as a select of the site's statuses. A note of a tracker shows its stage: its
 * status changes in the tracker.
 *
 * The select shows what the person chose at once. Refused, it keeps that choice and says why under
 * it, so that nothing chosen is silently undone; saved, the row takes the stage the worker answered.
 */
function NoteStatus({
  note,
  statuses,
  choose,
  onSaved,
  bare = false,
  onRefused,
}: {
  note: IndexedNote;
  statuses: readonly StatusChoice[] | undefined;
  choose: (status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
  /** Saved: the board reads the notes again, and the card goes to its column (FRU-436). */
  onSaved?: () => void;
  /** The drop alone, its words for a screen reader (FRU-551): the status of a row of the table. */
  bare?: boolean;
  /** Where a refusal is said, for a bare select: under the note, where there is room for it. */
  onRefused?: (refusal: string | undefined) => void;
}) {
  useLocale();
  const [chosen, setChosen] = useState(note.status);
  const [stage, setStage] = useState(note.stage);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | undefined>();
  const stageName = (of: Stage) => t(STAGE_NAMES[of]);
  const current = chosen === undefined ? undefined : statuses?.find((status) => status.key === chosen);

  const refuse = (refusal: string | undefined) => (onRefused === undefined ? setRefused(refusal) : onRefused(refusal));

  async function save(status: string) {
    setChosen(status);
    setSaving(true);
    refuse(undefined);
    const answer = await choose(status);
    setSaving(false);
    if (!answer.ok) return refuse(statusProblemOf(answer));
    setStage(answer.data.stage);
    onSaved?.();
  }

  const words = (text: string) => (bare ? <span className="sr-only">{text}</span> : text);
  // A note of a tracker, or a list read without the statuses of the site: the stage.
  if (chosen === undefined || statuses === undefined || (current === undefined && note.canSetStatus !== true)) {
    return (
      <span className="inline-flex items-center gap-[8px]" data-status-of-note>
        <StatusDot status={stage} size={10} />
        {words(stageName(stage))}
      </span>
    );
  }
  if (note.canSetStatus !== true) {
    return (
      <span className="inline-flex items-center gap-[8px]" data-status-of-note>
        <StatusDot status={current?.stage ?? stage} size={10} color={current?.color} />
        {words(current === undefined ? stageName(stage) : statusName(current, stageName))}
      </span>
    );
  }

  return (
    // A fixed width: a refusal wraps under the select and never widens the column.
    <div className={bare ? '' : 'w-[200px]'}>
      <Choice
        label={t('Status of this note')}
        labelHidden
        compact
        bare={bare}
        disabled={saving}
        status={current?.stage ?? stage}
        value={chosen}
        onChange={(status) => void save(status)}
        options={offeredFor(statuses, chosen).map((status) => ({
          value: status.key,
          label: statusName(status, stageName),
          drop: { status: status.stage, ...(status.color === undefined ? {} : { color: status.color }) },
        }))}
      />
      {refused === undefined ? null : (
        <span className="block whitespace-normal">
          <Problem>{t(refused)}</Problem>
        </span>
      )}
    </div>
  );
}

/** The choice between the table and the board (FRU-436): two buttons, the one on screen pressed. */
function ViewChoice({ view, onChoose }: { view: View; onChoose: (view: View) => void }) {
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

/**
 * A note on the board (FRU-436): what a row of the table says, one under the other. Its status is a
 * select for whoever may change it: the way of the keyboard to another column.
 */
function NoteCard({
  note,
  source,
  seesTracker,
  statuses,
  choose,
  onSaved,
}: {
  note: IndexedNote;
  source: Connector | undefined;
  seesTracker: boolean;
  statuses: readonly StatusChoice[] | undefined;
  choose: (status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
  onSaved: () => void;
}) {
  useLocale();
  const opened = note.note ?? note.ref;
  const show = opened === undefined ? note.page.url : `${note.page.url}#fruitback-note=${encodeURIComponent(opened)}`;
  const visitor = note.author.kind === 'verified' || note.author.kind === 'anonymous';
  const who = visitor ? t('Visitor') : (note.author.name ?? t('Somebody of the workspace'));

  return (
    <div className="flex flex-col gap-[8px]">
      <p className="line-clamp-3 text-body [overflow-wrap:anywhere]">{excerptOf(note.excerpt)}</p>
      <p className="flex flex-wrap gap-x-[12px] gap-y-[2px] text-hint text-muted">
        <span className="[overflow-wrap:anywhere]">{`${note.page.host}${note.page.path}`}</span>
        <LinkButton space="inline" href={show} newTab>
          {t('Show on the page')}
        </LinkButton>
      </p>
      {/* Keyed by the status read: a read again that says another status starts the select from it. */}
      <NoteStatus key={note.status ?? note.stage} note={note} statuses={statuses} choose={choose} onSaved={onSaved} />
      {seesTracker && note.place !== undefined ? (
        <div className="text-hint">
          <Place
            place={note.place}
            source={source}
            reference={note.ref}
            address={note.url}
            late={note.delivery !== undefined}
          />
          {note.delivery === undefined ? null : (
            <span className="font-semibold text-accent">
              {note.delivery.state === 'gave-up'
                ? t('Not delivered: Fruitback stopped trying')
                : t('Not delivered yet')}
            </span>
          )}
        </div>
      ) : null}
      <p className="flex flex-wrap justify-between gap-x-[12px] text-hint text-muted">
        <span className="[overflow-wrap:anywhere]">{who}</span>
        <span className="tabular-nums">{ago(note.createdAt)}</span>
      </p>
    </div>
  );
}

/** Where a note went: the tracker and its reference, an address, Fruitback, or a source that is gone. */
function Place({
  place,
  source,
  reference,
  address,
  late,
}: {
  place: NotePlace;
  /** Its connector, when it is still there: its name is the one its workspace gave it (FRU-404). */
  source: Connector | undefined;
  reference: string | undefined;
  address: string | undefined;
  late: boolean;
}) {
  useLocale();
  if (place.kind === 'removed') return <span className="block font-semibold">{t('A source that was removed')}</span>;
  // FRU-552: the mark of the place, then its reference, on one line. The name of the place is said to
  // a screen reader only, where a reference or an address follows it.
  if (place.kind === 'fruitback') {
    return (
      <span className="flex items-center gap-[6px] whitespace-nowrap">
        <Mark size={14} />
        {t('In Fruitback')}
      </span>
    );
  }
  const name = source === undefined ? t(KINDS[place.kind].name) : connectorName(source);
  // An address that did not take the note yet shows no host beside « Not delivered yet ».
  const host = place.kind === 'rest' && !late ? hostOfLabel(place.label) : undefined;
  let after: ReactNode = null;
  if (reference !== undefined) after = <Reference reference={reference} address={address} />;
  else if (host !== undefined) after = <span className="text-muted">{host}</span>;

  return (
    <span className="flex items-center gap-[6px]" data-place={place.kind}>
      <ConnectorMark kind={place.kind} />
      {after === null ? (
        <span className="font-semibold">{name}</span>
      ) : (
        <>
          <span className="sr-only">{name}</span>
          {after}
        </>
      )}
    </span>
  );
}

/** The reference of a note in a tracker: a link to its issue when the worker knows its address. */
export function Reference({ reference, address }: { reference: string | undefined; address: string | undefined }) {
  if (reference === undefined) return null;
  if (address === undefined) return <span className="block text-hint text-muted">{reference}</span>;

  return (
    // The reference reads at 400, as the mockup draws it: a link of the kit is at 600, for an action.
    <a
      href={address}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-[4px] text-hint text-ink underline decoration-1 underline-offset-[3px] hover:text-accent-strong"
    >
      {reference}
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[12px] w-[12px]">
        <path
          d="M8 16L16 8M9.5 8H16v6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

/** A read of the notes that failed: the alert of the Sites screen, never « No note yet ». */
export function NotesFailed({ onRetry }: { onRetry: () => void }) {
  useLocale();

  return (
    <LoadFailed
      title={t('The notes did not load')}
      detail={t('Fruitback did not answer. Your notes are safe.')}
      retry={t('Try again')}
      onRetry={onRetry}
    />
  );
}

/** Where the page is in the list, and the way to the page before and after it. */
export function NotePages({
  label,
  from,
  shown,
  total,
  first,
  last,
  onPage,
}: {
  /** What the pages are of: « Pages of notes » when none is given. */
  label?: string;
  from: number;
  shown: number;
  total: number;
  first: boolean;
  last: boolean;
  onPage: (to: 'next' | 'previous') => void;
}) {
  useLocale();

  return (
    <nav
      aria-label={label ?? t('Pages of notes')}
      className="mt-[16px] flex flex-wrap items-center justify-between gap-[12px] text-small text-muted"
    >
      <span className="tabular-nums">{t('{from} to {to} of {total}', { from, to: from + shown - 1, total })}</span>
      <span className="flex gap-[8px]">
        <Button tone="outline" inset={14} disabled={first} onClick={() => onPage('previous')}>
          {t('Previous')}
        </Button>
        <Button tone="outline" inset={14} disabled={last} onClick={() => onPage('next')}>
          {t('Next')}
        </Button>
      </span>
    </nav>
  );
}
