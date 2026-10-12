import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { type Site, type Visibility, call } from '../api';
import { Confirm } from '../confirm';
import { type Listed, known, listedOf } from '../listed';
import { Button, Card, Chip, Choice, Field, Problem } from '../ui';
import { InstallOptions } from './setup';
import { PageHead, useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';

/** The sites of the workspace: a site is an address and who sees its notes (P2, P3 of the design). */
export default function Sites() {
  useLocale();
  const { workspace } = useWorkspace();
  const [sites, setSites] = useState<Listed<Site>>('loading');
  const [open, setOpen] = useState<string | undefined>();
  const [url, setUrl] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('members');
  const [problem, setProblem] = useState<string | undefined>();
  const manages = workspace.role === 'owner' || workspace.role === 'admin';

  // A read that failed says so, and is asked again: it never reads as « No site yet » (FRU-162).
  const read = useCallback(async () => {
    setSites('loading');
    const answer = await call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`);
    setSites(listedOf(answer, (data) => data.sites));
  }, [workspace.id]);

  useEffect(() => void read(), [read]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    const added = await call<Site>('POST', `/console/workspaces/${workspace.id}/sites`, { url, visibility });
    if (!added.ok) return setProblem(msg('Paste the full address of the site, starting with https://.'));
    // On a list that was never read, the site alone would hide the others: read them all.
    if (typeof sites === 'string') void read();
    else setSites((current) => [...(known(current) ?? []).filter((site) => site.id !== added.data.id), added.data]);
    setOpen(added.data.id);
    setUrl('');
  }

  async function remove(site: Site) {
    const removed = await call('DELETE', `/console/workspaces/${workspace.id}/sites/${site.id}`);
    if (removed.ok) setSites((current) => (known(current) ?? []).filter((each) => each.id !== site.id));
  }

  return (
    <>
      <PageHead title={t('Sites')} lead={t('The addresses you review. Adding a site is pasting its URL.')} />

      {manages ? (
        <form onSubmit={add} className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field
              label={t('Site address')}
              type="url"
              placeholder="https://staging.acme.dev"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <div className="sm:w-56">
            <Choice
              label={t('Who sees the feedback')}
              value={visibility}
              onChange={(value) => setVisibility(value as Visibility)}
              options={[
                { value: 'members', label: t('Members') },
                { value: 'everyone', label: t('Everyone') },
              ]}
            />
          </div>
          <Button type="submit" disabled={url.trim() === ''}>
            {t('Add the site')}
          </Button>
        </form>
      ) : null}
      {problem === undefined ? null : (
        <div className="mb-4">
          <Problem>{t(problem)}</Problem>
        </div>
      )}

      <Card>
        <SiteList
          sites={sites}
          open={open}
          manages={manages}
          onToggle={(site) => setOpen(open === site.id ? undefined : site.id)}
          onRemove={(site) => void remove(site)}
          onRetry={() => void read()}
          install={(site) => <InstallOptions workspace={workspace} site={site} />}
        />
      </Card>
    </>
  );
}

function SiteList({
  sites,
  open,
  manages,
  onToggle,
  onRemove,
  onRetry,
  install,
}: {
  sites: Listed<Site>;
  open: string | undefined;
  manages: boolean;
  onToggle: (site: Site) => void;
  onRemove: (site: Site) => void;
  onRetry: () => void;
  install: (site: Site) => ReactNode;
}) {
  useLocale();
  if (sites === 'loading') return <p className="p-5 text-sm text-muted">{t('Loading…')}</p>;
  if (sites === 'failed')
    return (
      <div className="flex flex-wrap items-center gap-3 p-5">
        <p role="alert" className="flex-1 text-sm text-muted">
          {t('Fruitback did not answer. Your sites are not lost.')}
        </p>
        <Button tone="outline" onClick={onRetry}>
          {t('Try again')}
        </Button>
      </div>
    );
  if (sites.length === 0)
    return <p className="p-5 text-sm text-muted">{t('No site yet. Paste the address of the one you review.')}</p>;

  return (
    <ul>
      {sites.map((site) => (
        <li key={site.id} className="border-b border-line last:border-b-0">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            {/* The host is what a person looks for here, so it wraps rather than being cut. The chip
                and the buttons move as one group, under the host when the row has no room (FRU-159). */}
            <span className="min-w-0 grow basis-32">
              <span className="block text-[15px] font-semibold [overflow-wrap:anywhere]">
                {new URL(site.origin).host}
              </span>
              <span className="block text-xs text-muted [overflow-wrap:anywhere]">{site.origin}</span>
            </span>
            <span className="flex flex-wrap items-center gap-3">
              <Chip tone={site.visibility === 'members' ? 'neutral' : 'accent'}>
                {site.visibility === 'members' ? t('Members') : t('Everyone')}
              </Chip>
              <Button tone="outline" onClick={() => onToggle(site)}>
                {open === site.id ? t('Close') : t('Install')}
              </Button>
              {manages ? (
                <Confirm
                  label={t('Remove')}
                  confirmLabel={t('Remove {site}', { site: new URL(site.origin).host })}
                  consequence={t(
                    'The widget stops on {site}, and the script pasted there no longer works: adding the site again gives it a new script. The notes already in a tracker stay there.',
                    { site: new URL(site.origin).host },
                  )}
                  onConfirm={() => onRemove(site)}
                />
              ) : null}
            </span>
          </div>
          {open === site.id ? <div className="border-t border-line bg-page px-5 py-5">{install(site)}</div> : null}
        </li>
      ))}
    </ul>
  );
}
