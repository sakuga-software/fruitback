import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Connector, type Delivery, type Destination, type Site, type Team, call } from '../api';
import { Button, Card, Choice, Field, Problem } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { locale, msg, t } from '../i18n';
import { useLocale } from '../use-locale';

/**
 * The sources (design/boards/4-connectors.png). Linear connects with an API key (FRU-121), and an
 * address of the workspace's own receives each note (FRU-132). The other sources are drawn where the
 * design puts them, and say that they are not there yet.
 */
const LATER = [
  { mark: 'G', name: 'GitHub Issues', detail: msg('An issue per note, in one repository.') },
  { mark: 'J', name: 'Jira', detail: msg('Issues in a Jira Cloud project.') },
  { mark: 'T', name: 'Trello', detail: msg('A card per note, in the list you choose.') },
  { mark: 'N', name: 'Notion', detail: msg('A row per note in a database.') },
] as const;

/** How each kind of source is drawn. The mark is a letter of the boards, not a logo. */
const KINDS = {
  linear: { mark: 'L', name: 'Linear' },
  rest: { mark: '{}', name: 'REST API' },
} as const;

/** Where the contract of the request is written, for whoever writes the receiver. */
const REST_GUIDE = 'https://fruitback.com/rest-connector.html';

/** What a refused address means for the person, and what to do. */
const ADDRESS_PROBLEMS: Record<string, string> = {
  'invalid-address': msg(
    'Fruitback cannot send to this address. Use a full https:// address that the internet can reach.',
  ),
  'invalid-secret': msg('A secret is 16 to 256 characters, with no space. Leave it empty and Fruitback makes one.'),
  'connectors-unavailable': msg('This Fruitback cannot keep a key yet. Its operator must set FRUITBACK_SECRETS_KEY.'),
  forbidden: msg('Only an owner or an admin of the workspace connects a source.'),
  unreachable: msg('Fruitback did not answer. Try again.'),
};

/** What the way back from Linear says, as the worker words it in the address (FRU-134). */
const LINEAR_RETURNS: Record<string, string> = {
  declined: msg('Linear was not connected: the consent was refused there.'),
  forbidden: msg('Only an owner or an admin of the workspace connects a source.'),
  failed: msg('Linear was not connected. Start again from « Connect with Linear ».'),
};

/**
 * What to do about a source that its tracker refuses (FRU-102), by what the tracker said. `{when}` is
 * the first refusal: the notes written since then are not in the tracker.
 */
const ATTENTION: Record<NonNullable<Connector['attention']>['reason'], string> = {
  'key-refused': msg(
    'Linear refuses this connection since {when}, and the notes of its sites do not reach Linear. Disconnect it, then connect Linear again.',
  ),
  'key-lacks-access': msg(
    'Since {when}, Linear refuses what Fruitback asks with this key, and the notes of its sites do not reach Linear. Disconnect it, then connect Linear with a key that has read and write access.',
  ),
  'connection-ended': msg(
    'Linear ended this connection, and since {when} the notes of its sites do not reach Linear. Disconnect it, then connect Linear again.',
  ),
};

/** What a refused key means for the person, and what to do. */
const KEY_PROBLEMS: Record<string, string> = {
  'key-refused': msg('Linear refused this key. Copy it again from Linear, in Settings, then Security and access.'),
  'connectors-unavailable': msg('This Fruitback cannot keep a key yet. Its operator must set FRUITBACK_SECRETS_KEY.'),
  'key-lacks-access': msg(
    'Linear knows this key, and it may not list your teams. Create a key with read and write access, then try again.',
  ),
  forbidden: msg('Only an owner or an admin of the workspace connects a source.'),
  unreachable: msg('Fruitback did not answer. Try again.'),
  'store-unavailable': msg('Linear did not answer just now. Your key is not kept: try again in a minute.'),
};

export default function Connectors() {
  useLocale();
  const { workspace } = useWorkspace();
  const base = `/console/workspaces/${workspace.id}`;
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const [connectors, setConnectors] = useState<Connector[] | undefined>();
  const [available, setAvailable] = useState(true);
  // Whether this worker has a Linear application: the consent at Linear then takes the place of a key.
  const [oauth, setOauth] = useState(false);
  const [search, setSearch] = useSearchParams();
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(LINEAR_RETURNS[search.get('linear') ?? '']);
  const [sites, setSites] = useState<Site[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [adding, setAdding] = useState<Connector['kind'] | undefined>();

  const load = useCallback(async () => {
    const [listed, placed] = await Promise.all([
      call<{ connectors: Connector[]; available: boolean; linearOAuth?: boolean }>('GET', `${base}/connectors`),
      call<{ sites: Site[] }>('GET', `${base}/sites`),
    ]);
    setConnectors(listed.ok ? listed.data.connectors : []);
    setAvailable(listed.ok ? listed.data.available : true);
    setOauth(listed.ok && listed.data.linearOAuth === true);

    setSites(placed.ok ? placed.data.sites : []);

    return listed.ok ? listed.data.connectors : [];
  }, [base]);
  /** The same read, for a panel that only needs it done. */
  const reload = useCallback(async (): Promise<void> => void (await load()), [load]);

  useEffect(() => {
    void load().then((found) => {
      // Back from Linear with a new connector: its panel opens, and the word leaves the address.
      const word = search.get('linear');
      if (word === null) return;
      if (word === 'connected') setSelected(found.at(-1)?.id);
      setSearch({}, { replace: true });
    });
    // Once, when the screen opens: the word in the address is read one time.
  }, [load]);

  /** The worker says where to go, and the browser goes there: the consent is at Linear. */
  async function connectLinear() {
    setLeaving(true);
    setProblem(undefined);
    const asked = await call<{ url: string }>('POST', `${base}/connectors/linear/oauth`);
    if (asked.ok) return window.location.assign(asked.data.url);
    setLeaving(false);
    setProblem(KEY_PROBLEMS[asked.error] ?? msg('Fruitback could not start the connection to Linear. Try again.'));
  }

  const open = connectors?.find((connector) => connector.id === selected);
  const countOf = (connector: Connector): number =>
    sites.filter((site) => site.destination?.connector === connector.id).length;
  const kept = sites.filter((site) => site.destination === undefined).length;

  return (
    <>
      <PageHead
        title={t('Connectors')}
        lead={t('Connect a source once. Every site of the workspace can then send its feedback there.')}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <h2 className="mb-2 text-sm font-semibold text-muted">{t('Connected')}</h2>
          <div className="mb-8 space-y-2">
            <Card>
              <div className="flex items-center gap-3 px-4 py-3.5">
                <SourceMark>F</SourceMark>
                <span className="flex-1">
                  <span className="block text-[15px] font-semibold">{t('Fruitback')}</span>
                  <span className="block text-xs text-muted">
                    {t('The notes stay in this workspace')} · {siteCount(kept)}
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
                <SourceMark>{KINDS[connector.kind].mark}</SourceMark>
                <span className="flex-1">
                  <span className="block text-[15px] font-semibold">{t(KINDS[connector.kind].name)}</span>
                  <span className="block text-xs text-muted">
                    {sourceLine(connector)} · {siteCount(countOf(connector))}
                  </span>
                </span>
                <Working connected={connector.kind === 'rest'} attention={connector.attention !== undefined} />
              </button>
            ))}
          </div>

          <h2 className="mb-2 text-sm font-semibold text-muted">{t('Add a source')}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Card className="flex flex-col p-4">
              <div className="mb-2 flex items-center gap-3">
                <SourceMark small>L</SourceMark>
                <span className="text-[15px] font-semibold">{t('Linear')}</span>
              </div>
              <p className="mb-4 flex-1 text-sm text-muted">{t('An issue per note, in the team you choose.')}</p>
              {adding === 'linear' ? (
                <AddLinear
                  base={base}
                  onDone={(connector) => {
                    setAdding(undefined);
                    if (connector !== undefined) {
                      setSelected(connector.id);
                      void load();
                    }
                  }}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {oauth ? (
                    <Button
                      tone="outline"
                      disabled={!manages || !available || leaving}
                      onClick={() => void connectLinear()}
                    >
                      {leaving ? t('Going to Linear…') : t('Connect with Linear')}
                    </Button>
                  ) : null}
                  <Button
                    tone={oauth ? 'quiet' : 'outline'}
                    disabled={!manages || !available}
                    onClick={() => setAdding('linear')}
                  >
                    {oauth ? t('Use an API key') : t('Connect')}
                  </Button>
                </div>
              )}
              {problem === undefined ? null : (
                <div className="mt-2">
                  <Problem>{t(problem)}</Problem>
                </div>
              )}
              {manages ? null : (
                <p className="mt-2 text-xs text-muted">{t('An owner or an admin connects a source')}</p>
              )}
              {available ? null : (
                <p className="mt-2 text-xs text-muted">{t(KEY_PROBLEMS['connectors-unavailable'] ?? '')}</p>
              )}
            </Card>
            <Card className="flex flex-col p-4">
              <div className="mb-2 flex items-center gap-3">
                <SourceMark small>{KINDS.rest.mark}</SourceMark>
                <span className="text-[15px] font-semibold">{t('REST API')}</span>
              </div>
              <p className="mb-4 flex-1 text-sm text-muted">{t('POST each note to your own endpoint.')}</p>
              {adding === 'rest' ? (
                <AddRest
                  base={base}
                  onAdded={(connector) => {
                    setSelected(connector.id);
                    void load();
                  }}
                  onDone={() => setAdding(undefined)}
                />
              ) : (
                <Button
                  tone="outline"
                  className="self-start"
                  disabled={!manages || !available}
                  onClick={() => setAdding('rest')}
                >
                  {t('Connect')}
                </Button>
              )}
            </Card>
            {LATER.map((source) => (
              <Card key={source.name} className="flex flex-col p-4">
                <div className="mb-2 flex items-center gap-3">
                  <SourceMark small>{source.mark}</SourceMark>
                  <span className="text-[15px] font-semibold">{source.name}</span>
                </div>
                <p className="mb-4 flex-1 text-sm text-muted">{t(source.detail)}</p>
                <Button tone="outline" disabled className="self-start">
                  {t('After the beta')}
                </Button>
              </Card>
            ))}
          </div>
        </div>

        {open === undefined ? null : (
          <Panel
            key={open.id}
            base={base}
            connector={open}
            sites={sites}
            manages={manages}
            onChanged={reload}
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

type PanelProps = {
  base: string;
  connector: Connector;
  sites: Site[];
  manages: boolean;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
};

/** The panel of a connector, by its kind: a tracker has teams, an address has deliveries. */
function Panel(props: PanelProps) {
  return props.connector.kind === 'rest' ? <RestDetail {...props} /> : <Detail {...props} />;
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

/**
 * The state of a source. A tracker that took the key is working. An address is only connected: the
 * list cannot know that its notes arrive, and the panel of the address says which did not. A tracker
 * that refuses the source needs somebody (FRU-102), and the panel of the source says what to do.
 */
function Working({ connected = false, attention = false }: { connected?: boolean; attention?: boolean }) {
  useLocale();
  if (attention) {
    return (
      <span className="flex items-center gap-1.5 text-sm font-semibold text-accent-strong">
        <span className="h-2 w-2 rounded-full bg-accent-strong" />
        {t('Needs attention')}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-sm font-semibold text-done">
      <span className="h-2 w-2 rounded-full bg-done" />
      {connected ? t('Connected') : t('Working')}
    </span>
  );
}

/** The key is typed once and sent once. Nothing here keeps it, and the worker never answers it. */
function AddLinear({ base, onDone }: { base: string; onDone: (connector: Connector | undefined) => void }) {
  useLocale();
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
    setProblem(KEY_PROBLEMS[added.error] ?? msg('The key could not be kept just now. Try again.'));
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Field
        label={t('Linear API key')}
        type="password"
        autoComplete="off"
        placeholder="lin_api_…"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        hint={t('A personal API key, from Linear, Settings, Security and access. Fruitback keeps it encrypted.')}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || apiKey.trim() === ''}>
          {busy ? t('Checking…') : t('Connect')}
        </Button>
        <Button tone="quiet" onClick={() => onDone(undefined)}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The address is typed once and sent once, like a key. A secret that Fruitback made is shown here
 * once: the worker answers it when the connector is made, and never again.
 */
function AddRest({
  base,
  onAdded,
  onDone,
}: {
  base: string;
  onAdded: (connector: Connector) => void;
  onDone: () => void;
}) {
  useLocale();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [made, setMade] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const added = await call<Connector & { secret?: string }>('POST', `${base}/connectors`, {
      kind: 'rest',
      url,
      ...(secret.trim() === '' ? {} : { secret: secret.trim() }),
    });
    setBusy(false);
    if (!added.ok) {
      return setProblem(ADDRESS_PROBLEMS[added.error] ?? msg('The address could not be kept just now. Try again.'));
    }
    onAdded(added.data);
    // A secret the person gave is theirs already: nothing is left to show.
    if (added.data.secret === undefined) return onDone();
    setMade(added.data.secret);
  }

  if (made !== undefined) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-semibold">{t('Copy this secret now')}</p>
        <p className="text-xs text-muted">
          {t('Your receiver checks each request with it. Fruitback does not show it again.')}
        </p>
        <code className="block break-all rounded-md bg-chip px-3 py-2 font-mono text-xs" data-secret>
          {made}
        </code>
        <div className="flex gap-2">
          <Button
            tone="outline"
            onClick={() =>
              void navigator.clipboard.writeText(made).then(
                () => setCopied(true),
                // A clipboard can refuse. The secret is on the screen, to select by hand.
                () => setCopied(false),
              )
            }
          >
            {copied ? t('Copied') : t('Copy')}
          </Button>
          <Button onClick={onDone}>{t('I kept it')}</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Field
        label={t('Address of your receiver')}
        type="url"
        autoComplete="off"
        placeholder="https://hooks.acme.dev/fruitback"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        hint={t('Each note is posted there, signed. The notes stay in Fruitback too.')}
      />
      <Field
        label={t('Secret (optional)')}
        type="password"
        autoComplete="off"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        hint={t('Leave it empty and Fruitback makes one, shown once.')}
      />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || url.trim() === ''}>
          {busy ? t('Checking…') : t('Connect')}
        </Button>
        <Button tone="quiet" onClick={onDone}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  );
}

const HERE = 'fruitback';
/** The value of the choice « this site sends its notes to the address ». */
const THERE = 'address';

/** The host a receiving connector sends to, as the worker named it: `REST · hooks.acme.dev`. */
function hostOf(connector: Connector): string {
  return connector.label.replace(/^REST · /, '');
}

/** A moment, in the language of the console. */
function moment(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/** Why a delivery did not arrive, in a few words: the status of the receiver, or what stopped the request. */
function reasonOf(delivery: Delivery): string {
  if (delivery.lastStatus !== undefined) return t('Your receiver answered {status}', { status: delivery.lastStatus });
  if (delivery.lastError !== undefined) return t('No answer: {error}', { error: delivery.lastError });

  return t('Not sent yet');
}

/**
 * The panel of an address that receives (FRU-132): which sites send their notes there, and the notes
 * that did not arrive. A site has no team to choose here: it sends, or it does not.
 */
function RestDetail({
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
  useLocale();
  const [late, setLate] = useState<Delivery[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  const read = useCallback(async () => {
    const listed = await call<{ deliveries: Delivery[] }>('GET', `${base}/connectors/${connector.id}/deliveries`);
    // No list is not an empty list: a worker that did not answer must not read as « all arrived ».
    setLate(listed.ok ? listed.data.deliveries : undefined);
  }, [base, connector.id]);

  useEffect(() => void read(), [read]);

  async function place(site: Site, value: string) {
    setProblem(undefined);
    const set = await call(
      'POST',
      `${base}/sites/${site.id}/destination`,
      value === THERE ? { connector: connector.id } : { connector: null },
    );
    if (!set.ok) setProblem(msg('The destination of this site did not change. Try again.'));
    await onChanged();
  }

  async function retry(delivery: Delivery) {
    setProblem(undefined);
    const asked = await call('POST', `${base}/connectors/${connector.id}/deliveries/${delivery.id}/retry`);
    if (!asked.ok) setProblem(msg('The new attempt was not started. Try again.'));
    await read();
  }

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(msg('This source is still connected. Try again.'));
  }

  return (
    <Card className="self-start">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <SourceMark>{KINDS.rest.mark}</SourceMark>
        <div className="min-w-0">
          <h2 className="text-[17px] font-bold">{t('REST API')}</h2>
          <p className="truncate text-xs text-muted">{t('Sends to {host}', { host: hostOf(connector) })}</p>
        </div>
      </div>
      <div className="px-5 py-4">
        <h3 className="mb-2 text-sm font-semibold">{t('Which sites send their notes there')}</h3>
        {sites.length === 0 ? <p className="text-sm text-muted">{t('This workspace has no site yet.')}</p> : null}
        <ul className="space-y-2">
          {sites.map((site) => {
            const elsewhere = site.destination !== undefined && site.destination.connector !== connector.id;

            return (
              <li key={site.id} className="rounded-md bg-chip px-3 py-2">
                <Choice
                  label={new URL(site.origin).host}
                  labelStrong
                  value={site.destination === undefined || elsewhere ? HERE : THERE}
                  disabled={!manages}
                  onChange={(value) => void place(site, value)}
                  options={[
                    { value: HERE, label: elsewhere ? t('Another source') : t('Fruitback only') },
                    { value: THERE, label: t('Fruitback, and this address') },
                  ]}
                />
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted">
          <a className="underline" href={REST_GUIDE} target="_blank" rel="noreferrer">
            {t('The request, and how to check its signature')}
          </a>
        </p>
      </div>
      <div className="border-t border-line px-5 py-4" data-deliveries>
        <h3 className="mb-2 text-sm font-semibold">{t('Notes that did not arrive')}</h3>
        {late === undefined ? <p className="text-sm text-muted">{t('Fruitback did not answer. Try again.')}</p> : null}
        {late?.length === 0 ? <p className="text-sm text-muted">{t('Every note arrived.')}</p> : null}
        <ul className="space-y-2">
          {(late ?? []).map((delivery) => (
            <li key={delivery.id} className="rounded-md bg-chip px-3 py-2 text-sm">
              <span className="block font-semibold">{reasonOf(delivery)}</span>
              <span className="block text-xs text-muted">
                {t('Written {when}', { when: moment(delivery.createdAt) })} ·{' '}
                {delivery.attempts === 1 ? t('1 attempt') : t('{count} attempts', { count: delivery.attempts })}
              </span>
              <span className="block text-xs text-muted">
                {delivery.nextAt === undefined
                  ? t('Fruitback stopped trying.')
                  : t('Next attempt {when}', { when: moment(delivery.nextAt) })}
              </span>
              {manages ? (
                <Button tone="outline" className="mt-2" onClick={() => void retry(delivery)}>
                  {t('Try now')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {problem === undefined ? null : (
          <div className="mt-3">
            <Problem>{t(problem)}</Problem>
          </div>
        )}
      </div>
      {manages ? (
        <div className="border-t border-line px-5 py-3">
          <Button tone="quiet" className="-ml-4" onClick={() => void disconnect()}>
            {t('Disconnect')}
          </Button>
          <p className="text-xs text-muted">
            {t('Its sites keep their notes in the workspace, and the notes that waited are not sent.')}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/** The person whose key this is, as the worker named the connector: `Linear · Camille`. */
function personOf(connector: Connector): string {
  return connector.label.replace(/^Linear · /, '');
}

/** A Linear connected with OAuth is named after its workspace of Linear: `Linear OAuth · Acme`. */
const OAUTH_LABEL = /^Linear OAuth · /;

/** How a source is connected, in one line under its name. */
function sourceLine(connector: Connector): string {
  if (connector.kind === 'rest') return hostOf(connector);
  if (OAUTH_LABEL.test(connector.label)) {
    return t('Workspace {name}', { name: connector.label.replace(OAUTH_LABEL, '') });
  }

  return t('Key of {person}', { person: personOf(connector) });
}

function siteCount(count: number): string {
  return count === 1 ? t('{count} site', { count }) : t('{count} sites', { count });
}

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
  useLocale();
  const [teams, setTeams] = useState<Team[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    if (!manages) return;
    setSilent(false);
    void call<{ teams: Team[] }>('GET', `${base}/connectors/${connector.id}/teams`).then((answer) => {
      if (answer.ok) return setTeams(answer.data.teams);
      setTeams([]);
      setSilent(true);
      // This read is what told the worker that Linear refuses the source: the list is read again, and
      // the reason takes the place of the sentence below.
      void onChanged();
    });
    // `onChanged` is not a reason to ask Linear again: the read above runs once for a connector.
  }, [base, connector.id, manages]);

  async function place(site: Site, value: string) {
    setProblem(undefined);
    const [teamId, projectId] = value.split('/');
    const body: { connector: null } | Destination =
      value === HERE || teamId === undefined
        ? { connector: null }
        : { connector: connector.id, teamId, ...(projectId === undefined ? {} : { projectId }) };
    const set = await call('POST', `${base}/sites/${site.id}/destination`, body);
    if (!set.ok) setProblem(msg('The destination of this site did not change. Try again.'));
    await onChanged();
  }

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(msg('This source is still connected. Try again.'));
  }

  return (
    <Card className="self-start">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <SourceMark>L</SourceMark>
        <div>
          <h2 className="text-[17px] font-bold">{t('Linear')}</h2>
          <p className="text-xs text-muted">
            {OAUTH_LABEL.test(connector.label)
              ? t('Connected to the workspace {name}', { name: connector.label.replace(OAUTH_LABEL, '') })
              : t('Connected with the key of {person}', { person: personOf(connector) })}
          </p>
        </div>
      </div>
      <div className="px-5 py-4">
        {connector.attention === undefined ? null : (
          <div className="mb-4">
            <Problem>{t(ATTENTION[connector.attention.reason], { when: moment(connector.attention.since) })}</Problem>
          </div>
        )}
        <h3 className="mb-2 text-sm font-semibold">{t('Where each site sends its notes')}</h3>
        {sites.length === 0 ? <p className="text-sm text-muted">{t('This workspace has no site yet.')}</p> : null}
        <ul className="space-y-2">
          {sites.map((site) => {
            const elsewhere = site.destination !== undefined && site.destination.connector !== connector.id;
            const current =
              site.destination === undefined || elsewhere
                ? HERE
                : [site.destination.teamId, site.destination.projectId].filter(Boolean).join('/');

            return (
              <li key={site.id} className="rounded-md bg-chip px-3 py-2">
                <Choice
                  label={new URL(site.origin).host}
                  labelStrong
                  value={current}
                  disabled={!manages || teams === undefined}
                  onChange={(value) => void place(site, value)}
                  options={[
                    { value: HERE, label: elsewhere ? t('Another source') : t('Fruitback, in this workspace') },
                    ...(teams ?? []).map((team) => ({
                      heading: team.name,
                      options: [
                        { value: team.id, label: t('{team}, no project', { team: team.name }) },
                        ...team.projects.map((project) => ({
                          value: `${team.id}/${project.id}`,
                          label: `${team.name} · ${project.name}`,
                        })),
                      ],
                    })),
                  ]}
                />
              </li>
            );
          })}
        </ul>
        {/* A source with a reason says it above: this sentence is for a Linear that only did not answer. */}
        {silent && connector.attention === undefined ? (
          <div className="mt-3">
            <Problem>
              {t('Linear did not answer for this connection. Disconnect it, then connect Linear again.')}
            </Problem>
          </div>
        ) : null}
        {problem === undefined ? null : (
          <div className="mt-3">
            <Problem>{t(problem)}</Problem>
          </div>
        )}
      </div>
      {manages ? (
        <div className="border-t border-line px-5 py-3">
          <Button tone="quiet" className="-ml-4" onClick={() => void disconnect()}>
            {t('Disconnect')}
          </Button>
          <p className="text-xs text-muted">{t('Its sites keep their notes in the workspace again.')}</p>
        </div>
      ) : null}
    </Card>
  );
}
