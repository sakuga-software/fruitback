import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Connector, type Delivery, type Site, call, placesOf } from '../api';
import { type Listed, known, listedOf } from '../listed';
import { Button, DataTable, Dialog, Field, IconButton, Menu, Problem, ViewTab, folded } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { WORKSPACE_SUSPENDED, problemOf, writeProblemOf } from '../problems';
import { useLocale } from '../use-locale';
import { AddLinear, AddRest, AddRoutine } from '../parts/connector-add';
import { GithubPanel } from '../parts/connector-github';
import { LinearPanel } from '../parts/connector-linear';
import { ConnectorName } from '../parts/connector-name';
import { KEY_PROBLEMS, KINDS, type PanelProps, connectorName, siteCount, sourceLine } from '../parts/connector-parts';
import { RestPanel } from '../parts/connector-rest';
import { AddPlugin, PLUGIN_RETURNS, PluginPanel, leaveForPlugin, pluginSentence } from '../parts/connector-plugin';
import { trackerOf } from '../trackers/index.ts';
import { PLUGIN_KINDS, type PluginKind, isPluginKind } from '../trackers/plugin.ts';
import { RoutinePanel } from '../parts/connector-routine';
import { NoCodeRecipes } from '../parts/agent-recipes';
import { ConnectorLogo } from '../connector-logos';
import type { LogoKind } from '../connector-logo-kinds.ts';
import { NoteIcon } from '../note-icons';
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

/** A group of the catalogue: the segment above the tiles (FRU-690). */
type Group = 'trackers' | 'agents' | 'developers';

/** What a tile of the catalogue says before it is connected: what a note becomes there, in one line. */
type Entry = { kind: LogoKind; name: string; short: string; group: Group; fresh?: true };

/**
 * The catalogue, in the order of the mockup of FRU-690. `name` is the name of the kind where it can
 * be connected, so a tile and a row say the same; `short` is the one line of the tile, and the long
 * sentence of the kind is its tooltip.
 */
const CATALOGUE: readonly Entry[] = [
  { kind: 'linear', name: KINDS.linear.name, short: msg('An issue in a team'), group: 'trackers' },
  { kind: 'jira', name: KINDS.jira.name, short: msg('An issue in a project'), group: 'trackers' },
  { kind: 'github', name: KINDS.github.name, short: msg('An issue in a repository'), group: 'trackers' },
  { kind: 'gitlab', name: KINDS.gitlab.name, short: msg('An issue in a project'), group: 'trackers' },
  { kind: 'asana', name: KINDS.asana.name, short: msg('A task in a project'), group: 'trackers' },
  { kind: 'clickup', name: KINDS.clickup.name, short: msg('A task in a list'), group: 'trackers' },
  { kind: 'trello', name: 'Trello', short: msg('A card on a board'), group: 'trackers' },
  { kind: 'notion', name: 'Notion', short: msg('A row in a database'), group: 'trackers' },
  { kind: 'slack', name: KINDS.slack.name, short: msg('A message in a channel'), group: 'trackers' },
  { kind: 'webhook', name: msg('Webhook'), short: msg('Tells any address when a note arrives'), group: 'developers' },
  { kind: 'rest', name: KINDS.rest.name, short: msg('A POST to your endpoint'), group: 'developers' },
  {
    kind: 'claude-routine',
    name: KINDS['claude-routine'].name,
    short: msg('A routine of your team starts'),
    group: 'agents',
    fresh: true,
  },
];

/** The long sentence of a kind that this console connects, for the tooltip of its tile. */
const DETAILS: Readonly<Partial<Record<LogoKind, string>>> = {
  linear: msg('An issue per note, in the team you choose.'),
  // FRU-331: the API of an issue of GitHub takes no file, so the files of a note do not go there.
  github: msg('An issue per note, in one repository. The files of a note do not go: GitHub takes none by its API.'),
  rest: msg('POST each note to your own endpoint, with an address of one hour for each of its files.'),
  'claude-routine': msg(
    'Starts a routine of your team when the trigger of a site calls it. The routine reads the notes through the MCP server.',
  ),
  trello: msg('A card in the list you choose.'),
  notion: msg('A row in a database.'),
  webhook: msg('Tells Slack or any address when a note arrives.'),
};

/** The segment of the catalogue: every tile, or one group. */
const GROUPS: readonly { id: Group | 'all'; label: string }[] = [
  { id: 'all', label: msg('All kinds') },
  { id: 'trackers', label: msg('Trackers') },
  { id: 'agents', label: msg('Agents') },
  { id: 'developers', label: msg('Developers') },
];

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

/**
 * Whether a connector receives each note, and so has a list of the sends that wait: an address, a
 * routine (FRU-594), and a plugin that keeps nothing (FRU-624, Slack). A tracker has none.
 */
function receives(connector: Connector): boolean {
  if (connector.kind === 'rest' || connector.kind === 'claude-routine') return true;

  return isPluginKind(connector.kind) && trackerOf(connector.kind)?.receives === true;
}

/** The id of the title of the open panel. */
const PANEL_TITLE = 'source-panel-title';

/** The id of the title « Your connectors ». */
const CONNECTED_TITLE = 'connected-title';

/** The id of the title « Add a connector ». */
const ADD_TITLE = 'add-title';

/** What did not reach a connector that receives: notes, and calls of a trigger of a site (FRU-468). */
type Late = { notes: number; calls: number; ids: readonly string[] };

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
  // The search and the segment of the catalogue (FRU-690).
  const [typed, setTyped] = useState('');
  const [group, setGroup] = useState<Group | 'all'>('all');
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
  /** The sites that send to a connector, from a list that was read. */
  const sitesOf = (connector: Connector): readonly Site[] | undefined =>
    placed?.filter((site) => placesOf(site).some((place) => place.connector === connector.id));

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

  const shownEntries = CATALOGUE.filter(
    (entry) =>
      (group === 'all' || entry.group === group) &&
      (typed.trim() === '' ||
        [t(entry.name), t(entry.short), detailOf(entry.kind)].some((words) =>
          folded(words).includes(folded(typed.trim())),
        )),
  );

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
            <DataTable label={t('Your connectors')} minWidth={680} dense hover stack>
              {/* Widths of their own: a health that changes after « Retry » moves no column. */}
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[32%]" />
                <col className="w-[12%]" />
                <col className="w-[20%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{t('Connector')}</th>
                  <th scope="col">{t('Account')}</th>
                  <th scope="col">{t('Used by')}</th>
                  <th scope="col">{t('Health')}</th>
                  <th scope="col" data-align="end">
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((connector) => {
                  const name = connectorName(connector);
                  const waits = late[connector.id];
                  const using = sitesOf(connector);
                  const failed = waits !== undefined && waits.notes + waits.calls > 0;

                  return (
                    <tr
                      key={connector.id}
                      data-connector={connector.id}
                      data-chosen={connector.id === selected}
                      className="cursor-pointer"
                      // A press on the row opens its settings, as « … » does: the button is the way of a
                      // keyboard and of a screen reader, and a press on a button of the row is its own.
                      onClick={(event) => {
                        if ((event.target as Element).closest('button, a') !== null) return;
                        setSelected(connector.id);
                      }}
                    >
                      <td>
                        <span className="flex min-w-0 items-center gap-[10px]">
                          <ConnectorLogo kind={connector.kind} size="row" />
                          {/* The name its workspace gave it, or its kind (FRU-404). */}
                          <span className="min-w-0 truncate font-semibold">{name}</span>
                        </span>
                      </td>
                      <td className="max-w-[320px]">
                        {/* One line: a long address is cut at its end, and the settings write it whole (FRU-321). */}
                        <span className="block truncate text-ink-soft" title={lineOf(connector)} data-source-line>
                          {lineOf(connector)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-muted">
                        {/* FRU-594: no site sends its notes to a routine, so its row counts none. */}
                        {using === undefined || connector.kind === 'claude-routine' ? null : siteCount(using.length)}
                      </td>
                      <td>
                        <Health
                          connector={connector}
                          late={waits}
                          read={!receives(connector) || waits !== undefined}
                          placeAttention={using?.some((site) =>
                            placesOf(site).some(
                              (place) => place.connector === connector.id && place.attention !== undefined,
                            ),
                          )}
                        />
                      </td>
                      <td data-align="end">
                        <span className="inline-flex items-center justify-end gap-[4px]">
                          {failed && manages ? (
                            <Button
                              tone="outline"
                              size="small"
                              disabled={retrying === connector.id}
                              label={t('Retry {name}', { name })}
                              onClick={() => void retry(connector, waits.ids)}
                            >
                              <NoteIcon name="retry" />
                              {retrying === connector.id ? t('Retrying…') : t('Retry')}
                            </Button>
                          ) : null}
                          <IconButton
                            size="small"
                            label={t('Settings of {name}', { name })}
                            onClick={() => setSelected(connector.id)}
                          >
                            <NoteIcon name="more" />
                          </IconButton>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
            {/* FRU-595: the recipes start from the issue of a note, so they come with a tracker that makes one. */}
            <NoCodeRecipes kinds={connectors.map((connector) => connector.kind)} />
          </section>
        ) : null}

        {answered ? (
          <section aria-labelledby={ADD_TITLE}>
            <div className="mb-[10px] flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
              <h2 id={ADD_TITLE} className="text-body leading-auto font-semibold">
                {t('Add a connector')}
              </h2>
              <div className="w-[220px] min-w-0 flex-shrink">
                <Field
                  label={t('Search trackers and tools')}
                  labelHidden
                  compact
                  type="search"
                  inputRef={searchField}
                  placeholder={t('Search trackers and tools')}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </div>
              <div role="group" aria-label={t('Kind of connector')} className="ml-auto flex flex-wrap gap-[2px]">
                {GROUPS.map((each) => (
                  <ViewTab key={each.id} pressed={group === each.id} onChange={() => setGroup(each.id)}>
                    {t(each.label)}
                  </ViewTab>
                ))}
              </div>
            </div>
            {connected ? null : (
              <p className="mb-[10px] text-hint text-muted">{t('No tracker yet. The notes stay in Fruitback.')}</p>
            )}
            {manages ? null : (
              <p className="mb-[10px] text-hint text-muted">{t('An owner or an admin adds a connector')}</p>
            )}
            {available ? null : (
              <p className="mb-[10px] text-hint text-muted">{t(KEY_PROBLEMS['connectors-unavailable'] ?? '')}</p>
            )}
            {shownEntries.length === 0 ? (
              <p className="text-small text-muted" role="status">
                {t('No connector matches « {search} ».', { search: typed.trim() })}
              </p>
            ) : (
              // FRU-690: tiles of 64 px, four in a row at 1440 px, one at 390 px. A tile whose form is
              // open, or that says why it did not connect, takes the whole row.
              <ul className="grid grid-flow-row-dense grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-[10px]">
                {shownEntries.map((entry) => {
                  const under = underOf(entry.kind);
                  const isConnected = connectors?.some((connector) => connector.kind === entry.kind) === true;

                  return (
                    <Tile
                      key={entry.kind}
                      entry={entry}
                      detail={detailOf(entry.kind)}
                      offer={offerOf(entry)}
                      connected={isConnected}
                      cannot={cannot}
                      typing={adding === entry.kind}
                      under={under}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </>
  );
}

/** The long sentence of a kind: its own, or the one of its plugin (FRU-621). */
function detailOf(kind: LogoKind): string {
  const own = DETAILS[kind];
  if (own !== undefined) return t(own);
  const tracker = isPluginKind(kind) ? trackerOf(kind) : undefined;

  return tracker === undefined ? '' : t(tracker.detail);
}

/** The account of a source, in its row: its kind first when a name hides it (FRU-404). */
function lineOf(connector: Connector): string {
  return connector.name === undefined
    ? sourceLine(connector)
    : `${t(KINDS[connector.kind].name)} · ${sourceLine(connector)}`;
}

/** What a tile offers: a way to connect, a source that is not set up here, or one that comes later. */
type Offer =
  | {
      state: 'connect';
      primary: () => void;
      /** The words of the button while the browser leaves for the service. */
      busy?: string | undefined;
      /** A second way: an API key or a token where the consent is the first one. */
      secondary?: { label: string; act: () => void };
    }
  | { state: 'unset'; why: string }
  | { state: 'soon' };

/** The words of a state pill: a dot and a word, in a tint of its colour. */
function Pill({ tone, children }: { tone: 'done' | 'alert' | 'neutral'; children: ReactNode }) {
  const colours = {
    done: 'bg-done/10 text-done',
    alert: 'bg-accent/10 text-accent-strong',
    neutral: 'bg-chip text-muted',
  }[tone];
  const dot = { done: 'bg-done', alert: 'bg-accent', neutral: 'bg-control' }[tone];

  return (
    <span
      className={`inline-flex h-[20px] flex-none items-center gap-[5px] rounded-control px-[7px] text-hint leading-none font-semibold whitespace-nowrap ${colours}`}
      data-pill={tone}
    >
      <span aria-hidden="true" className={`size-[6px] flex-none rounded-pill ${dot}`} />
      {children}
    </span>
  );
}

/**
 * The health of a connector, in its row (FRU-690), from what the worker says today:
 *
 * - « Needs attention »: its tracker refuses it (FRU-102), or refused a place of a site (FRU-640).
 * - « N not delivered »: sends that wait, for a connector that receives (an address, a routine, Slack).
 * - « Healthy »: a connector that receives, whose sends were read, and none waits.
 * - « Connected »: a tracker. The worker does not say yet whether its notes arrived (FRU-714).
 * - « Not read »: the sends of a connector that receives were not read. Never « Healthy ».
 *
 * The red words are the strong accent: the accent is under 4.5:1 on the tints of a row (FRU-683).
 */
function Health({
  connector,
  late,
  read,
  placeAttention = false,
}: {
  connector: Connector;
  late: Late | undefined;
  /** Whether the sends of a connector that receives were read. A tracker has none to read. */
  read: boolean;
  placeAttention?: boolean | undefined;
}) {
  useLocale();
  if (connector.attention !== undefined || placeAttention) return <Pill tone="alert">{t('Needs attention')}</Pill>;
  if (!read) return <Pill tone="neutral">{t('Not read')}</Pill>;
  if (late === undefined) return <Pill tone="done">{t('Connected')}</Pill>;
  const waiting = late.notes + late.calls;
  if (waiting === 0) return <Pill tone="done">{t('Healthy')}</Pill>;

  return (
    <span className="inline-flex flex-wrap gap-[4px]">
      {late.notes > 0 ? (
        <Pill tone="alert">
          {late.notes === 1 ? t('1 note not delivered') : t('{count} notes not delivered', { count: late.notes })}
        </Pill>
      ) : null}
      {/* FRU-468: a call that waits is said too: its agent did not start. */}
      {late.calls > 0 ? (
        <Pill tone="alert">
          {late.calls === 1 ? t('1 call not delivered') : t('{count} calls not delivered', { count: late.calls })}
        </Pill>
      ) : null}
    </span>
  );
}

/** « Connect », with the name of the source for a screen reader: twelve buttons would say the same word. */
function Connect({ name }: { name: string }) {
  useLocale();

  return (
    <>
      {t('Connect')}
      <span className="sr-only"> {name}</span>
    </>
  );
}

/**
 * A tile of the catalogue (FRU-690): the logo in its box of 36 px, the name, one line of what a note
 * becomes there, cut at its end, and the state at the right: « Connected », « Connect », « Soon »,
 * or « Not set up ». A tile that is open (its form, a refusal) takes the whole row, and what opened
 * is under its line.
 */
function Tile({
  entry,
  detail,
  offer,
  connected,
  cannot,
  typing,
  under,
}: {
  entry: Entry;
  detail: string;
  offer: Offer;
  connected: boolean;
  /**
   * The person cannot add a source here: a member, or a worker that cannot keep a key. The tile then
   * offers no button: a line above the tiles says why, and a disabled button would say nothing more.
   */
  cannot: boolean;
  /** Its form is open. */
  typing: boolean;
  /** What opened under its line, or nothing. */
  under: readonly ReactNode[];
}) {
  useLocale();
  const name = t(entry.name);
  const wide = under.length > 0;
  const why = offer.state === 'unset' ? offer.why : undefined;

  return (
    <li
      className={`flex min-w-0 flex-col rounded-card border border-line bg-surface px-[14px] ${wide ? 'col-span-full pb-[14px]' : ''}`}
      data-source={name}
      data-state={connected ? 'connected' : offer.state}
    >
      <div className="flex h-[62px] min-w-0 items-center gap-[12px]">
        <ConnectorLogo kind={entry.kind} />
        <span className="flex min-w-0 flex-1 flex-col gap-[4px]" title={detail === '' ? undefined : detail}>
          <span className="flex min-w-0 items-center gap-[6px]">
            <span className="truncate text-body leading-auto font-semibold">{name}</span>
            {entry.fresh === true && !connected ? <Pill tone="alert">{t('New')}</Pill> : null}
          </span>
          {/* One line, cut at its end; the whole sentence is the tooltip. */}
          <span className="truncate text-hint leading-auto text-muted" data-tile-line>
            {why ?? t(entry.short)}
          </span>
        </span>
        <span className="flex flex-none items-center gap-[4px]">
          {connected ? <Pill tone="done">{t('Connected')}</Pill> : null}
          {offer.state === 'soon' && !connected ? <Pill tone="neutral">{t('Soon')}</Pill> : null}
          {offer.state === 'unset' && !connected ? <Pill tone="neutral">{t('Not set up')}</Pill> : null}
          {/* A workspace can connect a second one: another team of Linear, another address. */}
          {offer.state === 'connect' && !cannot && !typing && connected ? (
            <IconButton
              size="small"
              label={t('Connect another {source}', { source: name })}
              disabled={offer.busy !== undefined}
              onClick={offer.primary}
            >
              <NoteIcon name="add" />
            </IconButton>
          ) : null}
          {offer.state === 'connect' && !cannot && !typing && !connected ? (
            <>
              <Button tone="outline" size="small" disabled={offer.busy !== undefined} onClick={offer.primary}>
                {offer.busy ?? <Connect name={name} />}
              </Button>
              {offer.secondary === undefined ? null : (
                <Menu
                  trigger="icon"
                  triggerLabel={t('Other ways to connect {source}', { source: name })}
                  triggerClassName="size-control-sm!"
                  items={[{ id: 'secondary', label: offer.secondary.label }]}
                  onAction={() => offer.secondary?.act()}
                >
                  <NoteIcon name="down" />
                </Menu>
              )}
            </>
          ) : null}
        </span>
      </div>
      {wide ? <div className="flex w-full flex-col gap-[10px]">{under}</div> : null}
    </li>
  );
}

/** The id of the open panel. */
const PANEL = 'source-panel';
