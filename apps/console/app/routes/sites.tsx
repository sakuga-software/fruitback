import { type FormEvent, Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  type Destination,
  STAGES,
  type Site,
  type Visibility,
  type Workspace,
  type Writers,
  call,
  placesOf,
} from '../api';
import { SITE_NOT_ADDED, SITE_PROBLEMS, problemOf } from '../problems';
import { type Listed, listedOf } from '../listed';
import { Button, Field, LinkButton, Menu, type MenuItem, Pick, Problem, StatusBar } from '../ui';
import { ago } from '../ago';
import { NotePages } from './notes';
import { PageHead, useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { siteAddress, siteName } from '../site-address';
import { SiteIcon } from '../site-icon';
import { useTypedSearch } from '../typed-search';
import { WritersPick } from '../writers-pick';

/** What somebody is typing in the form that adds a site. */
type Draft = { url: string; visibility: Visibility; writers: Writers };

/** A new site: read by its members, and « Members only » (FRU-330), as the worker makes it. */
const EMPTY_DRAFT: Draft = { url: '', visibility: 'members', writers: 'members' };

/** How many cards a page shows: 12 fills rows of 1, 2, 3 or 4 cards. */
const SITES_PER_PAGE = 12;

/**
 * The sites of a workspace, as screen 09 of the mockup of 2026-10-13 draws them (FRU-243): a table,
 * a card when there is none, and an alert when the read failed.
 *
 * The table has the six columns of the mockup (FRU-270): the site, its notes by status, how they
 * came (the script or the extension), where they go, and the last one. The counts are the summary
 * of the sites that the worker keeps from the index of the notes (FRU-237), read with the list:
 * nothing arrives after the rows, so nothing moves under a press.
 */
export default function Sites() {
  useLocale();
  const { workspace } = useWorkspace();
  const [sites, setSites] = useState<Listed<Site>>('loading');
  const [adding, setAdding] = useState(false);
  // What is typed in the form that adds a site is kept here, above every state of the list: the
  // form goes when the list is read again, and what somebody typed must not go with it.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  // The worker says where the notes of a site go to whoever sees the tracker: not to a guest.
  const seesTracker = workspace.role !== 'guest';

  // The search and the page live in the address (FRU-408): a reload keeps the view. The worker
  // answers every site at once, so both are done here, on the list that was read.
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
  const found = typeof sites === 'string' ? [] : matching(sites, q);
  const pages = Math.max(1, Math.ceil(found.length / SITES_PER_PAGE));
  // A page past the last one (a site removed, an address typed) shows the last one.
  const at = Math.min(pages, Math.max(1, Math.trunc(Number(params.get('page'))) || 1));
  const shown = found.slice((at - 1) * SITES_PER_PAGE, at * SITES_PER_PAGE);
  const turn = (to: number) => {
    const next = new URLSearchParams(latest.current);
    if (to <= 1) next.delete('page');
    else next.set('page', String(to));
    latest.current = next;
    setParams(next);
  };

  // A read that failed says so, and is asked again: it never reads as « No site yet » (FRU-162).
  const read = useCallback(async () => {
    setSites('loading');
    const answer = await call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`);
    setSites(listedOf(answer, (data) => data.sites));
  }, [workspace.id]);

  useEffect(() => void read(), [read]);

  // A new site opens its page, at how to put Fruitback on it (FRU-433): the grid unfolds nothing.
  const navigate = useNavigate();
  function added(site: Site) {
    setAdding(false);
    navigate(`/w/${workspace.id}/sites/${site.id}#install`);
  }

  // A site removed on its page comes back here: focus goes to the search, or to the field of the card
  // when the last site went, so a keyboard does not start again from the top of the page.
  const { state } = useLocation();
  const removed = typeof state === 'object' && state !== null && 'removed' in state ? String(state.removed) : '';
  const drawn = typeof sites !== 'string';
  useEffect(() => {
    if (removed === '' || !drawn) return;
    const next =
      document.querySelector<HTMLElement>('main input[type="search"]') ??
      document.querySelector<HTMLElement>('main input');
    next?.focus();
  }, [removed, drawn]);

  const listed = typeof sites !== 'string' && sites.length > 0;

  return (
    <>
      <PageHead
        title={t('Sites')}
        lead={t('Where {workspace} collects notes, and where they stand.', { workspace: workspace.name })}
        {...(listed && manages ? { action: <Button onClick={() => setAdding(true)}>{t('Add a site')}</Button> } : {})}
      />

      {sites === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}

      {/* The mockup sizes the two boxes below by their content: 760 px and 640 px inside the padding. */}
      {sites === 'failed' ? (
        <div
          role="alert"
          className="box-content flex max-w-[760px] flex-wrap items-center justify-between gap-[16px] rounded-frame border border-control px-[32px] py-[28px]"
        >
          <div>
            <h2 className="mb-[4px] text-step leading-auto font-semibold">{t('The sites did not load')}</h2>
            <p className="text-body text-muted">{t('Fruitback did not answer. Your sites and notes are safe.')}</p>
          </div>
          <Button tone="outline" size="page" inset={18} onClick={() => void read()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}

      {typeof sites !== 'string' && sites.length === 0 ? (
        <div className="box-content flex max-w-[640px] flex-col items-start gap-[14px] rounded-frame border border-line bg-subtle px-[clamp(20px,5vw,56px)] py-[48px]">
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
          {adding ? (
            <section
              aria-label={t('Add a site')}
              className="mb-[16px] rounded-frame border border-line bg-subtle px-[22px] py-[20px]"
            >
              <AddSite
                workspace={workspace}
                draft={draft}
                onDraft={setDraft}
                onAdded={added}
                onCancel={() => setAdding(false)}
              />
            </section>
          ) : null}
          <div className="mb-[16px] max-w-[420px]">
            <Field
              label={t('Search sites')}
              labelHidden
              compact
              type="search"
              placeholder={t('Search by address')}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {found.length === 0 ? (
            <p className="text-body text-muted">
              {t('No site matches « {search} ».', { search: q })}{' '}
              <LinkButton space="inline" onClick={() => search('')}>
                {t('Clear the search')}
              </LinkButton>
            </p>
          ) : (
            <ul
              aria-label={t('Sites')}
              className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-[16px]"
            >
              {shown.map((site) => (
                <SiteCard key={site.id} workspace={workspace} site={site} manages={manages} seesTracker={seesTracker} />
              ))}
            </ul>
          )}
          {pages > 1 ? (
            <NotePages
              label={t('Pages of sites')}
              from={(at - 1) * SITES_PER_PAGE + 1}
              shown={shown.length}
              total={found.length}
              first={at === 1}
              last={at === pages}
              onPage={(to) => turn(to === 'next' ? at + 1 : at - 1)}
            />
          ) : null}
          {seesTracker ? (
            <p className="mt-[14px] text-hint text-muted">
              {t('A site with no tracker keeps its notes in Fruitback.')}{' '}
              <LinkButton space="inline" to={`/w/${workspace.id}/connectors`}>
                {t('Connect a tracker')}
              </LinkButton>{' '}
              {t('or')}{' '}
              <LinkButton space="inline" to={`/w/${workspace.id}/notes`}>
                {t('see where every note went')}
              </LinkButton>
            </p>
          ) : null}
        </>
      ) : null}
    </>
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
}: {
  workspace: Workspace;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  onAdded: (site: Site) => void;
  onCancel?: () => void;
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
            value={url}
            onChange={(event) => onDraft({ ...draft, url: event.target.value })}
          />
        </div>
        <Button type="submit">{t('Add site')}</Button>
      </div>
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
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

/** The name of a tracker, and the place in it: « Linear · Design · Website » is « Linear » and the rest. */
function placeOf(destination: Destination): { name: string; detail: string | undefined } {
  const [name, ...rest] = (destination.label ?? '').split(' · ');
  if (name === undefined || name === '') return { name: msg('A tracker'), detail: undefined };

  return { name, detail: rest.length === 0 ? undefined : rest.join(' · ') };
}

/** Where the notes of a site go: its first destination, and how many more a member can choose. */
function GoesTo({ site }: { site: Site }) {
  useLocale();
  const [first, ...others] = site.destinations ?? (site.destination === undefined ? [] : [site.destination]);
  if (first === undefined)
    return (
      <>
        <span className="block">{t('Kept in Fruitback')}</span>
        <span className="block text-hint leading-[inherit] text-muted">{t('No tracker yet')}</span>
      </>
    );
  const place = placeOf(first);
  // The worker writes « Linear · Design »: the place in a Linear is a team, and its project if any.
  const named =
    place.detail !== undefined && place.name === 'Linear' ? t('Team {team}', { team: place.detail }) : place.detail;
  // Notes that an address did not take yet say so where the address was: it is what to look at.
  const late = site.undelivered ?? 0;
  let detail = named;
  if (late === 1) detail = t('1 not delivered yet');
  else if (late > 1) detail = t('{count} not delivered yet', { count: late });

  return (
    <>
      <span className="block [overflow-wrap:anywhere]">{t(place.name)}</span>
      <span className="block text-hint leading-[inherit] text-muted [overflow-wrap:anywhere]">
        {others.length === 0
          ? detail
          : t('{place} and {count} more', { place: detail ?? t(place.name), count: others.length })}
      </span>
    </>
  );
}

type SiteCardProps = {
  workspace: Workspace;
  site: Site;
  manages: boolean;
  seesTracker: boolean;
};

/**
 * The card of a site (FRU-408). Its name and « Settings » lead to the page of the site (FRU-433),
 * where everything else is: the grid unfolds nothing under a card.
 */
function SiteCard({ workspace, site, manages, seesTracker }: SiteCardProps) {
  useLocale();
  const navigate = useNavigate();
  const name = siteName(site.origin);
  const page = `/w/${workspace.id}/sites/${site.id}`;
  // Every role reads the page of a site and installs Fruitback on it. The rest is of who manages them.
  const items: MenuItem[] = [
    { id: 'settings', label: t('Settings') },
    { id: 'install', label: t('Install') },
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
    else if (id === 'settings') navigate(page);
    else navigate(`${page}#${id}`);
  };

  return (
    <li
      data-site={site.id}
      className="flex min-w-0 flex-col gap-[14px] rounded-frame border border-line bg-surface px-[20px] pt-[16px] pb-[14px]"
    >
      <div className="flex items-start gap-[12px]">
        <SiteIcon
          origin={site.origin}
          className="mt-[2px] size-[28px] flex-none rounded-button object-contain"
          letterClassName="grid place-items-center border border-line bg-subtle text-hint font-bold text-ink"
        />
        <div className="min-w-0 flex-1">
          {/* The host is what a person looks for here, so it wraps rather than being cut (FRU-159): after a
                dot first, and inside a name only when one name is wider than the card. */}
          <h2 className="text-[17px] leading-[1.35] font-semibold">
            <Link
              to={page}
              className="rounded-[2px] text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {name.split('.').map((part, index) => (
                <Fragment key={index}>
                  {index === 0 ? null : (
                    <>
                      .<wbr />
                    </>
                  )}
                  {part}
                </Fragment>
              ))}
            </Link>
          </h2>
          {/* Who reads and who writes, on one line (FRU-432). FRU-330: the card says the exception only.
              « Members only » is the default of a new site, and a worker of before, which sends no
              `writers`, says nothing it could be wrong about. */}
          <p className="mt-[2px] text-hint text-muted">
            <span>
              {site.visibility === 'members'
                ? t('Members of {workspace}', { workspace: workspace.name })
                : t('Everyone who visits')}
            </span>
            {site.visibility === 'members' && site.writers === 'anyone' ? (
              <>
                <span aria-hidden="true"> · </span>
                <span className="sr-only">, </span>
                <span>{t('Notes from anyone on the page')}</span>
              </>
            ) : null}
          </p>
        </div>
        <span className="-mt-[4px] -mr-[8px] inline-flex flex-none">
          <Menu trigger="icon" triggerLabel={t('More for {site}', { site: name })} items={items} onAction={go}>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="5" cy="12" r="1.8" fill="currentColor" />
              <circle cx="12" cy="12" r="1.8" fill="currentColor" />
              <circle cx="19" cy="12" r="1.8" fill="currentColor" />
            </svg>
          </Menu>
        </span>
      </div>
      <Counts site={site} />
      {/* The foot of the card (FRU-432): where the notes go at the left, the last one at the right. The
          terms are for a screen reader: the place and the moment say what they are to the eye. How the
          notes came is on the page of the site. */}
      <dl className="mt-auto flex items-start justify-between gap-[12px] border-t border-line pt-[12px] text-hint">
        {seesTracker ? (
          <div className="min-w-0">
            <dt className="sr-only">{t('Notes go to')}</dt>
            <dd>
              <GoesTo site={site} />
            </dd>
          </div>
        ) : null}
        <div className="ml-auto flex-none text-right">
          <dt className="sr-only">{t('Last note')}</dt>
          <dd className="relative text-muted tabular-nums">
            {site.lastNoteAt === undefined ? <None /> : ago(site.lastNoteAt)}
          </dd>
        </div>
      </dl>
      {/* FRU-382: a public repository says so to whoever reads where the notes go, a member too. */}
      {seesTracker
        ? placesOf(site)
            .filter((each) => each.private === false)
            .map((each) => (
              <Problem key={`${each.connector}/${each.teamId}`}>
                {t('{repository} is public: each note of this site becomes an issue that anybody can read.', {
                  repository: each.teamId ?? '',
                })}
              </Problem>
            ))
        : null}
    </li>
  );
}

/** The sites whose name holds the search, in the order of the list: the search is the address typed. */
function matching(sites: readonly Site[], q: string): readonly Site[] {
  const wanted = q.trim().toLowerCase();
  if (wanted === '') return sites;

  return sites.filter((site) => siteName(site.origin).toLowerCase().includes(wanted));
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
 * The notes of a site, the status of the card (FRU-432): how many, large, a bar of their statuses
 * that the words say again, and how many are new, which are the ones to read.
 */
function Counts({ site }: { site: Site }) {
  useLocale();
  const notes = site.notes;
  if (notes === undefined) return <None />;
  const total = STAGES.reduce((sum, stage) => sum + notes[stage], 0);
  if (total === 0) return <span className="text-hint text-muted">{t('Waiting for the first note')}</span>;
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
    <span className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
      <span aria-hidden="true" className="text-[20px] leading-none font-semibold tabular-nums">
        {total}
      </span>
      <StatusBar
        label={label}
        counts={{
          new: notes.new,
          todo: notes.todo,
          progress: notes.progress,
          done: notes.done,
          closed: notes.closed,
        }}
      />
      {notes.new === 0 ? null : (
        <span aria-hidden="true" className="text-hint font-semibold text-accent-strong">
          {notes.new === 1 ? t('1 new') : t('{count} new', { count: notes.new })}
        </span>
      )}
    </span>
  );
}
