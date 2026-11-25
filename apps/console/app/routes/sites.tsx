import { type FormEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { STAGES, STAGE_NAMES, type Stage } from '../stages';
import { type Destination, type Site, type Visibility, type Workspace, type Writers, call, placesOf } from '../api';
import { SITE_NOT_ADDED, SITE_PROBLEMS, problemOf } from '../problems';
import { type Fetched, listedOf } from '../listed';
import {
  Button,
  CutLink,
  Dialog,
  Field,
  LinkButton,
  LoadFailed,
  Mark,
  Menu,
  type MenuItem,
  Pick,
  Problem,
  StatusBar,
  StatusDot,
  Tip,
} from '../ui';
import { ago, agoShort } from '../ago';
import { NotePages } from '../parts/note-pages';
import { useSlashKey } from '../parts/notes-filters';
import { useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { hostOf, siteAddress, siteName } from '../site-address';
import { SiteIcon } from '../site-icon';
import { SitePreview } from '../site-preview';
import { ConnectorMark, type MarkedKind } from '../connector-marks';
import { NoteIcon } from '../note-icons';
import { SettingsIcon } from '../settings-icons';
import { useTypedSearch } from '../typed-search';
import { WritersPick } from '../writers-pick';
import { ReadProblem } from '../read-problem';

/** What somebody is typing in the form that adds a site. */
type Draft = { url: string; visibility: Visibility; writers: Writers };

/** A new site: read by its members, and « Members only » (FRU-330), as the worker makes it. */
const EMPTY_DRAFT: Draft = { url: '', visibility: 'members', writers: 'members' };

/** One page of the sites, as the worker answers it (FRU-497): its sites, and how many hold the search. */
type Page = { sites: readonly Site[]; total: number };

/** How many rows a page shows (FRU-688): the page of the notes shows 25 too. */
const SITES_PER_PAGE = 25;

/** The head, the bar and the table go from one edge of the screen to the other (FRU-688), as on Notes. */
const BLEED = '-mx-[clamp(16px,4vw,48px)]';

/**
 * The sites of a workspace (FRU-688): a table, one line of 36 px per site, as the mockup of the
 * redesign of 2026-11-25 draws it. A card when there is none, and an alert when the read failed.
 *
 * A row says, from the left: the site, its notes by status, how many are new, where they go, who sees
 * them, and the last one. The counts are the summary of the sites that the worker keeps from the index
 * of the notes (FRU-237), read with the list: nothing arrives after the rows, so nothing moves under a
 * press.
 */
export default function Sites() {
  useLocale();
  const { workspace } = useWorkspace();
  // One page of the table, and how many sites hold the search (FRU-497). `loading` only before the first answer.
  const [read, setRead] = useState<Fetched<Page>>('loading');
  const [adding, setAdding] = useState(false);
  // What is typed in the form that adds a site is kept here, above every state of the list: the
  // form goes when the list is read again, and what somebody typed must not go with it.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  // The worker says where the notes of a site go to whoever sees the tracker: not to a guest.
  const seesTracker = workspace.role !== 'guest';

  // The search and the page live in the address (FRU-408): a reload keeps the view. The worker
  // answers the page and searches (FRU-497): the screen reads one page of sites, and their notes only.
  const [params, setParams] = useSearchParams();
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  }, [params]);
  const q = params.get('q') ?? '';
  /** Writes a search, and goes back to the first page: a page of another list means nothing. */
  const search = (value: string) => {
    const next = new URLSearchParams(latest.current);
    if (value === '') next.delete('q');
    else next.set('q', value);
    next.delete('page');
    latest.current = next;
    setParams(next, { replace: true });
  };
  const [typed, setTyped] = useTypedSearch(q, search);
  const asked = Math.max(1, Math.trunc(Number(params.get('page'))) || 1);
  const total = typeof read === 'string' ? 0 : read.total;
  const pages = Math.max(1, Math.ceil(total / SITES_PER_PAGE));
  const at = Math.min(pages, asked);
  const shown = typeof read === 'string' ? [] : read.sites;
  const turn = (to: number) => {
    const next = new URLSearchParams(latest.current);
    if (to <= 1) next.delete('page');
    else next.set('page', String(to));
    latest.current = next;
    setParams(next);
  };

  // A read that failed says so, and is asked again: it never reads as « No site yet » (FRU-162). A
  // read again keeps the rows on the screen until its answer replaces them, and the answer of a read
  // that is no longer the last one is dropped.
  const asks = useRef(0);
  const load = useCallback(async () => {
    const ask = (asks.current += 1);
    setRead((current) => (current === 'failed' ? 'loading' : current));
    const query = new URLSearchParams({
      limit: String(SITES_PER_PAGE),
      offset: String((asked - 1) * SITES_PER_PAGE),
      ...(q === '' ? {} : { q }),
    });
    const answer = await call<Page>('GET', `/console/workspaces/${workspace.id}/sites?${query}`);
    if (ask !== asks.current) return;
    const sites = listedOf(answer, (data) => data.sites);
    const counted = answer.ok ? answer.data?.total : undefined;
    setRead(sites === 'failed' || typeof counted !== 'number' ? 'failed' : { sites, total: counted });
  }, [workspace.id, q, asked]);

  useEffect(() => void load(), [load]);

  // A page past the last one (a site removed, an address typed) shows the last one, in place of it.
  const past = typeof read !== 'string' && read.total > 0 && read.sites.length === 0 && asked > pages;
  useEffect(() => {
    if (!past) return;
    const next = new URLSearchParams(latest.current);
    if (pages <= 1) next.delete('page');
    else next.set('page', String(pages));
    latest.current = next;
    setParams(next, { replace: true });
  }, [past, pages, setParams]);

  // A new site opens its page, at its tab « Install » (FRU-433, FRU-689): the table unfolds nothing.
  const navigate = useNavigate();
  function added(site: Site) {
    setAdding(false);
    navigate(`/w/${workspace.id}/sites/${site.id}/install`);
  }

  // A site removed on its page comes back here: focus goes to the search, or to the field of the card
  // when the last site went, so a keyboard does not start again from the top of the page.
  const { state } = useLocation();
  const removed = typeof state === 'object' && state !== null && 'removed' in state ? String(state.removed) : '';
  const drawn = typeof read !== 'string';
  useEffect(() => {
    if (removed === '' || !drawn) return;
    const next =
      document.querySelector<HTMLElement>('main input[type="search"]') ??
      document.querySelector<HTMLElement>('main input');
    next?.focus();
  }, [removed, drawn]);

  // The workspace has sites: some hold the search, or a search hides them. No search and none is « No site yet ».
  const listed = typeof read !== 'string' && (read.total > 0 || q !== '');
  // The sites of the page that keep their notes in Fruitback: the band under the table names them.
  const untracked = seesTracker ? shown.filter((site) => placesOf(site).length === 0) : [];

  return (
    <>
      {/* FRU-688: « Sites » and « Add a site » in a head of 48 px, as the head of Notes (FRU-686). */}
      <header
        className={`${BLEED} -mt-[40px] flex min-h-[48px] items-center gap-[12px] border-b border-line pr-[16px] pl-[20px]`}
      >
        <h1 className="text-step font-semibold text-ink">{t('Sites')}</h1>
        {listed && manages ? (
          <div className="ml-auto flex items-center">
            {/* FRU-650: a plus before the words, as the mockup of FRU-688 draws it: 14 px, 6 px from them. */}
            <Button size="panel" inset={10} gap={6} onClick={() => setAdding(true)}>
              <SettingsIcon name="add" size={14} />
              {t('Add a site')}
            </Button>
          </div>
        ) : null}
      </header>

      {read === 'loading' ? <p className="mt-[24px] text-small text-muted">{t('Loading…')}</p> : null}

      {/* The mockup sizes the two boxes below by their content: 760 px and 640 px inside the padding. */}
      {read === 'failed' ? (
        <div className="mt-[24px]">
          <LoadFailed
            title={t('The sites did not load')}
            detail={
              <>
                <ReadProblem /> {t('Your sites and notes are safe.')}
              </>
            }
            retry={t('Try again')}
            onRetry={() => void load()}
          />
        </div>
      ) : null}

      {typeof read !== 'string' && !listed ? (
        <div className="mt-[24px] box-content flex max-w-[640px] flex-col items-start gap-[14px] rounded-card border border-line bg-subtle px-[clamp(20px,5vw,56px)] py-[48px]">
          <svg aria-hidden="true" viewBox="16 6 96 116" className="h-[48px] w-[40px] fill-accent">
            <path
              fillRule="evenodd"
              d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z M 64 37 A 17 17 0 1 0 64 71 A 17 17 0 1 0 64 37 Z"
            />
          </svg>
          <h2 className="text-[20px] leading-[1.3] font-bold">{t('No site yet')}</h2>
          {manages ? (
            <>
              <p className="text-body leading-[1.55] text-muted">
                {t(
                  "Paste the address of a site you review. Staging, a preview build or a client's live site: any page of it will do.",
                )}
              </p>
              <div className="mt-[6px] w-full">
                <AddSite workspace={workspace} draft={draft} onDraft={setDraft} onAdded={added} />
              </div>
            </>
          ) : (
            <p className="text-body leading-[1.55] text-muted">
              {t('An owner or an admin of {workspace} adds its first site.', { workspace: workspace.name })}
            </p>
          )}
        </div>
      ) : null}

      {listed ? (
        <>
          {/* FRU-558: its own dialog, with the site it is about to add. The draft stays above it. */}
          <Dialog
            open={adding}
            onClose={() => setAdding(false)}
            title={t('Add a site')}
            closeLabel={t('Close')}
            className="add-site-dialog"
          >
            <AddSite
              workspace={workspace}
              draft={draft}
              onDraft={setDraft}
              onAdded={added}
              onCancel={() => setAdding(false)}
              preview
            />
          </Dialog>
          <SitesBar typed={typed} onType={setTyped} />
          {total === 0 ? (
            <p className="mt-[24px] text-body text-muted">
              {t('No site matches « {search} ».', { search: q })}{' '}
              <LinkButton space="inline" onClick={() => search('')}>
                {t('Clear the search')}
              </LinkButton>
            </p>
          ) : (
            <SitesTable workspace={workspace} sites={shown} manages={manages} seesTracker={seesTracker} />
          )}
          {untracked.length === 0 ? null : <Untracked workspace={workspace} sites={untracked} />}
          {pages > 1 ? (
            <NotePages
              label={t('Pages of sites')}
              from={(at - 1) * SITES_PER_PAGE + 1}
              shown={shown.length}
              total={total}
              first={at === 1}
              last={at === pages}
              onPage={(to) => turn(to === 'next' ? at + 1 : at - 1)}
              numbers={{ at, count: pages, onGo: turn }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The bar over the table (FRU-688): the search by address, 240 px, which « / » gives the focus to,
 * then the colours of the statuses at the right. 44 px, from one edge of the screen to the other.
 * Under 720 px the colours go: the name of each bar says its counts in words.
 */
function SitesBar({ typed, onType }: { typed: string; onType: (typed: string) => void }) {
  useLocale();
  const field = useRef<HTMLInputElement>(null);
  useSlashKey(field);

  return (
    <div className={`${BLEED} flex min-h-[44px] items-center gap-[8px] border-b border-line pr-[16px] pl-[20px]`}>
      <div className="relative w-[240px] min-w-0 flex-shrink">
        <Field
          label={t('Search sites')}
          labelHidden
          compact
          type="search"
          inputRef={field}
          placeholder={t('Search by address')}
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
      <ul
        aria-label={t('Statuses')}
        className="ml-auto hidden flex-none items-center gap-[14px] text-hint text-muted min-[720px]:flex"
      >
        {STAGES.map((stage) => (
          <li key={stage} className="inline-flex items-center gap-[6px]">
            <StatusDot status={stage} size={10} />
            {t(STAGE_NAMES[stage])}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The columns of the table (FRU-688), by the width of the table (a container query): what a row loses
 * first where the table is narrow. No cell ever goes on a second line: a column that has no room goes.
 * At 390 px a row keeps the site, its new notes and its menu.
 */
const COLUMNS = {
  site: '',
  notes: 'w-[184px] @max-[600px]:w-0',
  open: 'w-[104px]',
  sent: 'w-[220px] @max-[800px]:w-0',
  who: 'w-[184px] @max-[1100px]:w-0',
  last: 'w-[84px] @max-[440px]:w-0',
  menu: 'w-[48px]',
} as const;

/**
 * A cell of a column that has no room: empty, its column 0 px wide. Not `display: none`, which takes a
 * column out of the table: the line of the notices of a site spans every column.
 */
const GONE = {
  site: '',
  notes: '@max-[600px]:[&>*]:hidden',
  open: '',
  sent: '@max-[800px]:[&>*]:hidden',
  who: '@max-[1100px]:[&>*]:hidden',
  last: '@max-[440px]:[&>*]:hidden',
  menu: '',
} as const;

type Column = keyof typeof COLUMNS;

/** A cell of a row: one line of 36 px, its border counted. What is longer is cut with « … ». */
const LINE = 'flex h-[35px] min-w-0 items-center';

/** The border and the box of each cell of a row. */
const CELL = 'border-b border-line/60 p-0 text-left align-top font-normal';

/** The host is in the head of its row, not in a heading of the page: `CutLink` draws it in a `span`. */
const IN_A_CELL = 'span';

/** What a press on a row leaves to the control it lands on: a link, a button, a field or a menu. */
const CONTROLS = 'a, button, input, [role="menu"], [role="menuitem"], [role="dialog"], [role="tooltip"]';

/**
 * The table of the sites (FRU-688): a head of 32 px, and a line of 36 px per site. A press anywhere
 * on a row opens the page of its site; the name of the site is the link a keyboard and a screen
 * reader reach. A row taller than 36 px only says a problem of its site, on a line of its own.
 */
function SitesTable({
  workspace,
  sites,
  manages,
  seesTracker,
}: {
  workspace: Workspace;
  sites: readonly Site[];
  manages: boolean;
  seesTracker: boolean;
}) {
  useLocale();
  const columns: [Column, string][] = [
    ['site', t('Site')],
    ['notes', t('Notes')],
    ['open', t('Open')],
    ...(seesTracker ? [['sent', t('Sent to')] as [Column, string]] : []),
    ['who', t('Who sees the notes')],
    ['last', t('Last note')],
    ['menu', ''],
  ];

  return (
    <div className={`@container ${BLEED}`}>
      <table aria-label={t('Sites')} className="w-full table-fixed border-separate border-spacing-0 text-table">
        <thead>
          <tr>
            {columns.map(([column, words]) => (
              <th
                key={column}
                scope="col"
                // A head of a column that has no room is said to a screen reader only: a head is never empty.
                className={`h-[32px] border-b border-line p-0 text-left text-hint font-medium whitespace-nowrap text-muted ${COLUMNS[column]} ${GONE[column].replace(':hidden', ':sr-only')}`}
              >
                {column === 'menu' ? (
                  <span className="sr-only">{t('Actions')}</span>
                ) : (
                  <span
                    className={`block truncate ${column === 'site' ? 'pl-[20px]' : 'pl-[12px]'} ${column === 'last' ? 'pr-[12px] text-right' : 'pr-[12px]'}`}
                  >
                    {words}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        {sites.map((site) => (
          <SiteRow
            key={site.id}
            workspace={workspace}
            site={site}
            manages={manages}
            seesTracker={seesTracker}
            span={columns.length}
          />
        ))}
      </table>
    </div>
  );
}

type SiteRowProps = {
  workspace: Workspace;
  site: Site;
  manages: boolean;
  seesTracker: boolean;
  /** How many columns the line of the notices spans. */
  span: number;
};

/**
 * The line of a site (FRU-688), in a `tbody` of its own with the line of its notices, when it has some.
 * Its name and « Open its page » lead to the page of the site (FRU-433), where everything else is:
 * the table unfolds nothing under a row. « See the notes » is the Notes screen with this site chosen
 * (FRU-504).
 */
function SiteRow({ workspace, site, manages, seesTracker, span }: SiteRowProps) {
  useLocale();
  const navigate = useNavigate();
  const name = siteName(site.origin);
  const page = `/w/${workspace.id}/sites/${site.id}`;
  // Every role reads the page of a site and installs Fruitback on it. The rest is of who manages them.
  const items: MenuItem[] = [
    { id: 'open', label: t('Open its page') },
    { id: 'notes', label: t('See the notes') },
    ...(manages
      ? [
          { id: 'statuses', label: t('Statuses') },
          // The menu is the first time a removal is asked, and the page asks the second.
          { id: 'remove', label: t('Remove'), danger: true },
        ]
      : []),
  ];
  const go = (id: string) => {
    if (id === 'statuses') navigate(`${page}/statuses`);
    else if (id === 'open') navigate(page);
    else if (id === 'notes') navigate(notesOf(workspace.id, site.id));
    // « Remove » is in the tab « Advanced » (FRU-689), which asks the second time.
    else navigate(`${page}/advanced#${id}`);
  };
  // A press on the row opens the page of the site, as a press on its name does. A press on a control
  // is the control's; a press in a menu or a tooltip comes through the tree of React, not of the page;
  // and a press that ends a selection of text keeps the selection.
  const open = (event: MouseEvent<HTMLTableRowElement>) => {
    const target = event.target;
    if (event.defaultPrevented || !(target instanceof Element)) return;
    if (!event.currentTarget.contains(target) || target.closest(CONTROLS) !== null) return;
    if ((globalThis.getSelection?.()?.toString() ?? '') !== '') return;
    if (event.metaKey || event.ctrlKey) globalThis.open(page, '_blank', 'noopener');
    else navigate(page);
  };
  const notices = seesTracker ? noticesOf(site) : [];

  return (
    <tbody data-site={site.id}>
      <tr onClick={open} className="cursor-pointer hover:bg-hover">
        <th scope="row" data-column="site" className={`${CELL} ${GONE.site}`}>
          <span className={`${LINE} gap-[10px] pr-[12px] pl-[20px]`}>
            <SiteIcon
              origin={site.origin}
              className="size-[20px] flex-none rounded-inner object-contain"
              letterClassName="grid place-items-center bg-avatar text-tiny leading-none font-bold text-page"
            />
            {/* FRU-585: the host is on one line, cut with « … », and whole in a tooltip when it is cut. */}
            <span className="min-w-0 shrink">
              <CutLink
                to={page}
                heading={IN_A_CELL}
                className="block font-semibold"
                linkClassName="rounded-inner text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {name}
              </CutLink>
            </span>
            {/* The site itself, in a new tab. */}
            <a
              href={site.origin}
              target="_blank"
              rel="noreferrer"
              aria-label={t('Open {site} in a new tab', { site: name })}
              className="inline-flex size-control-sm flex-none items-center justify-center rounded-control text-muted hover:bg-chip hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&_svg]:size-[14px]"
            >
              <NoteIcon name="open" />
            </a>
          </span>
        </th>
        <td data-column="notes" className={`${CELL} ${GONE.notes}`}>
          <span className={`${LINE} gap-[8px] px-[12px]`}>
            <Counts site={site} />
          </span>
        </td>
        <td data-column="open" className={`${CELL} ${GONE.open}`}>
          <span className={`${LINE} px-[12px]`}>
            <Fresh site={site} name={name} to={notesOf(workspace.id, site.id, 'new')} />
          </span>
        </td>
        {seesTracker ? (
          <td data-column="sent" className={`${CELL} ${GONE.sent}`}>
            <span className={`${LINE} gap-[6px] px-[12px] text-ink-soft`}>
              <SentTo site={site} name={name} notes={notesOf(workspace.id, site.id)} />
            </span>
          </td>
        ) : null}
        <td data-column="who" className={`${CELL} ${GONE.who}`}>
          <span className={`${LINE} gap-[6px] px-[12px] text-ink-soft`}>
            <Who site={site} />
          </span>
        </td>
        <td data-column="last" className={`${CELL} ${GONE.last}`}>
          <span className={`${LINE} justify-end px-[12px] text-muted tabular-nums`}>
            {site.lastNoteAt === undefined ? (
              <None />
            ) : (
              <>
                <span aria-hidden="true" title={ago(site.lastNoteAt)}>
                  {agoShort(site.lastNoteAt)}
                </span>
                <span className="sr-only">{ago(site.lastNoteAt)}</span>
              </>
            )}
          </span>
        </td>
        <td data-column="menu" className={`${CELL} ${GONE.menu}`}>
          <span className={`${LINE} justify-end pr-[12px]`}>
            <Menu trigger="icon" triggerLabel={t('More for {site}', { site: name })} items={items} onAction={go}>
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="5" cy="12" r="1.8" fill="currentColor" />
                <circle cx="12" cy="12" r="1.8" fill="currentColor" />
                <circle cx="19" cy="12" r="1.8" fill="currentColor" />
              </svg>
            </Menu>
          </span>
        </td>
      </tr>
      {notices.length === 0 ? null : (
        <tr data-notices="">
          <td colSpan={span} className={CELL}>
            <span className="flex flex-col gap-[6px] pt-[8px] pr-[16px] pb-[10px] pl-[50px]">{notices}</span>
          </td>
        </tr>
      )}
    </tbody>
  );
}

/**
 * What a site says on a line of its own, under its row, to whoever sees where its notes go: a public
 * repository (FRU-382), and a place that the tracker refuses (FRU-640).
 */
function noticesOf(site: Site): ReactNode[] {
  const places = placesOf(site);
  const notices: ReactNode[] = places
    .filter((each) => each.private === false)
    .map((each) => (
      <Problem key={`${each.connector}/${each.teamId}`}>
        {t('{repository} is public: each note of this site becomes an issue that anybody can read.', {
          repository: each.teamId ?? '',
        })}
      </Problem>
    ));
  // FRU-640: a place that the tracker refuses keeps every note of the site from leaving.
  if (places.some((each) => each.attention !== undefined))
    notices.push(
      <Problem key="attention">
        {t('The tracker refuses a place of this site, and its notes do not leave. Open the site to change it.')}
      </Problem>,
    );

  return notices;
}

/**
 * The band under the table (FRU-688): the sites of the page that keep their notes in Fruitback, and
 * the way to connect a tracker, the dialog « Add a connector » of the Connectors screen (FRU-571).
 */
function Untracked({ workspace, sites }: { workspace: Workspace; sites: readonly Site[] }) {
  useLocale();
  const [only] = sites;

  return (
    <p
      // 20 px from each edge of the screen, as the head and the bar: the column of the screen is wider.
      className="mx-[calc(20px_-_clamp(16px,4vw,48px))] mt-[16px] flex flex-wrap items-center gap-x-[8px] gap-y-[4px] rounded-control border border-dashed border-line px-[12px] py-[10px] text-body text-muted"
    >
      <Mark size={14} />
      <span>
        {sites.length === 1 && only !== undefined
          ? t('{site} keeps its notes in Fruitback.', { site: siteName(only.origin) })
          : t('{count} sites keep their notes in Fruitback.', { count: sites.length })}
      </span>
      <Link
        to={`/w/${workspace.id}/connectors?new=1`}
        className="rounded-inner font-medium text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {t('Connect a tracker')}
      </Link>
    </p>
  );
}

/**
 * The form that adds a site: its address, and who sees its notes. The card of « No site yet » and
 * the button « Add a site » show the same one.
 *
 * WARNING: no failure clears the field. The sentence says the cause, and the address is often right
 * (FRU-164).
 */
function AddSite({
  workspace,
  draft,
  onDraft,
  onAdded,
  onCancel,
  preview = false,
}: {
  workspace: Workspace;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  onAdded: (site: Site) => void;
  onCancel?: () => void;
  /** The icon and the page of the typed address, under its field (FRU-558). */
  preview?: boolean;
}) {
  useLocale();
  const { url, visibility, writers } = draft;
  const [problem, setProblem] = useState<string | undefined>();

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    // A host with no scheme is read as https. What is not an address is refused here, in the words
    // of the console: a field of type url stopped the form with the bubble of the browser (FRU-167).
    const address = siteAddress(url);
    if (address === undefined) return setProblem(SITE_PROBLEMS['invalid-url'] ?? SITE_NOT_ADDED);
    // `writers` is sent for a site that its members read only: it decides nothing on the other one.
    const added = await call<Site>('POST', `/console/workspaces/${workspace.id}/sites`, {
      url: address,
      visibility,
      ...(visibility === 'members' ? { writers } : {}),
    });
    if (!added.ok) return setProblem(problemOf(added, SITE_PROBLEMS, SITE_NOT_ADDED));
    onDraft(EMPTY_DRAFT);
    onAdded(added.data);
  }

  return (
    <form onSubmit={add} className="flex w-full flex-col gap-[16px]">
      <div className="flex flex-wrap items-end gap-[10px]">
        <div className="min-w-0 flex-[1_1_260px]">
          <Field
            label={t('Site address')}
            inputMode="url"
            autoComplete="url"
            placeholder="staging.acme.dev"
            // In the dialog, the field takes focus when it opens: the dialog is for this field.
            autoFocus={preview}
            value={url}
            onChange={(event) => onDraft({ ...draft, url: event.target.value })}
          />
        </div>
        <Button type="submit">{t('Add site')}</Button>
      </div>
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      {preview ? <TypedSite url={url} /> : null}
      <Pick
        label={t('Who sees the notes?')}
        value={visibility}
        onChange={(chosen) => onDraft({ ...draft, visibility: chosen })}
        options={[
          {
            value: 'members',
            label: t('Members of {workspace}', { workspace: workspace.name }),
            detail: t("Visitors of the site see nothing. Right for staging and for a client's site."),
          },
          {
            value: 'everyone',
            label: t('Everyone who visits'),
            detail: t('A public way to report a problem on a live site.'),
          },
        ]}
      />
      <WritersPick
        visibility={visibility}
        value={writers}
        onChange={(chosen) => onDraft({ ...draft, writers: chosen })}
      />
      {onCancel === undefined ? null : (
        <div>
          <LinkButton onClick={onCancel}>{t('Cancel')}</LinkButton>
        </div>
      )}
    </form>
  );
}

/** How long the preview waits after the last key: a half-typed host is never asked. */
const PREVIEW_PAUSE_MS = 600;

/**
 * The site that the form is about to add (FRU-558): its icon and domain, then its page in a frame,
 * once the typed address is an address and nobody typed for a moment.
 *
 * The browser of the person asks the site, as the preview of the setup does (`site-preview.tsx`):
 * `img-src https:` and `frame-src https: http:` of the console already allow it, no referrer goes,
 * and the frame is sandboxed. The worker asks the site for nothing, so it fetches no address
 * somebody typed.
 */
function TypedSite({ url }: { url: string }) {
  useLocale();
  const [origin, setOrigin] = useState<string | undefined>(undefined);
  useEffect(() => {
    const address = siteAddress(url);
    const timer = setTimeout(
      () => setOrigin(address === undefined ? undefined : new URL(address).origin),
      PREVIEW_PAUSE_MS,
    );

    return () => clearTimeout(timer);
  }, [url]);
  // An address that is no longer one hides the preview at once: only a valid one waits (raised in review).
  if (origin === undefined || siteAddress(url) === undefined) return null;
  const host = hostOf(origin);

  return (
    <section aria-label={t('Preview of {site}', { site: host })} className="flex flex-col gap-[10px]">
      <p className="flex items-center gap-[10px] text-body font-semibold">
        <SiteIcon
          key={origin}
          origin={origin}
          className="add-site-dialog__icon size-[24px] flex-none rounded-inner object-contain"
          letterClassName="add-site-dialog__letter grid place-items-center border border-line bg-surface text-ink text-[13px] font-bold"
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">{host}</span>
      </p>
      <SitePreview key={origin} origin={origin} short />
    </section>
  );
}
/** The name of a tracker, and the place in it: « Linear · Design · Website » is « Linear » and the rest. */
function placeOf(destination: Destination): { name: string; detail: string | undefined } {
  const [name, ...rest] = (destination.label ?? '').split(' · ');
  if (name === undefined || name === '') return { name: msg('A tracker'), detail: undefined };

  return { name, detail: rest.length === 0 ? undefined : rest.join(' · ') };
}

/**
 * The kind of a tracker by the first word of the label of a destination, as the worker writes it
 * (`KIND_NAMES` of `console-api.ts`): « Linear · Design », « GitHub · acme/web », « REST API · host ».
 * A word that this build does not know has no mark, and its name alone.
 */
const KIND_OF_NAME: Readonly<Record<string, MarkedKind>> = { Linear: 'linear', GitHub: 'github', 'REST API': 'rest' };

/**
 * Where the notes of a site go (FRU-688), on one line: the logo of each tracker (FRU-541), then the
 * places, « Team Acme web » for one place of a Linear, « Acme web, Support » for several. A site with
 * no tracker keeps them in Fruitback. The labels of the worker are whole in a tooltip.
 *
 * Notes that an address did not take yet (REST, FRU-122) add the icon of a retry in red after the
 * places: it leads to the notes of the site, where each one is sent again.
 */
function SentTo({ site, name, notes }: { site: Site; name: string; notes: string }) {
  useLocale();
  const places = placesOf(site);
  if (places.length === 0)
    return (
      <>
        <Mark size={14} />
        <span className="truncate">{t('Kept in Fruitback')}</span>
      </>
    );
  const named = places.map(placeOf);
  // Only a name of the table: « constructor » is not a kind, it is a key of every object.
  const kindOf = (place: { name: string }) =>
    Object.hasOwn(KIND_OF_NAME, place.name) ? KIND_OF_NAME[place.name] : undefined;
  const kinds = [...new Set(named.map(kindOf))];
  // A place whose tracker has a mark says its place; one with no mark says its tracker too.
  const wordsOf = (place: { name: string; detail: string | undefined }) => {
    if (place.detail === undefined) return t(place.name);

    return kindOf(place) === undefined ? `${t(place.name)} · ${place.detail}` : place.detail;
  };
  const [first] = named;
  const one = named.length === 1 && first !== undefined ? first : undefined;
  // The worker writes « Linear · Design »: the place in a Linear is a team, and its project if any.
  const words =
    one !== undefined && one.name === 'Linear' && one.detail !== undefined
      ? t('Team {team}', { team: one.detail })
      : named.map(wordsOf).join(', ');
  // FRU-574: the page of the team at Linear, when the place says the team and the worker gave its
  // page. Only an address of Linear: a link of the console never goes anywhere else.
  const [place] = places;
  const linear =
    one !== undefined && kindOf(one) === 'linear' && place?.url?.startsWith('https://linear.app/') === true
      ? place.url
      : undefined;
  const late = site.undelivered ?? 0;
  const lateWords = late === 1 ? t('1 not delivered yet') : t('{count} not delivered yet', { count: late });

  return (
    <>
      {kinds.map((kind) => (kind === undefined ? null : <ConnectorMark key={kind} kind={kind} />))}
      {/* FRU-567: a long place is cut to one line, and whole in a tooltip and to a screen reader. */}
      <Tip tip={places.map((each) => each.label ?? msg('A tracker')).join(', ')} className="min-w-0">
        {linear === undefined ? (
          <span className="min-w-0 truncate">{words}</span>
        ) : (
          <a
            href={linear}
            target="_blank"
            rel="noreferrer"
            aria-label={t('{place}, at Linear, in a new tab', { place: words })}
            className="min-w-0 truncate rounded-inner text-ink-soft underline decoration-1 underline-offset-[3px] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {words}
          </a>
        )}
      </Tip>
      {late === 0 ? null : (
        <Link
          to={notes}
          aria-label={
            late === 1
              ? t('1 not delivered yet: see the notes of {site}', { site: name })
              : t('{count} not delivered yet: see the notes of {site}', { count: late, site: name })
          }
          title={lateWords}
          className="inline-flex size-control-sm flex-none items-center justify-center rounded-control text-accent-strong hover:bg-chip focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&_svg]:size-[14px]"
        >
          <NoteIcon name="retry" />
        </Link>
      )}
    </>
  );
}

/**
 * Who reads the notes of a site (FRU-688): an icon and « Members only » or « Everyone who visits »,
 * with no name of a workspace (FRU-583). Where anyone on the page writes a note on a site that its
 * members read (FRU-330), a pencil follows, its words in a tooltip and to a screen reader.
 */
function Who({ site }: { site: Site }) {
  useLocale();
  const members = site.visibility === 'members';

  return (
    <>
      <AccessIcon icon={members ? 'members' : 'everyone'} />
      <span className="min-w-0 truncate">{members ? t('Members only') : t('Everyone who visits')}</span>
      {members && site.writers === 'anyone' ? (
        <Tip tip={t('Notes from anyone on the page')} className="flex-none text-muted">
          <span className="sr-only">, </span>
          <AccessIcon icon="anyone" />
          <span className="sr-only">{t('Notes from anyone on the page')}</span>
        </Tip>
      ) : null}
      {/* FRU-703: « Read only », the other exception: everyone reads, and only members write. */}
      {!members && site.writers === 'members' ? (
        <Tip tip={t('Notes from members only')} className="flex-none text-muted">
          <span className="sr-only">, </span>
          <AccessIcon icon="members" />
          <span className="sr-only">{t('Notes from members only')}</span>
        </Tip>
      ) : null}
    </>
  );
}

/** The icons of who reads and who writes, drawn as the icons of the rail: a grid of 24, a stroke of 2. */
const ACCESS_PATHS = {
  // Two people: the members of the workspace read the notes.
  members:
    'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 3.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M22 20v-1.5a4 4 0 0 0-3-3.9M16 3.6a3.5 3.5 0 0 1 0 6.8',
  // A globe: everyone who visits the site.
  everyone: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c-3 3.2-3 14.8 0 18M12 3c3 3.2 3 14.8 0 18',
  // A pencil: anyone on the page writes a note.
  anyone: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
} as const;

function AccessIcon({ icon }: { icon: keyof typeof ACCESS_PATHS }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" data-access={icon} className="size-[14px] flex-none">
      <path
        d={ACCESS_PATHS[icon]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The Notes screen with one site chosen in its filter « Site », and a status in « Status » when one is given. */
export function notesOf(workspace: string, site: string, stage?: Stage): string {
  return `/w/${workspace}/notes?${new URLSearchParams({ site, ...(stage === undefined ? {} : { stage }) }).toString()}`;
}

/** A cell with nothing to say yet: a dot for the eye, and words for a screen reader. */
function None() {
  useLocale();

  return (
    <>
      <span aria-hidden="true">·</span>
      <span className="sr-only">{t('None yet')}</span>
    </>
  );
}

/**
 * The notes of a site (FRU-688): a bar of their statuses, whose name says the counts in words, and how
 * many. « Waiting for the first note » before the first one.
 */
function Counts({ site }: { site: Site }) {
  useLocale();
  const notes = site.notes;
  if (notes === undefined) return <None />;
  const total = STAGES.reduce((sum, stage) => sum + notes[stage], 0);
  if (total === 0) return <span className="truncate text-muted">{t('Waiting for the first note')}</span>;
  const values = {
    count: total,
    new: notes.new,
    todo: notes.todo,
    progress: notes.progress,
    done: notes.done,
    closed: notes.closed,
  };
  const label =
    total === 1
      ? t('1 note: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed', values)
      : t('{count} notes: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed', values);

  return (
    <>
      <StatusBar label={label} counts={notes} />
      <span aria-hidden="true" className="text-ink-soft tabular-nums">
        {total}
      </span>
    </>
  );
}

/**
 * The new notes of a site, which are the ones to read (FRU-570): « 3 new » in red after a dot, a link
 * to the Notes screen with this site and « New » chosen. None: a dot for the eye.
 */
function Fresh({ site, name, to }: { site: Site; name: string; to: string }) {
  useLocale();
  const fresh = site.notes?.new ?? 0;
  if (fresh === 0) return <None />;

  return (
    <Link
      to={to}
      aria-label={
        fresh === 1
          ? t('See the new note of {site}', { site: name })
          : t('See the {count} new notes of {site}', { count: fresh, site: name })
      }
      className="inline-flex min-w-0 items-center gap-[6px] rounded-inner font-medium text-accent-strong underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span aria-hidden="true" className="size-[6px] flex-none rounded-pill bg-accent" />
      <span className="truncate">{fresh === 1 ? t('1 new') : t('{count} new', { count: fresh })}</span>
    </Link>
  );
}
