import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Connector, type Delivery, type Site, call } from '../api';
import { type Listed, known, listedOf } from '../listed';
import { Button, Dialog, Problem } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { WORKSPACE_SUSPENDED, problemOf, writeProblemOf } from '../problems';
import { useLocale } from '../use-locale';
import { AddLinear, AddRest, AddRoutine } from '../parts/connector-add';
import { GithubPanel } from '../parts/connector-github';
import { LinearPanel } from '../parts/connector-linear';
import { ConnectorName } from '../parts/connector-name';
import { KEY_PROBLEMS, KINDS, type PanelProps, connectorName, sourceLine } from '../parts/connector-parts';
import { RestPanel } from '../parts/connector-rest';
import { AddPlugin, PLUGIN_RETURNS, PluginPanel, leaveForPlugin, pluginSentence } from '../parts/connector-plugin';
import { trackerOf } from '../trackers/index.ts';
import { PLUGIN_KINDS, type PluginKind, isPluginKind } from '../trackers/plugin.ts';
import { RoutinePanel } from '../parts/connector-routine';
import { NoCodeRecipes } from '../parts/agent-recipes';
import type { LogoKind } from '../connector-logo-kinds.ts';
import { ADD_TITLE, Catalogue, type Entry, type Offer } from '../parts/connector-catalogue';
import { type Late, receives } from '../parts/connector-health';
import { ConnectorsTable } from '../parts/connector-table';
import { ReadProblem } from '../read-problem';

/**
 * The connectors of a workspace (FRU-690): a table of the connectors that are connected, with the
 * health of each one, and the catalogue of what can be added, as tiles with the logo of each tracker.
 * The settings of a connector open in a dialog (FRU-690), where they were an accordion under its row
 * (FRU-403).
 *
 * Linear connects with OAuth or an API key (FRU-121, FRU-134), GitHub with its App where the worker
 * has one (FRU-361), an address of the workspace's own receives each note (FRU-132), and the plugins
 * of the worker connect as they say (FRU-621). The other trackers of the catalogue say « Soon »: no
 * button connects what does not exist.
 */

/** What the way back from Linear says, as the worker words it in the address (FRU-134). */
const LINEAR_RETURNS: Record<string, string> = {
  declined: msg('You declined access in Linear, so it is not connected. Press Connect to try again.'),
  forbidden: msg('Only an owner or an admin of the workspace adds a connector.'),
  failed: msg('Linear was not connected. Start again from « Connect ».'),
};

/**
 * What the way back from GitHub says, as the worker words it in the address (FRU-360). `unstarted`
 * comes from the front door: GitHub sent the person back with no start of this browser (FRU-361).
 */
const GITHUB_RETURNS: Record<string, string> = {
  requested: msg(
    'GitHub was not connected yet: an owner of the organisation must approve the App. After the approval, connect GitHub again.',
  ),
  elsewhere: msg(
    'Another workspace already receives the notes of this installation. Disconnect it there, or install the App on another account.',
  ),
  refused: msg(
    'GitHub was not connected: your GitHub account does not reach this installation. Ask an owner of the organisation to connect it.',
  ),
  forbidden: msg('Only an owner or an admin of the workspace adds a connector.'),
  suspended: WORKSPACE_SUSPENDED,
  'unauthorized-app': msg(
    'GitHub was not connected: the GitHub App of this Fruitback is not set up correctly. Contact the operator of this Fruitback.',
  ),
  failed: msg('GitHub was not connected. Start again from « Connect ».'),
  unstarted: msg(
    'GitHub sent you back without a start from this workspace, so nothing was connected. If you installed the App on github.com, press « Connect » here and choose the same account.',
  ),
};

/** What the start of the way to GitHub can be refused for. */
const GITHUB_START_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace adds a connector.'),
  'connectors-unavailable': msg('This Fruitback has no GitHub App. Its operator must set one up.'),
};

/** The panel of each kind of source. A connector of a plugin has the panel of every plugin (FRU-621). */
const PANELS: Record<Connector['kind'], (props: PanelProps) => ReactNode> = {
  linear: LinearPanel,
  rest: RestPanel,
  github: GithubPanel,
  'claude-routine': RoutinePanel,
  ...(Object.fromEntries(PLUGIN_KINDS.map((kind) => [kind, PluginPanel])) as Record<
    PluginKind,
    (props: PanelProps) => ReactNode
  >),
};

/** A plugin the worker has (FRU-621), and how it connects there: by OAuth, by a token, or both. */
type PluginOffer = { kind: string; oauth: boolean; token: boolean };

/** The way back from the service of a plugin, as the address says it: `?jira=declined`. */
function pluginReturn(search: URLSearchParams): { kind: PluginKind; word: string } | undefined {
  for (const kind of PLUGIN_KINDS) {
    const word = search.get(kind);
    if (word !== null) return { kind, word };
  }

  return undefined;
}

/** The id of the title of the open panel. */
const PANEL_TITLE = 'source-panel-title';

/** The id of the title « Your connectors ». */
const CONNECTED_TITLE = 'connected-title';

export default function Connectors() {
  useLocale();
  const { workspace, failingRead } = useWorkspace();
  const base = `/console/workspaces/${workspace.id}`;
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const [connectors, setConnectors] = useState<Connector[] | undefined>();
  const [available, setAvailable] = useState(true);
  // Whether this worker has a Linear application: the consent at Linear then takes the place of a key.
  const [oauth, setOauth] = useState(false);
  // Whether this worker has the GitHub App (FRU-360): only then does « Connect » go to GitHub.
  const [githubApp, setGithubApp] = useState(false);
  const [search, setSearch] = useSearchParams();
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(LINEAR_RETURNS[search.get('linear') ?? '']);
  const [githubProblem, setGithubProblem] = useState<string | undefined>(GITHUB_RETURNS[search.get('github') ?? '']);
  // FRU-621: the plugins of the worker, and a word of the way back from one of them, or of its start.
  const [plugins, setPlugins] = useState<readonly PluginOffer[]>([]);
  const [pluginProblem, setPluginProblem] = useState<{ kind: PluginKind; problem: string } | undefined>(() => {
    const back = pluginReturn(search);
    const problem = back === undefined ? undefined : PLUGIN_RETURNS[back.word];

    return back === undefined || problem === undefined ? undefined : { kind: back.kind, problem };
  });
  const [leavingFor, setLeavingFor] = useState<PluginKind | undefined>();
  const [toGithub, setToGithub] = useState(false);
  const [sites, setSites] = useState<Listed<Site>>('loading');
  // What did not reach each connector that receives. One that is not in it was not read: no list is not
  // an empty list, so its health then says that it was not read, never « Healthy ».
  const [late, setLate] = useState<Readonly<Record<string, Late>>>({});
  // A read that failed is not an empty list (FRU-162): no « 0 site », and a way to read again.
  const [unread, setUnread] = useState(false);
  // A list of the sends that wait was not read for some connector (FRU-690): said with « Try again ».
  const [healthUnread, setHealthUnread] = useState(false);
  // The connector whose settings are open, in their dialog (FRU-690).
  const [selected, setSelected] = useState<string | undefined>();
  // FRU-633: the word of the way back from a new consent for one connector, for its panel, once.
  const [back, setBack] = useState<{ connector: string; word: string } | undefined>();
  // The form of a source that is open, in its tile of the catalogue, which then takes the whole row.
  const [adding, setAdding] = useState<Connector['kind'] | undefined>();
  // An address connected from its form, whose secret is still on the screen (see `AddRest`).
  const restAdded = useRef<string | undefined>(undefined);
  const searchField = useRef<HTMLInputElement>(null);
  // « Retry » of a row: the connector whose sends are asked again, and a refusal of it.
  const [retrying, setRetrying] = useState<string | undefined>();
  const [retryProblem, setRetryProblem] = useState<{ connector: string; problem: string } | undefined>();
  // The bar of the frame counts the sends that wait (FRU-690). A ref: a new function each render of the
  // frame must not read the list again.
  const reportFailing = useRef(failingRead);
  reportFailing.current = failingRead;

  const load = useCallback(async () => {
    const [listed, placed] = await Promise.all([
      call<{
        connectors: Connector[];
        available: boolean;
        linearOAuth?: boolean;
        githubApp?: boolean;
        trackers?: PluginOffer[];
      }>('GET', `${base}/connectors`),
      // The sites and where they send, with no count of their notes (FRU-497).
      call<{ sites: Site[] }>('GET', `${base}/sites?counts=none`),
    ]);
    // A failed read keeps what the screen already showed, and says it could not read.
    if (listed.ok) {
      setConnectors(listed.data.connectors);
      setAvailable(listed.data.available);
      setOauth(listed.data.linearOAuth === true);
      setGithubApp(listed.data.githubApp === true);
      setPlugins(Array.isArray(listed.data.trackers) ? listed.data.trackers : []);
    }
    setUnread(!listed.ok || !placed.ok);

    const read = listedOf(placed, (data) => data.sites);
    setSites((current) => (read === 'failed' && typeof current !== 'string' ? current : read));

    // The sends that wait, for the health of each connector that receives. A read that fails is said
    // above the table, and its row says that its health was not read.
    if (listed.ok) {
      const counts = await Promise.all(
        listed.data.connectors.filter(receives).map(async (connector) => {
          const read = await call<{ deliveries: Delivery[] }>('GET', `${base}/connectors/${connector.id}/deliveries`);

          if (!read.ok || !Array.isArray(read.data?.deliveries)) return undefined;
          // FRU-468: a call of a trigger of a site is counted apart from a note.
          const calls = read.data.deliveries.filter((delivery) => delivery.event === 'agent.requested').length;
          const ids = read.data.deliveries.map((delivery) => delivery.id);

          return [connector.id, { notes: ids.length - calls, calls, ids }] as const;
        }),
      );
      const found = counts.filter((count) => count !== undefined);
      setLate(Object.fromEntries(found));
      setHealthUnread(found.length < counts.length);
      // The red count of « Connectors » in the bar: every send that waits, as it was read.
      reportFailing.current(found.reduce((sum, [, each]) => sum + each.notes + each.calls, 0));
    }

    return { found: listed.ok ? listed.data.connectors : [], adds: listed.ok && listed.data.available };
  }, [base]);
  /** The same read, for a panel that only needs it done. */
  const reload = useCallback(async (): Promise<void> => void (await load()), [load]);

  useEffect(() => {
    void load().then(({ found, adds }) => {
      // Back from Linear or GitHub with a new connector: its settings open, and the word leaves the address.
      const linear = search.get('linear');
      const github = search.get('github');
      const plugin = pluginReturn(search);
      const asked = search.get('new') !== null;
      // FRU-633: the settings of one connector open, from a new consent or from a link of the extension.
      const opened = search.get('connector');
      if (linear === null && github === null && plugin === undefined && !asked && opened === null) return;
      if (opened !== null && found.some((each) => each.id === opened)) {
        setSelected(opened);
        if (linear !== null) setBack({ connector: opened, word: linear });
      }
      if (plugin?.word === 'connected') setSelected(found.filter((each) => each.kind === plugin.kind).at(-1)?.id);
      // `?new` (« Connect a tracker » of the Sites screen) leads to the search of the catalogue, for a
      // person who can add a source.
      if (asked && manages && adds) toCatalogue();
      if (linear === 'connected') setSelected(found.at(-1)?.id);
      // An installation again keeps its connector, which is then not the last of the list.
      if (github === 'connected') setSelected(found.filter((each) => each.kind === 'github').at(-1)?.id);
      setSearch({}, { replace: true });
    });
    // Once, when the screen opens: the word in the address is read one time.
  }, [load]);

  /** The search of the catalogue takes focus, and the page shows it. */
  function toCatalogue() {
    // After the paint: the catalogue appears with the list that was just read.
    window.requestAnimationFrame(() => {
      const field = searchField.current;
      if (field === null) return;
      field.focus({ preventScroll: true });
      document.getElementById(ADD_TITLE)?.scrollIntoView({ block: 'start' });
    });
  }

  /** The worker says where to go, and the browser goes there: the consent is at Linear. */
  async function connectLinear() {
    setLeaving(true);
    setProblem(undefined);
    const asked = await call<{ url: string }>('POST', `${base}/connectors/linear/oauth`);
    if (asked.ok) return window.location.assign(asked.data.url);
    setLeaving(false);
    setProblem(
      KEY_PROBLEMS[asked.error] ??
        writeProblemOf(asked, msg('Fruitback could not start the connection to Linear. Try again.')),
    );
  }

  /** The worker says where to go, and the browser goes there: the installation is at GitHub. */
  async function connectGithub() {
    setToGithub(true);
    setGithubProblem(undefined);
    const asked = await call<{ url: string }>('POST', `${base}/connectors/github/start`);
    if (asked.ok) return window.location.assign(asked.data.url);
    setToGithub(false);
    setGithubProblem(
      problemOf(asked, GITHUB_START_PROBLEMS, msg('Fruitback could not start the connection to GitHub. Try again.')),
    );
  }

  /** « Retry » of a row: each send that waits is asked again, then the health is read again. */
  async function retry(connector: Connector, ids: readonly string[]) {
    setRetrying(connector.id);
    setRetryProblem(undefined);
    const asked = await Promise.all(
      ids.map((id) => call('POST', `${base}/connectors/${connector.id}/deliveries/${id}/retry`)),
    );
    const refused = asked.find((each) => !each.ok);
    if (refused !== undefined && !refused.ok) {
      setRetryProblem({
        connector: connector.id,
        problem: writeProblemOf(refused, msg('The new attempt was not started. Try again.')),
      });
    }
    await load();
    setRetrying(undefined);
  }

  const open = connectors?.find((connector) => connector.id === selected);
  const placed = known(sites);

  const Panel = open === undefined ? undefined : PANELS[open.kind];
  const cannot = !manages || !available;
  // WARNING: « Add a connector » waits for the list to be read. The list arrives above it, and its
  // buttons went down by the height of the list: a press that starts before a button moves and ends
  // after is lost. And only a list that was read says what « Connect Linear » does, the consent at
  // Linear or a key: after a read that failed the screen does not know, so it offers « Try again »
  // and no source to add.
  const answered = connectors !== undefined;
  const connected = connectors !== undefined && connectors.length > 0;

  /** A form ended: with a new source, its settings open, and the list is read again. */
  const added = (connector: Connector | undefined) => {
    setAdding(undefined);
    if (connector === undefined) return;
    setSelected(connector.id);
    void load();
  };

  /** What a tile of the catalogue offers, from what the worker said. */
  const offerOf = (entry: Entry): Offer => {
    const kind = entry.kind;
    if (kind === 'linear')
      return {
        state: 'connect',
        primary: () => (oauth ? void connectLinear() : setAdding('linear')),
        busy: leaving ? t('Going to Linear…') : undefined,
        ...(oauth ? { secondary: { label: t('Use an API key'), act: () => setAdding('linear') } } : {}),
      };
    if (kind === 'github')
      return githubApp
        ? {
            state: 'connect',
            primary: () => void connectGithub(),
            busy: toGithub ? t('Going to GitHub…') : undefined,
          }
        : { state: 'unset', why: t('The operator of this Fruitback has not set up the GitHub App.') };
    if (kind === 'rest') return { state: 'connect', primary: () => setAdding('rest') };
    if (kind === 'claude-routine') return { state: 'connect', primary: () => setAdding('claude-routine') };
    if (!isPluginKind(kind)) return { state: 'soon' };
    const tracker = trackerOf(kind);
    const offer = plugins.find((each) => each.kind === kind);
    // A plugin that this worker does not have, or that this console does not draw yet.
    if (tracker === undefined || offer === undefined) return { state: 'soon' };
    const name = t(KINDS[kind].name);
    const byToken = offer.token && tracker.tokenFields !== undefined;
    if (!offer.oauth && !byToken)
      return { state: 'unset', why: t('The operator of this Fruitback has not set up {source}.', { source: name }) };

    return {
      state: 'connect',
      primary: () => {
        if (!offer.oauth) return setAdding(kind);
        setLeavingFor(kind);
        setPluginProblem(undefined);
        void leaveForPlugin(base, tracker).then((failed) => {
          setLeavingFor(undefined);
          if (failed !== undefined) setPluginProblem({ kind, problem: failed });
        });
      },
      busy: leavingFor === kind ? t('Going to {source}…', { source: name }) : undefined,
      ...(offer.oauth && byToken ? { secondary: { label: t('Use a token'), act: () => setAdding(kind) } } : {}),
    };
  };

  /** The form of a source, in its tile. */
  const formOf = (kind: LogoKind): ReactNode => {
    if (kind === 'linear') return <AddLinear key="form" base={base} onDone={added} />;
    if (kind === 'claude-routine') return <AddRoutine key="form" base={base} onDone={added} />;
    if (kind === 'rest')
      return (
        <AddRest
          key="form"
          base={base}
          // The new address is in the table at once; its secret stays in the form until « I kept it ».
          onAdded={(connector) => {
            restAdded.current = connector.id;
            void load();
          }}
          onDone={() => {
            const id = restAdded.current;
            restAdded.current = undefined;
            setAdding(undefined);
            // « I kept it » opens the settings of the new address; « Cancel » closes the form only.
            if (id !== undefined) setSelected(id);
          }}
        />
      );
    const tracker = isPluginKind(kind) ? trackerOf(kind) : undefined;

    return tracker === undefined ? null : <AddPlugin key="form" base={base} tracker={tracker} onDone={added} />;
  };

  /**
   * What opens in a tile under its line: the form of its source, or why it did not connect. Nothing
   * is `[]`: the tile then keeps its one line.
   */
  const underOf = (kind: LogoKind): ReactNode[] => {
    const tracker = isPluginKind(kind) ? trackerOf(kind) : undefined;
    const form = adding === kind ? formOf(kind) : null;
    let said: ReactNode = null;
    if (kind === 'linear' && problem !== undefined) said = t(problem);
    if (kind === 'github' && githubProblem !== undefined) said = t(githubProblem);
    if (tracker !== undefined && pluginProblem?.kind === kind) said = pluginSentence(pluginProblem.problem, tracker);

    return [...(form === null ? [] : [form]), ...(said === null ? [] : [<Problem key="problem">{said}</Problem>])];
  };

  return (
    <>
      <PageHead
        title={t('Connectors')}
        lead={t('Connect a tracker once. Every site of {workspace} can then send its notes there.', {
          workspace: workspace.name,
        })}
        {...(connected && !cannot
          ? {
              // FRU-690: the catalogue is on the page; « New connector » leads to its search.
              action: <Button onClick={toCatalogue}>{t('New connector')}</Button>,
            }
          : {})}
      />
      {/* FRU-690: the settings of a connector, in a dialog, where they were an accordion under its row. */}
      <Dialog
        open={open !== undefined && Panel !== undefined}
        onClose={() => setSelected(undefined)}
        title={open === undefined ? '' : connectorName(open)}
        closeLabel={t('Close')}
        className="sm:max-w-[760px]"
      >
        {open === undefined || Panel === undefined ? null : (
          <div id={PANEL} role="region" aria-label={`${connectorName(open)} · ${sourceLine(open)}`}>
            <ConnectorName base={base} connector={open} manages={manages} onRenamed={reload} />
            <Panel
              id={PANEL_TITLE}
              base={base}
              connector={open}
              connectors={connectors ?? []}
              sites={sites}
              manages={manages}
              onChanged={reload}
              onRemoved={() => {
                setSelected(undefined);
                void load();
              }}
              {...(back?.connector === open.id ? { back: back.word } : {})}
            />
          </div>
        )}
      </Dialog>
      <div className="flex min-w-0 flex-col gap-[32px]">
        {unread || healthUnread ? (
          <div className="flex flex-wrap items-center gap-[12px]">
            <p role="alert" className="min-w-0 flex-1 text-small text-muted">
              {unread
                ? t('The connectors and their sites did not load.')
                : t('The health of some connectors did not load.')}{' '}
              <ReadProblem />
            </p>
            <Button tone="outline" onClick={() => void reload()}>
              {t('Try again')}
            </Button>
          </div>
        ) : null}
        {connectors === undefined && !unread ? <p className="text-small text-muted">{t('Loading…')}</p> : null}

        {connected ? (
          <section aria-labelledby={CONNECTED_TITLE}>
            <h2
              id={CONNECTED_TITLE}
              tabIndex={-1}
              className="mb-[10px] flex items-center gap-[6px] text-body leading-auto font-semibold focus:outline-none"
            >
              {t('Your connectors')}
              <span className="font-normal text-muted tabular-nums">{connectors.length}</span>
            </h2>
            {retryProblem === undefined ? null : (
              <div className="mb-[10px]">
                <Problem>{t(retryProblem.problem)}</Problem>
              </div>
            )}
            <ConnectorsTable
              connectors={connectors}
              selected={selected}
              sites={placed}
              late={late}
              manages={manages}
              retrying={retrying}
              onRetry={(connector, ids) => void retry(connector, ids)}
              onOpen={setSelected}
            />
            {/* FRU-595: the recipes start from the issue of a note, so they come with a tracker that makes one. */}
            <NoCodeRecipes kinds={connectors.map((connector) => connector.kind)} />
          </section>
        ) : null}

        {answered ? (
          <Catalogue
            connected={connected}
            manages={manages}
            available={available}
            adding={adding}
            connectedKinds={(connectors ?? []).map((connector) => connector.kind)}
            offerOf={offerOf}
            underOf={underOf}
            searchRef={searchField}
          />
        ) : null}
      </div>
    </>
  );
}

/** The id of the open panel. */
const PANEL = 'source-panel';
