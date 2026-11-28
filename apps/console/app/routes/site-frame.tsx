import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useOutletContext, useParams } from 'react-router';
import { type Site, readSite, workspaceAddress } from '../api';
import { t } from '../i18n';
import { type Fetched } from '../listed';
import { ReadProblem } from '../read-problem';
import { siteLabel, siteName } from '../site-address';
import { STAGES } from '../stages';
import { Button, LoadFailed } from '../ui';
import { useLocale } from '../use-locale';
import { SiteIcon } from '../parts/site-icons';
import { type SiteTab, SiteTabs } from '../parts/site-tabs';
import { notesOf } from './sites';
import { useWorkspace } from './workspace';

/** From one edge of the screen to the other: the padding of the screen, taken back. */
const BLEED = '-mx-[clamp(16px,4vw,48px)]';

type SiteContext = ReturnType<typeof useWorkspace> & {
  site: Site;
  /** The site as the worker kept it after a write: every tab shows it at once, with no read again. */
  setSite: (change: (site: Site) => Site) => void;
  /** An owner or an admin of the workspace: they set the site. */
  manages: boolean;
  /** The worker says where the notes of a site go to whoever sees the tracker: not to a guest. */
  seesTracker: boolean;
};

/** The site of the page, for a tab: the context of the frame holds the one of the workspace too. */
export function useSite(): SiteContext {
  return useOutletContext<SiteContext>();
}

/** The tab of an address: the last part of the path, or « Overview » for the page itself. */
function tabOf(pathname: string, site: string): SiteTab {
  const last = pathname.split('/').at(-1) ?? '';
  if (last === encodeURIComponent(site) || last === site) return 'overview';

  return (
    (['install', 'destinations', 'statuses', 'access', 'advanced'] as const).find((tab) => tab === last) ?? 'overview'
  );
}

/**
 * The frame of the page of a site (FRU-689): the head of 48 px with the crumbs « Sites › site », « Open
 * site » and « See its N notes », then the row of the tabs, then the tab. It reads the site once
 * (`GET …/sites/<id>`, FRU-497) for every tab: a move between two tabs asks the worker nothing, and a
 * tab that changes the site gives the frame what the worker kept.
 *
 * A site that is not in the workspace says so, and a read that failed says it with « Try again ».
 */
export default function SiteFrame() {
  useLocale();
  const context = useWorkspace();
  const { workspace } = context;
  const { site: siteId = '' } = useParams();
  const { pathname } = useLocation();
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const seesTracker = workspace.role !== 'guest';
  // `gone`: the worker answered 404, a site removed or of another workspace. Not a read that failed.
  const [read, setRead] = useState<Fetched<Site> | 'gone'>('loading');

  const readOne = useCallback(async () => {
    setRead('loading');
    const answer = await readSite(workspace.id, siteId);
    if (!answer.ok) return setRead(answer.status === 404 ? 'gone' : 'failed');
    // An answer that is no site is no site (FRU-162): the page says it did not load.
    setRead(typeof answer.data?.id === 'string' && typeof answer.data.origin === 'string' ? answer.data : 'failed');
  }, [workspace.id, siteId]);
  useEffect(() => void readOne(), [readOne]);

  const setSite = useCallback(
    (change: (site: Site) => Site) => setRead((current) => (typeof current === 'string' ? current : change(current))),
    [],
  );

  const site = typeof read === 'string' ? undefined : read;
  const host = site === undefined ? undefined : siteName(site.origin);

  return (
    <>
      <header
        className={`${BLEED} -mt-[40px] flex min-h-[48px] flex-wrap items-center gap-x-[8px] gap-y-[6px] border-b border-line py-[8px] pr-[16px] pl-[20px]`}
      >
        <nav
          aria-label={t('Breadcrumb')}
          className="flex min-w-0 items-center gap-[6px] text-step leading-auto font-semibold"
        >
          <Link
            to={`/w/${workspaceAddress(workspace)}/sites`}
            className="flex-none rounded-inner text-muted [text-decoration:none] hover:text-ink"
          >
            {t('Sites')}
          </Link>
          <span aria-hidden="true" className="flex-none text-control rtl:-scale-x-100">
            <svg viewBox="0 0 24 24" className="size-[12px]">
              <path
                d="M9 6l6 6-6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h1 aria-current="page" className="min-w-0 truncate text-step leading-auto font-semibold text-ink">
            {host ?? t('Site')}
          </h1>
        </nav>
        {site === undefined ? null : (
          <div className="ms-auto flex flex-wrap items-center gap-[8px]">
            <OpenSite origin={site.origin} />
            <NotesLink workspace={workspaceAddress(workspace)} site={site} />
          </div>
        )}
      </header>

      {site === undefined ? (
        <div className={`${BLEED} px-[20px] pt-[24px]`}>
          {read === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
          {read === 'gone' ? (
            <p className="text-body text-muted">{t('This site is not in the workspace any more.')}</p>
          ) : null}
          {read === 'failed' ? (
            <LoadFailed
              title={t('The site did not load')}
              detail={
                <>
                  <ReadProblem /> {t('Your sites and notes are safe.')}
                </>
              }
              retry={t('Try again')}
              onRetry={() => void readOne()}
            />
          ) : null}
        </div>
      ) : (
        <>
          <SiteTabs
            workspace={workspaceAddress(workspace)}
            site={site.id}
            current={tabOf(pathname, siteId)}
            manages={manages}
            seesTracker={seesTracker}
            className={BLEED}
          />
          {/* The tab is 20 px from the edges of the screen, under the words of the first tab, as the mockup. */}
          <div className={`${BLEED} px-[20px] pt-[20px]`}>
            <Outlet context={{ ...context, site, setSite, manages, seesTracker } satisfies SiteContext} />
          </div>
        </>
      )}
    </>
  );
}

/**
 * « Open site »: the site in a new tab, with no referrer, so the console stays where it is (FRU-575).
 * Only an `http` or `https` origin is a link, to the address the page shows.
 */
function OpenSite({ origin }: { origin: string }) {
  useLocale();
  const address = siteLabel(origin);
  if (!/^https?:\/\//.test(address)) return null;

  return (
    <Button tone="outline" inset={10} gap={6} href={address} newTab label={t('Open site (opens in a new tab)')}>
      <SiteIcon name="open" />
      {t('Open site')}
    </Button>
  );
}

/**
 * The notes of the site, on the Notes screen with the site chosen (FRU-504): the count is the one of
 * the summary of the site. No link to a list that is empty.
 */
function NotesLink({ workspace, site }: { workspace: string; site: Site }): ReactNode {
  useLocale();
  const notes = site.notes;
  // A worker of before sends no count: the link is there, with no number.
  const total = notes === undefined ? undefined : STAGES.reduce((sum, stage) => sum + notes[stage], 0);
  if (total === 0) return null;
  let words = t('See its notes');
  if (total === 1) words = t('See its note');
  else if (total !== undefined) words = t('See its {count} notes', { count: total });

  return (
    <Button tone="outline" inset={10} gap={6} to={notesOf(workspace, site.id)}>
      <SiteIcon name="notes" />
      {words}
    </Button>
  );
}
