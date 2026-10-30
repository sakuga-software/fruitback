import { SiteAgent } from './site-agent';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import {
  type Connector,
  type Destination,
  STAGES,
  type Site,
  type SiteChoice,
  type Visibility,
  type Workspace,
  type Writers,
  call,
  readSite,
  siteChoices,
} from '../api';
import { Confirmation } from '../confirm';
import { Domains } from '../domains';
import { msg, t } from '../i18n';
import { InstallOptions } from '../install-options';
import { type Listed, listedOf } from '../listed';
import { problemOf } from '../problems';
import { siteLabel, siteName } from '../site-address';
import { Button, Disclosure, KeyValue, LinkButton, LoadFailed, Pick, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { WritersPick } from '../writers-pick';
import { SitePlaces } from './site-places';
import { notesOf } from './sites';
import { PageHead, useWorkspace } from './workspace';

const REMOVAL_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace removes a site.'),
};
const SITE_NOT_REMOVED = msg('This site is still here. Try again.');
const ACCESS_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace changes who sees the notes.'),
};
const ACCESS_NOT_CHANGED = msg('Nothing was changed. Try again.');

/** Who sees the notes of a site, and who leaves them. */
type Access = { visibility: Visibility; writers?: Writers };

/** The sections of the page that an address reaches with its hash: `…/sites/<site>#install`. */
export const SITE_SECTIONS = [
  'install',
  'destinations',
  'advanced',
  'statuses',
  'agent',
  'previews',
  'remove',
] as const;

/** The sections folded under « Advanced » (FRU-538): the page shows first what most people come for. */
const ADVANCED: readonly string[] = ['statuses', 'agent', 'previews'];

/**
 * The page of one site (FRU-433, Mathieu): what the grid of the Sites screen unfolded under a card, in
 * one place. Its address and who writes there, how to install Fruitback on it, where its notes go, a
 * link to its statuses, the preview builds, and its removal. The grid draws cards only.
 *
 * « Advanced » folds the statuses, « Start an agent » and the preview builds (FRU-538): the page shows
 * first the notes, the install, and who sees and who writes. A hash of a section inside opens it.
 *
 * The page reads its one site (`GET …/sites/<id>`, FRU-497): the notes of the other sites are not
 * counted for it.
 *
 * `#remove` in the address opens the confirmation: « Remove » in the menu of a card is the first time
 * the removal is asked, and the page asks the second.
 */
export default function SitePage() {
  useLocale();
  const { workspace } = useWorkspace();
  const { site: siteId = '' } = useParams();
  const { hash, key } = useLocation();
  const navigate = useNavigate();
  const base = `/console/workspaces/${workspace.id}`;
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  // The worker says where the notes of a site go to whoever sees the tracker: not to a guest.
  const seesTracker = workspace.role !== 'guest';
  // `gone`: the worker answered 404, a site removed or of another workspace. Not a read that failed.
  const [read, setRead] = useState<Site | 'loading' | 'failed' | 'gone'>('loading');

  const readOne = useCallback(async () => {
    setRead('loading');
    const answer = await readSite(workspace.id, siteId);
    if (!answer.ok) return setRead(answer.status === 404 ? 'gone' : 'failed');
    // An answer that is no site is no site (FRU-162): the page says it did not load.
    setRead(typeof answer.data?.id === 'string' && typeof answer.data.origin === 'string' ? answer.data : 'failed');
  }, [workspace.id, siteId]);
  useEffect(() => void readOne(), [readOne]);

  // The sites to name in « Previews » (FRU-103): their id and address, and no count (FRU-497).
  const [choices, setChoices] = useState<Listed<SiteChoice>>('loading');
  useEffect(() => {
    if (!manages) return;
    void siteChoices(workspace.id).then((answer) => setChoices(listedOf(answer, (data) => data.sites)));
  }, [manages, workspace.id]);

  // The sources of the workspace, for who sets where the notes of the site go (FRU-399).
  const [connectors, setConnectors] = useState<Listed<Connector>>('loading');
  const readConnectors = useCallback(async () => {
    setConnectors('loading');
    const answer = await call<{ connectors: Connector[] }>('GET', `${base}/connectors`);
    setConnectors(listedOf(answer, (data) => data.connectors));
  }, [base]);
  useEffect(() => {
    if (manages && seesTracker) void readConnectors();
  }, [manages, seesTracker, readConnectors]);

  const site = typeof read === 'string' ? undefined : read;
  const gone = read === 'gone';
  const name = site === undefined ? undefined : siteName(site.origin);

  // An address with a hash goes to its section once the site is drawn: the page is empty before.
  const wanted = hash.slice(1);
  const [removing, setRemoving] = useState(wanted === 'remove');
  useEffect(() => {
    if (wanted === 'remove') setRemoving(true);
  }, [wanted, hash]);
  const [advanced, setAdvanced] = useState(ADVANCED.includes(wanted));
  // The section to scroll to, a new object for each navigation: it is set in the render that opens « Advanced ».
  const [target, setTarget] = useState<{ id: string } | undefined>();
  const drawn = site !== undefined;
  // `key` is new on each navigation: a link to the hash already in the address opens « Advanced » again.
  useEffect(() => {
    if (!drawn || wanted === '') return;
    if (ADVANCED.includes(wanted)) setAdvanced(true);
    setTarget({ id: wanted });
  }, [drawn, wanted, key]);
  // A folded section has no box: the page scrolls once « Advanced » is drawn open.
  useEffect(() => {
    if (target !== undefined) document.getElementById(target.id)?.scrollIntoView({ block: 'start' });
  }, [target]);

  /** The places the worker kept, in place of the ones of the list: no read again. */
  function placed(places: Destination[]) {
    setRead((current) =>
      typeof current === 'string'
        ? current
        : {
            ...current,
            destinations: places,
            ...(places[0] === undefined ? { destination: undefined } : { destination: places[0] }),
          },
    );
  }

  /** Who sees the notes and who writes, as the worker answered them: no read again. */
  function changed(answered: Access) {
    setRead((current) =>
      typeof current === 'string'
        ? current
        : {
            ...current,
            visibility: answered.visibility,
            ...(answered.writers === undefined ? {} : { writers: answered.writers }),
          },
    );
  }

  const [problem, setProblem] = useState<string | undefined>();
  const removeButton = useRef<HTMLDivElement>(null);
  async function remove() {
    setProblem(undefined);
    const removed = await call('DELETE', `${base}/sites/${encodeURIComponent(siteId)}`);
    // A site that is still there says so under the button (FRU-164).
    if (!removed.ok) return setProblem(problemOf(removed, REMOVAL_PROBLEMS, SITE_NOT_REMOVED));
    // The grid takes focus on its search: a keyboard does not start again from the top of the page.
    navigate(`/w/${workspace.id}/sites`, { state: { removed: siteId } });
  }
  const keep = () => {
    setRemoving(false);
    if (hash === '#remove') navigate({ hash: '' }, { replace: true });
    // The way back gives focus to the button that asks, which the confirmation replaced.
    requestAnimationFrame(() => removeButton.current?.querySelector('button')?.focus());
  };

  const crumbs = (
    <nav
      aria-label={t('Breadcrumb')}
      className="-mt-[31px] mb-[10px] flex flex-wrap items-center gap-[8px] text-small text-muted"
    >
      <LinkButton space="inline" to={`/w/${workspace.id}/sites`}>
        {t('Sites')}
      </LinkButton>
      {site === undefined ? null : (
        <>
          <span aria-hidden="true">›</span>
          <span aria-current="page" className="min-w-0 [overflow-wrap:anywhere]">
            {name}
          </span>
        </>
      )}
    </nav>
  );

  if (site === undefined)
    return (
      <>
        {crumbs}
        <PageHead title={t('Site')} lead={t('Its address, where its notes go, and how to install Fruitback on it.')} />
        {read === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
        {gone ? <p className="text-body text-muted">{t('This site is not in the workspace any more.')}</p> : null}
        {read === 'failed' ? (
          <LoadFailed
            title={t('The site did not load')}
            detail={t('Fruitback did not answer. Your sites and notes are safe.')}
            retry={t('Try again')}
            onRetry={() => void readOne()}
          />
        ) : null}
      </>
    );

  const host = name ?? '';

  return (
    <>
      {crumbs}
      {/* The title is where the title of every page is (FRU-405): no icon pushes it. */}
      <PageHead
        title={host}
        lead={t('Its address, where its notes go, and how to install Fruitback on it.')}
        action={<NotesLink workspace={workspace.id} site={site} />}
      />

      <div className="flex max-w-[760px] flex-col gap-[40px]">
        <Section id="about" title={t('Site')}>
          <KeyValue
            rows={[
              { term: t('Address'), value: <span className="[overflow-wrap:anywhere]">{siteLabel(site.origin)}</span> },
              {
                term: t('Who sees the notes'),
                value:
                  site.visibility === 'members'
                    ? t('Members of {workspace}', { workspace: workspace.name })
                    : t('Everyone who visits'),
              },
              {
                term: t('Who can leave a note'),
                // A site that everyone reads takes a note from anybody (FRU-330); a worker of before
                // sends no `writers`, and its sites are « Members only ».
                value:
                  site.visibility === 'everyone' || site.writers === 'anyone'
                    ? t('Anyone on the page')
                    : t('Members only'),
              },
              {
                // How its notes came: on the card until FRU-432, which kept the card to what is read first.
                term: t('On the page with'),
                value: site.via === undefined || site.via.length === 0 ? t('None yet') : viaOf(site.via),
              },
            ]}
          />
          {manages ? <AccessForm workspace={workspace} site={site} base={base} onChanged={changed} /> : null}
        </Section>

        <Section id="install" title={t('Install')} label={t('Install on {site}', { site: host })}>
          <InstallOptions workspace={workspace} site={site} />
        </Section>

        {manages && seesTracker ? (
          <div id="destinations" className="scroll-mt-[24px]">
            <SitePlaces
              base={base}
              workspaceId={workspace.id}
              site={site}
              connectors={connectors}
              onRetry={() => void readConnectors()}
              onPlaced={placed}
            />
          </div>
        ) : null}

        {manages ? (
          <Disclosure
            id="advanced"
            title={t('Advanced')}
            hint={t('Statuses, starting an agent, preview deploys')}
            open={advanced}
            onToggle={setAdvanced}
          >
            <Section id="statuses" title={t('Statuses')}>
              <p className="text-small text-muted">
                {t(
                  'The name and the colour of each status, and the stage it belongs to. The stage decides the filters and the counts.',
                )}
              </p>
              <div>
                <Button tone="outline" to={`/w/${workspace.id}/sites/${site.id}/statuses`}>
                  {t('Edit the statuses')}
                </Button>
              </div>
            </Section>
            <SiteAgent
              workspace={workspace}
              site={site}
              connectors={connectors}
              onRetry={() => void readConnectors()}
            />
            <div id="previews" className="scroll-mt-[24px] [&>section]:mt-0">
              <Domains workspace={workspace} sites={choices} />
            </div>
          </Disclosure>
        ) : null}

        {manages ? (
          <Section id="remove" title={t('Remove this site')}>
            {removing ? (
              <Confirmation
                confirmLabel={t('Remove {site}', { site: host })}
                consequence={t(
                  'The widget stops on {site}, and the script pasted there no longer works: adding the site again gives it a new script. The notes that Fruitback keeps for it are deleted. The notes already in a tracker stay there.',
                  { site: host },
                )}
                onConfirm={() => void remove()}
                onKeep={keep}
              />
            ) : (
              <div ref={removeButton} className="flex flex-col items-start gap-[12px]">
                <p className="text-small text-muted">
                  {t('The widget stops on this site, and the notes that Fruitback keeps for it are deleted.')}
                </p>
                <Button tone="outline" onClick={() => setRemoving(true)}>
                  {t('Remove')}
                </Button>
              </div>
            )}
            {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
          </Section>
        ) : null}
      </div>
    </>
  );
}

/**
 * The notes of the site, on the Notes screen with the site chosen (FRU-504): the select of the Notes
 * screen lists every site, and the count is on the card only. No link to a list that is empty.
 */
function NotesLink({ workspace, site }: { workspace: string; site: Site }) {
  useLocale();
  const notes = site.notes;
  // A worker of before sends no count: the link is there, with no number.
  const total = notes === undefined ? undefined : STAGES.reduce((sum, stage) => sum + notes[stage], 0);
  if (total === 0) return null;
  let words = t('See its notes');
  if (total === 1) words = t('See its note');
  else if (total !== undefined) words = t('See its {count} notes', { count: total });

  return (
    <Button tone="outline" to={notesOf(workspace, site.id)}>
      {words}
    </Button>
  );
}

/** How the notes of a site came: the script pasted on its pages, the extension, or both. */
function viaOf(via: readonly ('script' | 'extension')[]): string {
  if (via.includes('script') && via.includes('extension')) return t('Extension, script');

  return via.includes('extension') ? t('Extension') : t('Script');
}

/** A section of the page, reached by its hash, and named by its title or by a longer label. */
function Section({ id, title, label, children }: { id: string; title: string; label?: string; children: ReactNode }) {
  return (
    <section
      id={id}
      {...(label === undefined ? { 'aria-labelledby': `${id}-title` } : { 'aria-label': label })}
      className="flex min-w-0 scroll-mt-[24px] flex-col gap-[12px]"
    >
      <h2 id={`${id}-title`} className="text-section font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Who sees the notes of a site and who leaves them (FRU-504), changed on its page as the popup of the
 * extension changes them (FRU-453).
 *
 * `POST …/sites` with the address of a site that exists changes that site: the same id, the same
 * script, the places it had (`addSite` of the store). So no route of the worker is new, and the
 * answer is checked to be the same site.
 */
function AccessForm({
  workspace,
  site,
  base,
  onChanged,
}: {
  workspace: Workspace;
  site: Site;
  base: string;
  onChanged: (answered: Access) => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>(site.visibility);
  // A site of a worker of before has no `writers`: it takes a note from anybody (FRU-330).
  const [writers, setWriters] = useState<Writers>(site.writers ?? 'anyone');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const change = useRef<HTMLDivElement>(null);
  // The way back gives focus to « Change », which the form replaced.
  const back = () => requestAnimationFrame(() => change.current?.querySelector('button')?.focus());

  function start() {
    setVisibility(site.visibility);
    setWriters(site.writers ?? 'anyone');
    setProblem(undefined);
    setSaved(false);
    setOpen(true);
  }
  function close() {
    setOpen(false);
    back();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    // Nothing changed: nothing is asked of the worker.
    if (visibility === site.visibility && (visibility !== 'members' || writers === (site.writers ?? 'anyone'))) {
      return close();
    }
    setBusy(true);
    const answer = await call<Site>('POST', `${base}/sites`, {
      url: site.origin,
      visibility,
      ...(visibility === 'members' ? { writers } : {}),
    });
    setBusy(false);
    // Another id would be another site: this one was not changed.
    if (!answer.ok || answer.data?.id !== site.id) {
      return setProblem(answer.ok ? ACCESS_NOT_CHANGED : problemOf(answer, ACCESS_PROBLEMS, ACCESS_NOT_CHANGED));
    }
    onChanged({
      visibility: answer.data.visibility,
      ...(answer.data.writers === undefined ? {} : { writers: answer.data.writers }),
    });
    setSaved(true);
    close();
  }

  if (!open)
    return (
      <div ref={change} className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
        <Button
          tone="outline"
          label={t('Change who sees the notes of {site}', { site: siteName(site.origin) })}
          onClick={start}
        >
          {t('Change')}
        </Button>
        {saved ? (
          <p role="status" className="text-small text-muted">
            {t('Saved. The script on the site stays the same.')}
          </p>
        ) : null}
      </div>
    );

  return (
    <form
      noValidate
      aria-label={t('Who sees the notes of {site}', { site: siteName(site.origin) })}
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-[20px]"
    >
      <Pick
        label={t('Who sees the notes?')}
        value={visibility}
        onChange={setVisibility}
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
      <WritersPick visibility={visibility} value={writers} onChange={setWriters} />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div className="flex flex-wrap items-center gap-x-[20px] gap-y-[10px]">
        <Button type="submit" disabled={busy}>
          {t('Save')}
        </Button>
        <LinkButton space="loose" onClick={close}>
          {t('Cancel')}
        </LinkButton>
      </div>
    </form>
  );
}
