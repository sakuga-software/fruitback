import { useCallback, useEffect, useState } from 'react';
import { type Site, type Workspace, call } from '../api';
import { t } from '../i18n';
import { type Listed, listedOf } from '../listed';
import { manages } from '../setup-stage';
import { siteName } from '../site-address';
import { Button, LinkButton } from '../ui';
import { useLocale } from '../use-locale';
import { PageHead, useWorkspace } from './workspace';
import { SettingsNav } from './workspace-settings';

/**
 * The page « AI » of the settings of a workspace (FRU-544, asked by Mathieu): what an agent needs,
 * apart from the name, the logo and the deletion. The section « Agents » was the third of the
 * settings (FRU-503); it is the same section, on a page of its own, reached from `SettingsNav`.
 */
export default function WorkspaceSettingsAi() {
  useLocale();
  const { workspace } = useWorkspace();

  return (
    <>
      <PageHead
        title={t('Workspace settings')}
        lead={t('Settings that every member of {name} sees.', { name: workspace.name })}
      />
      <SettingsNav workspace={workspace} current="ai" />
      {/* A move to another workspace mounts the section again: its sites are read for that one. */}
      <AgentsSection key={workspace.id} workspace={workspace} may={manages(workspace)} />
    </>
  );
}

/**
 * Everything an agent needs, in one place (FRU-503): its key (FRU-462, `routes/agents.tsx`), the
 * address that receives the calls (Connectors), and the trigger of each site (FRU-468, « Start an
 * agent » on the page of a site). The three were on three screens, and none showed the whole way.
 * For an owner or an admin; anybody else reads why there is no way, and the page asks nothing.
 */
function AgentsSection({ workspace, may }: { workspace: Workspace; may: boolean }) {
  useLocale();
  const [sites, setSites] = useState<Listed<Site>>('loading');
  const load = useCallback(async () => {
    setSites('loading');
    const read = await call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`);
    setSites(listedOf(read, (data) => data.sites));
  }, [workspace.id]);
  useEffect(() => {
    if (may) void load();
  }, [load, may]);
  const base = `/w/${workspace.id}`;

  return (
    <section aria-labelledby="workspace-agents-title" className="flex max-w-[640px] flex-col gap-[14px]">
      <h2 id="workspace-agents-title" className="text-section font-bold">
        {t('Agents')}
      </h2>
      <p className="text-body">
        {t('Keys that let an AI agent of your team read the notes of some sites, and reply to them.')}
      </p>
      {may ? (
        <ol className="flex list-decimal flex-col gap-[14px] pl-[20px] text-body">
          {/* A `li` that is a flex box draws no number: the layout is in a box inside it. */}
          <li>
            <div className="flex flex-col items-start gap-[8px]">
              <span>{t('A key for each agent.')}</span>
              <Button tone="outline" size="page" to={`${base}/settings/agents`}>
                {t('Manage the agent keys')}
              </Button>
            </div>
          </li>
          <li>
            {t('To start an agent when a note arrives: an address of your team that receives the call.')}{' '}
            <LinkButton space="inline" to={`${base}/connectors`}>
              {t('Connectors')}
            </LinkButton>
          </li>
          <li>
            <div className="flex flex-col gap-[8px]">
              <span>{t('Then, site by site, when to call it.')}</span>
              <SiteTriggers base={base} sites={sites} onRetry={() => void load()} />
            </div>
          </li>
        </ol>
      ) : (
        <p className="text-small text-muted">
          {t('Only an owner or an admin of the workspace manages its agent keys.')}
        </p>
      )}
    </section>
  );
}

/** A link to « Start an agent » on the page of each site, `…/sites/<site>#agent`. */
function SiteTriggers({ base, sites, onRetry }: { base: string; sites: Listed<Site>; onRetry: () => void }) {
  useLocale();
  if (sites === 'loading') return <p className="text-small text-muted">{t('Loading…')}</p>;
  if (sites === 'failed')
    return (
      <div role="alert" className="flex flex-wrap items-center gap-[12px]">
        <p className="text-small">{t('The sites of the workspace did not load.')}</p>
        <Button tone="outline" onClick={onRetry}>
          {t('Try again')}
        </Button>
      </div>
    );
  if (sites.length === 0)
    return (
      <p className="text-small text-muted">
        {t('The workspace has no site yet.')}{' '}
        <LinkButton space="inline" to={`${base}/sites`}>
          {t('Add a site first')}
        </LinkButton>
      </p>
    );

  return (
    <ul aria-label={t('Start an agent, by site')} className="flex flex-col gap-[6px] text-small">
      {sites.map((site) => (
        <li key={site.id}>
          <LinkButton space="inline" to={`${base}/sites/${site.id}#agent`}>
            {t('Start an agent on {site}', { site: siteName(site.origin) })}
          </LinkButton>
        </li>
      ))}
    </ul>
  );
}
