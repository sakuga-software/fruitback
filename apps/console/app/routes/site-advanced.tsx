import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { type Connector, type SiteChoice, call, siteChoices, workspaceAddress } from '../api';
import { Confirmation } from '../confirm';
import { Domains } from '../domains';
import { msg, t } from '../i18n';
import { type Listed, listedOf } from '../listed';
import { problemOf } from '../problems';
import { siteName } from '../site-address';
import { Button, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { SiteAgent } from '../parts/site-agent';
import { useSite } from './site-frame';

const REMOVAL_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace removes a site.'),
};
const SITE_NOT_REMOVED = msg('This site is still here. Try again.');

/**
 * The tab « Advanced » of a site (FRU-689): what is set once, for an owner or an admin. « Start an
 * agent » (FRU-468), the preview builds (`domains.tsx`, FRU-103), and the removal of the site. Anybody
 * else reads one sentence, and the tab asks the worker nothing.
 *
 * A hash of a section (`#agent`, `#previews`, `#remove`) scrolls to it once the tab is drawn, and
 * `#remove` opens the confirmation: « Remove » in the menu of a row of Sites is the first time the
 * removal is asked, and this tab asks the second.
 */
export default function SiteAdvanced() {
  useLocale();
  const { workspace, site, manages } = useSite();
  const { hash, key } = useLocation();
  const navigate = useNavigate();
  const base = `/console/workspaces/${workspace.id}`;
  const host = siteName(site.origin);

  // The sites to name in « Previews » (FRU-103): their id and address, and no count (FRU-497).
  const [choices, setChoices] = useState<Listed<SiteChoice>>('loading');
  useEffect(() => {
    if (!manages) return;
    let current = true;
    setChoices('loading');
    void siteChoices(workspace.id).then((answer) => {
      if (current) setChoices(listedOf(answer, (data) => data.sites));
    });

    return () => {
      current = false;
    };
  }, [manages, workspace.id]);

  // The sources of the workspace: « Start an agent » calls one of its addresses (FRU-468).
  const [connectors, setConnectors] = useState<Listed<Connector>>('loading');
  const readConnectors = useCallback(
    async (current: () => boolean = () => true) => {
      setConnectors('loading');
      const answer = await call<{ connectors: Connector[] }>('GET', `${base}/connectors`);
      if (current()) setConnectors(listedOf(answer, (data) => data.connectors));
    },
    [base],
  );
  useEffect(() => {
    if (!manages) return;
    let current = true;
    void readConnectors(() => current);

    return () => {
      current = false;
    };
  }, [manages, readConnectors]);

  const wanted = hash.slice(1);
  const [removing, setRemoving] = useState(wanted === 'remove');
  useEffect(() => {
    if (wanted === 'remove') setRemoving(true);
  }, [wanted, key]);
  // `key` is new on each navigation: a link to the hash already in the address scrolls again.
  useEffect(() => {
    if (wanted !== '') document.getElementById(wanted)?.scrollIntoView({ block: 'start' });
  }, [wanted, key]);

  const [problem, setProblem] = useState<string | undefined>();
  const removeButton = useRef<HTMLDivElement>(null);
  async function remove() {
    setProblem(undefined);
    const removed = await call('DELETE', `${base}/sites/${encodeURIComponent(site.id)}`);
    // A site that is still there says so under the button (FRU-164).
    if (!removed.ok) return setProblem(problemOf(removed, REMOVAL_PROBLEMS, SITE_NOT_REMOVED));
    // The table takes focus on its search: a keyboard does not start again from the top of the page.
    navigate(`/w/${workspaceAddress(workspace)}/sites`, { state: { removed: site.id } });
  }
  const keep = () => {
    setRemoving(false);
    if (hash === '#remove') navigate({ hash: '' }, { replace: true });
    // The way back gives focus to the button that asks, which the confirmation replaced.
    requestAnimationFrame(() => removeButton.current?.querySelector('button')?.focus());
  };

  if (!manages)
    return (
      <p className="text-body text-muted">{t('Only an owner or an admin of the workspace sets these for a site.')}</p>
    );

  return (
    <div className="flex max-w-[760px] flex-col gap-[40px]">
      <SiteAgent workspace={workspace} site={site} connectors={connectors} onRetry={() => void readConnectors()} />
      <div id="previews" className="scroll-mt-[24px] [&>section]:mt-0">
        <Domains workspace={workspace} sites={choices} />
      </div>
      <section id="remove" aria-labelledby="remove-title" className="flex min-w-0 scroll-mt-[24px] flex-col gap-[12px]">
        <h2 id="remove-title" className="text-section font-bold">
          {t('Remove this site')}
        </h2>
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
      </section>
    </div>
  );
}
