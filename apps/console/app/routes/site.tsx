import { SiteAgent } from './site-agent';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { type Connector, type Destination, type Site, call } from '../api';
import { Confirmation } from '../confirm';
import { Domains } from '../domains';
import { msg, t } from '../i18n';
import { InstallOptions } from '../install-options';
import { type Listed, edited, listedOf } from '../listed';
import { problemOf } from '../problems';
import { siteLabel, siteName } from '../site-address';
import { Button, KeyValue, LinkButton, LoadFailed, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { SitePlaces } from './site-places';
import { PageHead, useWorkspace } from './workspace';

const REMOVAL_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace removes a site.'),
};
const SITE_NOT_REMOVED = msg('This site is still here. Try again.');

/** The sections of the page that an address reaches with its hash: `…/sites/<site>#install`. */
export const SITE_SECTIONS = ['install', 'destinations', 'statuses', 'previews', 'remove'] as const;

/**
 * The page of one site (FRU-433, Mathieu): what the grid of the Sites screen unfolded under a card, in
 * one place. Its address and who writes there, how to install Fruitback on it, where its notes go, a
 * link to its statuses, the preview builds, and its removal. The grid draws cards only.
 *
 * The page reads the list of the sites, as the page of the statuses does: the worker has no route for
 * one site, and no route of the worker is new.
 *
 * `#remove` in the address opens the confirmation: « Remove » in the menu of a card is the first time
 * the removal is asked, and the page asks the second.
 */
export default function SitePage() {
  useLocale();
  const { workspace } = useWorkspace();
  const { site: siteId = '' } = useParams();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const base = `/console/workspaces/${workspace.id}`;
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  // The worker says where the notes of a site go to whoever sees the tracker: not to a guest.
  const seesTracker = workspace.role !== 'guest';
  const [sites, setSites] = useState<Listed<Site>>('loading');

  const read = useCallback(async () => {
    setSites('loading');
    const answer = await call<{ sites: Site[] }>('GET', `${base}/sites`);
    setSites(listedOf(answer, (data) => data.sites));
  }, [base]);
  useEffect(() => void read(), [read]);

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

  const site = typeof sites === 'string' ? undefined : sites.find((each) => each.id === siteId);
  const gone = typeof sites !== 'string' && site === undefined;
  const name = site === undefined ? undefined : siteName(site.origin);

  // An address with a hash goes to its section once the site is drawn: the page is empty before.
  const wanted = hash.slice(1);
  const [removing, setRemoving] = useState(wanted === 'remove');
  useEffect(() => {
    if (wanted === 'remove') setRemoving(true);
  }, [wanted, hash]);
  const drawn = site !== undefined;
  useEffect(() => {
    if (!drawn || wanted === '') return;
    document.getElementById(wanted)?.scrollIntoView({ block: 'start' });
  }, [drawn, wanted]);

  /** The places the worker kept, in place of the ones of the list: no read again. */
  function placed(places: Destination[]) {
    setSites((current) =>
      edited(current, (items) =>
        items.map((each) =>
          each.id === siteId
            ? {
                ...each,
                destinations: places,
                ...(places[0] === undefined ? { destination: undefined } : { destination: places[0] }),
              }
            : each,
        ),
      ),
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
        {sites === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
        {gone ? <p className="text-body text-muted">{t('This site is not in the workspace any more.')}</p> : null}
        {sites === 'failed' ? (
          <LoadFailed
            title={t('The site did not load')}
            detail={t('Fruitback did not answer. Your sites and notes are safe.')}
            retry={t('Try again')}
            onRetry={() => void read()}
          />
        ) : null}
      </>
    );

  const host = name ?? '';

  return (
    <>
      {crumbs}
      {/* The title is where the title of every page is (FRU-405): no icon pushes it. */}
      <PageHead title={host} lead={t('Its address, where its notes go, and how to install Fruitback on it.')} />

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
          {/* The worker has no route that changes them: a control that does nothing is not drawn. */}
          <p className="text-hint text-muted">
            {t('Who sees the notes and who leaves them are set when the site is added.')}
          </p>
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
        ) : null}

        {manages ? (
          <SiteAgent workspace={workspace} site={site} connectors={connectors} onRetry={() => void readConnectors()} />
        ) : null}

        {manages ? (
          <div id="previews" className="scroll-mt-[24px] [&>section]:mt-0">
            <Domains workspace={workspace} sites={sites} />
          </div>
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
