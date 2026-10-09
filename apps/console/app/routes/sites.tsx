import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { type Site, type Visibility, call } from '../api';
import { Button, Card, Chip, Field, Problem } from '../ui';
import { InstallOptions } from './setup';
import { PageHead, useWorkspace } from './workspace';

/** The sites of the workspace: a site is an address and who sees its notes (P2, P3 of the design). */
export default function Sites() {
  const { workspace } = useWorkspace();
  const [sites, setSites] = useState<Site[] | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [url, setUrl] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('members');
  const [problem, setProblem] = useState<string | undefined>();
  const manages = workspace.role === 'owner' || workspace.role === 'admin';

  useEffect(() => {
    void call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`).then((answer) =>
      setSites(answer.ok ? answer.data.sites : []),
    );
  }, [workspace.id]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    const added = await call<Site>('POST', `/console/workspaces/${workspace.id}/sites`, { url, visibility });
    if (!added.ok) return setProblem('Paste the full address of the site, starting with https://.');
    setSites((current) => [...(current ?? []).filter((site) => site.id !== added.data.id), added.data]);
    setOpen(added.data.id);
    setUrl('');
  }

  async function remove(site: Site) {
    const removed = await call('DELETE', `/console/workspaces/${workspace.id}/sites/${site.id}`);
    if (removed.ok) setSites((current) => (current ?? []).filter((each) => each.id !== site.id));
  }

  return (
    <>
      <PageHead title="Sites" lead="The addresses you review. Adding a site is pasting its URL." />

      {manages ? (
        <form onSubmit={add} className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field
              label="Site address"
              type="url"
              placeholder="https://staging.acme.dev"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs text-muted">Who sees the feedback</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as Visibility)}
              className="h-10 rounded-md border border-line bg-surface px-3 text-[15px]"
            >
              <option value="members">Members</option>
              <option value="everyone">Everyone</option>
            </select>
          </label>
          <Button type="submit" disabled={url.trim() === ''}>
            Add the site
          </Button>
        </form>
      ) : null}
      {problem === undefined ? null : (
        <div className="mb-4">
          <Problem>{problem}</Problem>
        </div>
      )}

      <Card>
        <SiteList
          sites={sites}
          open={open}
          manages={manages}
          onToggle={(site) => setOpen(open === site.id ? undefined : site.id)}
          onRemove={(site) => void remove(site)}
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
  install,
}: {
  sites: Site[] | undefined;
  open: string | undefined;
  manages: boolean;
  onToggle: (site: Site) => void;
  onRemove: (site: Site) => void;
  install: (site: Site) => ReactNode;
}) {
  if (sites === undefined) return <p className="p-5 text-sm text-muted">Loading…</p>;
  if (sites.length === 0)
    return <p className="p-5 text-sm text-muted">No site yet. Paste the address of the one you review.</p>;

  return (
    <ul>
      {sites.map((site) => (
        <li key={site.id} className="border-b border-line last:border-b-0">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold">{new URL(site.origin).host}</span>
              <span className="block text-xs text-muted">{site.origin}</span>
            </span>
            <Chip tone={site.visibility === 'members' ? 'neutral' : 'accent'}>
              {site.visibility === 'members' ? 'Members' : 'Everyone'}
            </Chip>
            <Button tone="outline" onClick={() => onToggle(site)}>
              {open === site.id ? 'Close' : 'Install'}
            </Button>
            {manages ? (
              <Button tone="quiet" onClick={() => onRemove(site)}>
                Remove
              </Button>
            ) : null}
          </div>
          {open === site.id ? <div className="border-t border-line bg-page px-5 py-5">{install(site)}</div> : null}
        </li>
      ))}
    </ul>
  );
}
