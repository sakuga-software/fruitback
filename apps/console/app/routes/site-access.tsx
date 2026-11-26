import { useEffect, useRef, useState } from 'react';
import { type Access, accessBody, accessOf, draftAfter, sameAccess } from '../access-policy';
import { type Site, call } from '../api';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import { siteName } from '../site-address';
import { Button, Problem } from '../ui';
import { useLocale } from '../use-locale';
import {
  AccessLevels,
  DoneNotice,
  Safeguards,
  VisitorPreview,
  VisitorRecognition,
  VisitorRights,
} from '../parts/site-access';
import { useSite } from './site-frame';

const ACCESS_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace changes who sees the notes.'),
};
const ACCESS_NOT_CHANGED = msg('Who sees the notes did not change. Try again.');

/**
 * The tab « Access » of a site (FRU-703): who reads its notes, who leaves them, what a visitor may do
 * to a note of their own, and the safeguards (FRU-704), as the mockup « Onglet Access » draws it. The worker checks every value;
 * this page shows them and sends them, with « Save », as one `POST …/sites` of the address of the site
 * (`addSite` of the store keeps its id, its script and its places).
 *
 * An owner or an admin changes it. Any other role reads it, with every control disabled. The frame of
 * the page (FRU-689) reads the site; « Save » gives it what the worker kept, so « Overview » shows it.
 */
export default function SiteAccessPage() {
  useLocale();
  const { workspace, site, setSite, manages } = useSite();
  // What the tab shows, which « Save » sends. Set again from each site the worker answers.
  const [draft, setDraft] = useState<Access>(() => accessOf(site));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const host = siteName(site.origin);
  // The frame holds another site (a read again, « Save », a link to another site): a draft nobody
  // changed follows it, and one changed and not saved stays (`draftAfter`).
  const shown = useRef(site);
  useEffect(() => {
    const before = shown.current;
    shown.current = site;
    if (before !== site) setDraft((current) => draftAfter(current, before, site));
  }, [site]);

  function change(next: Access) {
    setSaved(false);
    setProblem(undefined);
    setDraft(next);
  }

  async function save() {
    if (busy) return;
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
    // FRU-704: the same for the notes of a visitor in an hour, where they are sent.
    if (
      data?.id !== site.id ||
      data.visitorEdit !== body.visitorEdit ||
      data.visitorDelete !== body.visitorDelete ||
      (body.visitorNotesPerHour !== undefined && data.visitorNotesPerHour !== body.visitorNotesPerHour)
    ) {
      return setProblem(ACCESS_NOT_CHANGED);
    }
    const kept = { ...site, ...data };
    setSite((current) => ({ ...current, ...data }));
    setDraft(accessOf(kept));
    setSaved(true);
  }

  return (
    <>
      <div className="mb-[16px] flex flex-wrap items-center justify-between gap-x-[24px] gap-y-[12px]">
        <p className="min-w-0 text-small text-muted">
          {t('Who sees the notes of the site, who leaves them, and what a visitor may do.')}
        </p>
        {manages ? (
          <Button disabled={busy} onClick={() => void save()} label={t('Save the access of {site}', { site: host })}>
            {t('Save')}
          </Button>
        ) : null}
      </div>

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
          <Safeguards access={draft} disabled={!manages || busy} onChange={change} />
          <DoneNotice access={draft} disabled={!manages || busy} onChange={change} />
        </div>
      </div>
    </>
  );
}
