import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { type Access, accessBody, accessOf, sameAccess } from '../access-policy';
import { type Site, call, readSite } from '../api';
import { msg, t } from '../i18n';
import { type Fetched } from '../listed';
import { problemOf } from '../problems';
import { ReadProblem } from '../read-problem';
import { siteName } from '../site-address';
import { Button, LinkButton, LoadFailed, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { AccessLevels, DoneNotice, VisitorPreview, VisitorRecognition, VisitorRights } from '../parts/site-access';
import { SiteTabs } from '../parts/site-tabs';
import { PageHead, useWorkspace } from './workspace';

const ACCESS_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace changes who sees the notes.'),
};
const ACCESS_NOT_CHANGED = msg('Who sees the notes did not change. Try again.');

/**
 * The tab « Access » of a site (FRU-703): who reads its notes, who leaves them, and what a visitor may
 * do to a note of their own, as the mockup « Onglet Access » draws it. The worker checks every value;
 * this page shows them and sends them, with « Save », as one `POST …/sites` of the address of the site
 * (`addSite` of the store keeps its id, its script and its places).
 *
 * An owner or an admin changes it. Any other role reads it, with every control disabled.
 */
export default function SiteAccessPage() {
  useLocale();
  const { workspace } = useWorkspace();
  const { site: siteId = '' } = useParams();
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const [read, setRead] = useState<Fetched<Site> | 'gone'>('loading');
  // What the tab shows, which « Save » sends. Set again from each site the worker answers.
  const [draft, setDraft] = useState<Access | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  const readOne = useCallback(async () => {
    setRead('loading');
    const answer = await readSite(workspace.id, siteId);
    if (!answer.ok) return setRead(answer.status === 404 ? 'gone' : 'failed');
    if (typeof answer.data?.id !== 'string' || typeof answer.data.origin !== 'string') return setRead('failed');
    setRead(answer.data);
    setDraft(accessOf(answer.data));
  }, [workspace.id, siteId]);
  useEffect(() => void readOne(), [readOne]);

  const site = typeof read === 'string' ? undefined : read;
  const host = site === undefined ? '' : siteName(site.origin);

  function change(next: Access) {
    setSaved(false);
    setProblem(undefined);
    setDraft(next);
  }

  async function save() {
    if (site === undefined || draft === undefined || busy) return;
    setProblem(undefined);
    // Nothing changed: nothing is asked of the worker.
    if (sameAccess(draft, accessOf(site))) return setSaved(true);
    setBusy(true);
    const body = accessBody(site.origin, draft);
    const answer = await call<Site>('POST', `/console/workspaces/${workspace.id}/sites`, body);
    setBusy(false);
    if (!answer.ok) return setProblem(problemOf(answer, ACCESS_PROBLEMS, ACCESS_NOT_CHANGED));
    // Another id would be another site, and an answer without the rights that were sent is a worker that
    // did not keep them (one of before FRU-703): this access was not saved. What was chosen stays on screen.
    const data = answer.data;
    if (data?.id !== site.id || data.visitorEdit !== body.visitorEdit || data.visitorDelete !== body.visitorDelete) {
      return setProblem(ACCESS_NOT_CHANGED);
    }
    const kept = { ...site, ...data };
    setRead(kept);
    setDraft(accessOf(kept));
    setSaved(true);
  }

  const crumbs = (
    <nav
      aria-label={t('Breadcrumb')}
      className="-mt-[calc(var(--text-small)*var(--text-small--line-height)+10px)] mb-[10px] flex flex-wrap items-center gap-[8px] text-small text-muted"
    >
      <LinkButton space="inline" to={`/w/${workspace.id}/sites`}>
        {t('Sites')}
      </LinkButton>
      {site === undefined ? null : (
        <>
          <span aria-hidden="true">›</span>
          <span aria-current="page" className="min-w-0 [overflow-wrap:anywhere]">
            {host}
          </span>
        </>
      )}
    </nav>
  );

  if (site === undefined || draft === undefined)
    return (
      <>
        {crumbs}
        <PageHead
          title={t('Site')}
          lead={t('Who sees the notes of the site, who leaves them, and what a visitor may do.')}
        />
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
      </>
    );

  return (
    <>
      {crumbs}
      <PageHead
        title={host}
        lead={t('Who sees the notes of the site, who leaves them, and what a visitor may do.')}
        action={
          manages ? (
            <Button disabled={busy} onClick={() => void save()} label={t('Save the access of {site}', { site: host })}>
              {t('Save')}
            </Button>
          ) : undefined
        }
      />
      <SiteTabs workspace={workspace.id} site={site.id} current="access" />

      <div className="flex flex-col gap-[8px] empty:hidden [&:not(:empty)]:mb-[16px]">
        {manages ? null : (
          <p className="text-small text-muted">
            {t('Only an owner or an admin of the workspace changes the access of a site.')}
          </p>
        )}
        {saved ? (
          <p role="status" className="text-small text-muted">
            {t('Saved. The script on the site stays the same.')}
          </p>
        ) : null}
        {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      </div>

      <div className="grid items-start gap-[16px] min-[1100px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-[16px]">
          <AccessLevels host={host} access={draft} disabled={!manages || busy} onChange={change} />
          <VisitorRights access={draft} disabled={!manages || busy} onChange={change} />
          <VisitorRecognition />
        </div>
        <div className="flex min-w-0 flex-col gap-[16px]">
          <VisitorPreview access={draft} />
          <DoneNotice access={draft} disabled={!manages || busy} onChange={change} />
        </div>
      </div>
    </>
  );
}
