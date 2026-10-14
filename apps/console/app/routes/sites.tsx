import { type FormEvent, Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Destination, STAGES, type Site, type Visibility, type Workspace, call } from '../api';
import { Confirmation } from '../confirm';
import { Domains } from '../domains';
import { SITE_NOT_ADDED, SITE_PROBLEMS, problemOf } from '../problems';
import { type Listed, edited, listedOf } from '../listed';
import { Button, DataTable, Field, LinkButton, Menu, type MenuItem, Pick, Problem, StatusBar, StatusDot } from '../ui';
import { ago } from '../ago';
import { STAGE_NAMES, STAGE_STATUS } from './connector-parts';
import { InstallOptions } from './setup';
import { PageHead, useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { siteAddress } from '../site-address';

const REMOVAL_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace removes a site.'),
};
const SITE_NOT_REMOVED = msg('This site is still here. Try again.');

/** What somebody is typing in the form that adds a site. */
type Draft = { url: string; visibility: Visibility };

/** What is open under the row of a site: one thing at a time, on one row at a time. */
type Under = { site: string; what: 'install' | 'previews' | 'remove' };

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
  const [under, setUnder] = useState<Under | undefined>();
  const [adding, setAdding] = useState(false);
  // What is typed in the form that adds a site is kept here, above every state of the list: the
  // form goes when the list is read again, and what somebody typed must not go with it.
  const [draft, setDraft] = useState<Draft>({ url: '', visibility: 'members' });
  const [stuck, setStuck] = useState<{ site: string; problem: string } | undefined>();
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  // The worker says where the notes of a site go to whoever sees the tracker: not to a guest.
  const seesTracker = workspace.role !== 'guest';

  // A read that failed says so, and is asked again: it never reads as « No site yet » (FRU-162).
  const read = useCallback(async () => {
    setSites('loading');
    const answer = await call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`);
    setSites(listedOf(answer, (data) => data.sites));
  }, [workspace.id]);

  useEffect(() => void read(), [read]);

  function added(site: Site) {
    // On a list that was never read, the site alone would hide the others: read them all.
    if (typeof sites === 'string') void read();
    else setSites((current) => edited(current, (items) => [...items.filter((each) => each.id !== site.id), site]));
    setAdding(false);
    // The new site shows how to put Fruitback on it.
    setUnder({ site: site.id, what: 'install' });
  }

  async function remove(site: Site) {
    setStuck(undefined);
    const removed = await call('DELETE', `/console/workspaces/${workspace.id}/sites/${site.id}`);
    // A site that is still there says so on its own row (FRU-164).
    if (!removed.ok)
      return setStuck({ site: site.id, problem: problemOf(removed, REMOVAL_PROBLEMS, SITE_NOT_REMOVED) });
    setUnder(undefined);
    // A list that was not read stays what it is (`edited`).
    setSites((current) => edited(current, (items) => items.filter((each) => each.id !== site.id)));
    setRemoved((count) => count + 1);
  }

  // The row of a site that was removed is gone, and the button that had focus with it. Focus goes to
  // the table, or to the field of the card when the last site went: a keyboard does not start again
  // from the top of the page.
  const [removed, setRemoved] = useState(0);
  useEffect(() => {
    if (removed === 0) return;
    const next =
      document.querySelector<HTMLElement>('main [role="region"][tabindex="0"]') ??
      document.querySelector<HTMLElement>('main input');
    next?.focus();
  }, [removed]);

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

      {/* The six columns need 860 px: on a phone the table scrolls in its frame, and what opens under a
          row stays in what is seen of it. */}
      {listed ? (
        <>
          <Legend />
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
          <DataTable label={t('Sites')} minWidth={860} hover>
            <thead>
              <tr>
                <th scope="col">{t('Site')}</th>
                <th scope="col">{t('Notes')}</th>
                <th scope="col">{t('On the page with')}</th>
                {seesTracker ? <th scope="col">{t('Notes go to')}</th> : null}
                <th scope="col">{t('Last note')}</th>
                {/* The header holds its hidden name: with no anchor, the name widens the page at 390 px. */}
                <th scope="col" data-align="end" className="relative">
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <SiteRows
                  key={site.id}
                  workspace={workspace}
                  site={site}
                  manages={manages}
                  seesTracker={seesTracker}
                  under={under?.site === site.id ? under.what : undefined}
                  onUnder={(what) => {
                    setStuck(undefined);
                    setUnder(what === undefined ? undefined : { site: site.id, what });
                  }}
                  problem={stuck?.site === site.id ? stuck.problem : undefined}
                  onRemove={() => void remove(site)}
                  previews={<Domains workspace={workspace} sites={sites} />}
                />
              ))}
            </tbody>
          </DataTable>
          {seesTracker ? (
            <p className="mt-[14px] text-hint text-muted">
              {t('A site with no tracker keeps its notes in Fruitback.')}{' '}
              <LinkButton space="inline" to={`/w/${workspace.id}/connectors`}>
                {t('Connect a tracker')}
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
  const { url, visibility } = draft;
  const [problem, setProblem] = useState<string | undefined>();

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    // A host with no scheme is read as https. What is not an address is refused here, in the words
    // of the console: a field of type url stopped the form with the bubble of the browser (FRU-167).
    const address = siteAddress(url);
    if (address === undefined) return setProblem(SITE_PROBLEMS['invalid-url'] ?? SITE_NOT_ADDED);
    const added = await call<Site>('POST', `/console/workspaces/${workspace.id}/sites`, { url: address, visibility });
    if (!added.ok) return setProblem(problemOf(added, SITE_PROBLEMS, SITE_NOT_ADDED));
    onDraft({ url: '', visibility: 'members' });
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

type SiteRowsProps = {
  workspace: Workspace;
  site: Site;
  manages: boolean;
  seesTracker: boolean;
  under: Under['what'] | undefined;
  onUnder: (what: Under['what'] | undefined) => void;
  /** Why the site is still here, when its removal failed. */
  problem: string | undefined;
  onRemove: () => void;
  /** The proof of a domain (FRU-103), which covers the preview builds of a site. */
  previews: ReactNode;
};

/** The row of a site, and under it what its menu opened. */
function SiteRows({
  workspace,
  site,
  manages,
  seesTracker,
  under,
  onUnder,
  problem,
  onRemove,
  previews,
}: SiteRowsProps) {
  useLocale();
  const more = useRef<HTMLSpanElement>(null);
  const host = new URL(site.origin).host;
  // Every role puts Fruitback on a site with its own browser. The rest is of who manages the sites.
  const items: MenuItem[] = [
    { id: 'install', label: t('Install') },
    ...(manages
      ? [
          { id: 'previews', label: t('Preview builds') },
          { id: 'remove', label: t('Remove'), danger: true },
        ]
      : []),
  ];
  // What closes gives focus back to the button of the row, so a keyboard finds the row as it was.
  const close = () => {
    onUnder(undefined);
    more.current?.querySelector('button')?.focus();
  };

  return (
    <>
      <tr data-site={site.id}>
        <td>
          {/* The host is what a person looks for here, so it wraps rather than being cut (FRU-159): after a
              dot or a hyphen first, and inside a name only when one name is wider than the column. */}
          <span className="block font-semibold [overflow-wrap:break-word]">
            {host.split('.').map((part, index) => (
              <Fragment key={index}>
                {index === 0 ? null : (
                  <>
                    .<wbr />
                  </>
                )}
                {part}
              </Fragment>
            ))}
          </span>
          <span className="block text-hint leading-[inherit] text-muted">
            {site.visibility === 'members'
              ? t('Members of {workspace}', { workspace: workspace.name })
              : t('Everyone who visits')}
          </span>
        </td>
        {/* The cells that can hold hidden words hold them: with no anchor, they widen the page at 390 px. */}
        <td className="relative">
          <Counts site={site} />
        </td>
        <td className="relative">{site.via === undefined || site.via.length === 0 ? <None /> : viaOf(site.via)}</td>
        {seesTracker ? (
          <td>
            <GoesTo site={site} />
          </td>
        ) : null}
        <td className="relative whitespace-nowrap text-muted tabular-nums">
          {site.lastNoteAt === undefined ? <None /> : ago(site.lastNoteAt)}
        </td>
        <td data-align="end">
          <span ref={more} className="inline-flex">
            <Menu
              trigger="icon"
              triggerLabel={t('More for {site}', { site: host })}
              items={items}
              onAction={(id) => onUnder(id as Under['what'])}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="5" cy="12" r="1.8" fill="currentColor" />
                <circle cx="12" cy="12" r="1.8" fill="currentColor" />
                <circle cx="19" cy="12" r="1.8" fill="currentColor" />
              </svg>
            </Menu>
          </span>
        </td>
      </tr>
      {under === undefined && problem === undefined ? null : (
        <tr className="bg-subtle">
          <td colSpan={seesTracker ? 6 : 5}>
            {/* No width of its own: what is under a row takes the width of the table and never widens
                it. A script is one long line, and without this it pushed the row past the screen. On a
                phone the table scrolls: this stays at the left of what is seen, as wide as the frame. */}
            <div className="sticky left-[20px] flex w-0 min-w-[min(100%,calc(100vw-72px))] flex-col gap-[16px] py-[6px]">
              {under === 'remove' ? (
                <Confirmation
                  confirmLabel={t('Remove {site}', { site: host })}
                  consequence={t(
                    'The widget stops on {site}, and the script pasted there no longer works: adding the site again gives it a new script. The notes already in a tracker stay there.',
                    { site: host },
                  )}
                  onConfirm={onRemove}
                  onKeep={close}
                />
              ) : null}
              {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
              {under === 'install' ? (
                <section aria-label={t('Install on {site}', { site: host })}>
                  <InstallOptions workspace={workspace} site={site} />
                </section>
              ) : null}
              {under === 'previews' ? previews : null}
              {under === 'install' || under === 'previews' ? (
                <div>
                  <LinkButton onClick={close}>{t('Close')}</LinkButton>
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** The five statuses, as the drops of the bars mean them. */
function Legend() {
  useLocale();

  return (
    <ul
      aria-label={t('Statuses')}
      className="mb-[12px] flex flex-wrap gap-x-[18px] gap-y-[6px] text-hint leading-auto text-muted"
    >
      {STAGES.map((stage) => (
        <li key={stage} className="flex items-center gap-[7px]">
          <StatusDot status={STAGE_STATUS[stage]} />
          {t(STAGE_NAMES[stage])}
        </li>
      ))}
    </ul>
  );
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

/** How the notes of a site came: the script pasted on its pages, the extension, or both. */
function viaOf(via: readonly ('script' | 'extension')[]): string {
  if (via.includes('script') && via.includes('extension')) return t('Extension, script');

  return via.includes('extension') ? t('Extension') : t('Script');
}

/** The notes of a site: how many, and a bar of their statuses that the words say again. */
function Counts({ site }: { site: Site }) {
  useLocale();
  const notes = site.notes;
  if (notes === undefined) return <None />;
  const total = STAGES.reduce((sum, stage) => sum + notes[stage], 0);
  if (total === 0) return <span className="text-hint text-muted">{t('Waiting for the first note')}</span>;
  const values = {
    count: total,
    new: notes.seeded,
    todo: notes.green,
    progress: notes.ripening,
    done: notes.ripe,
    closed: notes.composted,
  };
  const label =
    total === 1
      ? t('1 note: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed', values)
      : t('{count} notes: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed', values);

  return (
    <span className="flex items-center gap-[10px]">
      <span aria-hidden="true" className="w-[22px] text-right font-semibold tabular-nums">
        {total}
      </span>
      <StatusBar
        label={label}
        counts={{
          new: notes.seeded,
          todo: notes.green,
          progress: notes.ripening,
          done: notes.ripe,
          closed: notes.composted,
        }}
      />
    </span>
  );
}
