import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type Connector, type Destination, type Site, type Team, call } from '../api';
import { Button, Card, Field, Problem } from '../ui';
import { PageHead, useWorkspace } from './workspace';

/**
 * The sources (design/boards/4-connectors.png). Linear connects with an API key (FRU-121). The other
 * sources are drawn where the design puts them, and say that they are not there yet.
 */
const LATER = [
  { mark: 'G', name: 'GitHub Issues', detail: 'An issue per note, in one repository.' },
  { mark: 'J', name: 'Jira', detail: 'Issues in a Jira Cloud project.' },
  { mark: 'T', name: 'Trello', detail: 'A card per note, in the list you choose.' },
  { mark: 'N', name: 'Notion', detail: 'A row per note in a database.' },
  { mark: '{}', name: 'REST API', detail: 'POST each note to your own endpoint.' },
] as const;

/** What a refused key means for the person, and what to do. */
const KEY_PROBLEMS: Record<string, string> = {
  'key-refused': 'Linear refused this key. Copy it again from Linear, in Settings, then Security and access.',
  'connectors-unavailable': 'This Fruitback cannot keep a key yet. Its operator must set FRUITBACK_SECRETS_KEY.',
  forbidden: 'Only an owner or an admin of the workspace connects a source.',
  unreachable: 'Fruitback did not answer. Try again.',
};

export default function Connectors() {
  const { workspace } = useWorkspace();
  const base = `/console/workspaces/${workspace.id}`;
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const [connectors, setConnectors] = useState<Connector[] | undefined>();
  const [available, setAvailable] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [listed, placed] = await Promise.all([
      call<{ connectors: Connector[]; available: boolean }>('GET', `${base}/connectors`),
      call<{ sites: Site[] }>('GET', `${base}/sites`),
    ]);
    setConnectors(listed.ok ? listed.data.connectors : []);
    setAvailable(listed.ok ? listed.data.available : true);
    setSites(placed.ok ? placed.data.sites : []);
  }, [base]);

  useEffect(() => void load(), [load]);

  const open = connectors?.find((connector) => connector.id === selected);
  const countOf = (connector: Connector): number =>
    sites.filter((site) => site.destination?.connector === connector.id).length;
  const kept = sites.filter((site) => site.destination === undefined).length;

  return (
    <>
      <PageHead
        title="Connectors"
        lead="Connect a source once. Every site of the workspace can then send its feedback there."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <h2 className="mb-2 text-sm font-semibold text-muted">Connected</h2>
          <div className="mb-8 space-y-2">
            <Card>
              <div className="flex items-center gap-3 px-4 py-3.5">
                <SourceMark>F</SourceMark>
                <span className="flex-1">
                  <span className="block text-[15px] font-semibold">Fruitback</span>
                  <span className="block text-xs text-muted">
                    The notes stay in this workspace · {kept} {kept === 1 ? 'site' : 'sites'}
                  </span>
                </span>
                <Working />
              </div>
            </Card>
            {(connectors ?? []).map((connector) => (
              <button
                key={connector.id}
                type="button"
                aria-pressed={connector.id === selected}
                onClick={() => setSelected(connector.id === selected ? undefined : connector.id)}
                className={`flex w-full items-center gap-3 rounded-[14px] border bg-surface px-4 py-3.5 text-left ${
                  connector.id === selected ? 'border-ink' : 'border-line hover:border-ink/40'
                }`}
              >
                <SourceMark>L</SourceMark>
                <span className="flex-1">
                  <span className="block text-[15px] font-semibold">Linear</span>
                  <span className="block text-xs text-muted">
                    {connector.label.replace(/^Linear · /, 'Key of ')} · {countOf(connector)}{' '}
                    {countOf(connector) === 1 ? 'site' : 'sites'}
                  </span>
                </span>
                <Working />
              </button>
            ))}
          </div>

          <h2 className="mb-2 text-sm font-semibold text-muted">Add a source</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Card className="flex flex-col p-4">
              <div className="mb-2 flex items-center gap-3">
                <SourceMark small>L</SourceMark>
                <span className="text-[15px] font-semibold">Linear</span>
              </div>
              <p className="mb-4 flex-1 text-sm text-muted">An issue per note, in the team you choose.</p>
              {adding ? (
                <AddLinear
                  base={base}
                  onDone={(connector) => {
                    setAdding(false);
                    if (connector !== undefined) {
                      setSelected(connector.id);
                      void load();
                    }
                  }}
                />
              ) : (
                <Button
                  tone="outline"
                  className="self-start"
                  disabled={!manages || !available}
                  title={manages ? undefined : 'An owner or an admin connects a source'}
                  onClick={() => setAdding(true)}
                >
                  Connect
                </Button>
              )}
              {available ? null : <p className="mt-2 text-xs text-muted">{KEY_PROBLEMS['connectors-unavailable']}</p>}
            </Card>
            {LATER.map((source) => (
              <Card key={source.name} className="flex flex-col p-4">
                <div className="mb-2 flex items-center gap-3">
                  <SourceMark small>{source.mark}</SourceMark>
                  <span className="text-[15px] font-semibold">{source.name}</span>
                </div>
                <p className="mb-4 flex-1 text-sm text-muted">{source.detail}</p>
                <Button tone="outline" disabled className="self-start" title="After the beta">
                  After the beta
                </Button>
              </Card>
            ))}
          </div>
        </div>

        {open === undefined ? null : (
          <Detail
            key={open.id}
            base={base}
            connector={open}
            sites={sites}
            manages={manages}
            onChanged={load}
            onRemoved={() => {
              setSelected(undefined);
              void load();
            }}
          />
        )}
      </div>
    </>
  );
}

function SourceMark({ children, small = false }: { children: string; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex items-center justify-center bg-chip font-bold ${small ? 'h-8 w-8 rounded-md text-xs' : 'h-9 w-9 rounded-lg text-sm'}`}
    >
      {children}
    </span>
  );
}

function Working() {
  return (
    <span className="flex items-center gap-1.5 text-sm font-semibold text-done">
      <span className="h-2 w-2 rounded-full bg-done" />
      Working
    </span>
  );
}

/** The key is typed once and sent once. Nothing here keeps it, and the worker never answers it. */
function AddLinear({ base, onDone }: { base: string; onDone: (connector: Connector | undefined) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const added = await call<Connector>('POST', `${base}/connectors`, { kind: 'linear', apiKey });
    setBusy(false);
    if (added.ok) return onDone(added.data);
    setProblem(KEY_PROBLEMS[added.error] ?? 'The key could not be kept just now. Try again.');
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Field
        label="Linear API key"
        type="password"
        autoComplete="off"
        placeholder="lin_api_…"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        hint="A personal API key, from Linear, Settings, Security and access. Fruitback keeps it encrypted."
      />
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || apiKey.trim() === ''}>
          {busy ? 'Checking…' : 'Connect'}
        </Button>
        <Button tone="quiet" onClick={() => onDone(undefined)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const HERE = 'fruitback';

/** The panel of one connector: which sites send their notes there, and to which team. */
function Detail({
  base,
  connector,
  sites,
  manages,
  onChanged,
  onRemoved,
}: {
  base: string;
  connector: Connector;
  sites: Site[];
  manages: boolean;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const [teams, setTeams] = useState<Team[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    if (!manages) return;
    void call<{ teams: Team[] }>('GET', `${base}/connectors/${connector.id}/teams`).then((answer) => {
      if (answer.ok) return setTeams(answer.data.teams);
      setTeams([]);
      setProblem('Linear did not answer with this key. Disconnect it, then connect a new key.');
    });
  }, [base, connector.id, manages]);

  async function place(site: Site, value: string) {
    setProblem(undefined);
    const [teamId, projectId] = value.split('/');
    const body: { connector: null } | Destination =
      value === HERE || teamId === undefined
        ? { connector: null }
        : { connector: connector.id, teamId, ...(projectId === undefined ? {} : { projectId }) };
    const set = await call('POST', `${base}/sites/${site.id}/destination`, body);
    if (!set.ok) setProblem('The destination of this site did not change. Try again.');
    await onChanged();
  }

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem('This source is still connected. Try again.');
  }

  return (
    <Card className="self-start">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <SourceMark>L</SourceMark>
        <div>
          <h2 className="text-[17px] font-bold">Linear</h2>
          <p className="text-xs text-muted">{connector.label.replace(/^Linear · /, 'Connected with the key of ')}</p>
        </div>
      </div>
      <div className="px-5 py-4">
        <h3 className="mb-2 text-sm font-semibold">Where each site sends its notes</h3>
        {sites.length === 0 ? <p className="text-sm text-muted">This workspace has no site yet.</p> : null}
        <ul className="space-y-2">
          {sites.map((site) => {
            const elsewhere = site.destination !== undefined && site.destination.connector !== connector.id;
            const current =
              site.destination === undefined || elsewhere
                ? HERE
                : [site.destination.teamId, site.destination.projectId].filter(Boolean).join('/');

            return (
              <li key={site.id} className="rounded-md bg-chip px-3 py-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-semibold">{new URL(site.origin).host}</span>
                  <select
                    value={current}
                    disabled={!manages || teams === undefined}
                    onChange={(event) => void place(site, event.target.value)}
                    className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
                  >
                    <option value={HERE}>{elsewhere ? 'Another source' : 'Fruitback, in this workspace'}</option>
                    {(teams ?? []).map((team) => (
                      <optgroup key={team.id} label={team.name}>
                        <option value={team.id}>{team.name}, no project</option>
                        {team.projects.map((project) => (
                          <option key={project.id} value={`${team.id}/${project.id}`}>
                            {team.name} · {project.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
        {problem === undefined ? null : (
          <div className="mt-3">
            <Problem>{problem}</Problem>
          </div>
        )}
      </div>
      {manages ? (
        <div className="border-t border-line px-5 py-3">
          <Button tone="quiet" className="-ml-4" onClick={() => void disconnect()}>
            Disconnect
          </Button>
          <p className="text-xs text-muted">Its sites keep their notes in the workspace again.</p>
        </div>
      ) : null}
    </Card>
  );
}
