import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Connector, type Delivery, type Site, call, placesOf } from '../api';
import { type Listed, known, listedOf } from '../listed';
import { Button, LinkButton, Problem } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { WORKSPACE_SUSPENDED, problemOf, writeProblemOf } from '../problems';
import { useLocale } from '../use-locale';
import { AddLinear, AddRest } from './connector-add';
import { GithubPanel } from './connector-github';
import { LinearPanel } from './connector-linear';
import { ConnectorName } from './connector-name';
import {
  KEY_PROBLEMS,
  KINDS,
  type PanelProps,
  SourceMark,
  connectorName,
  siteCount,
  sourceLine,
} from './connector-parts';
import { RestPanel } from './connector-rest';
import type { LaterKind, MarkedKind } from '../connector-marks';

/**
 * The sources of a workspace, as screen 11 of the mockup of 2026-10-13 draws them (FRU-246): the
 * sources that are connected, the ones to add, and the panel of the source that is chosen. The panel
 * opens under its row at every width, as an accordion (FRU-403), where the mockup draws a column.
 *
 * Linear connects with OAuth or an API key (FRU-121, FRU-134), GitHub with its App where the worker
 * has one (FRU-361), and an address of the workspace's own receives each note (FRU-132). The other
 * sources are listed where the mockup puts them, and say that they are not there yet: no button
 * connects what does not exist.
 */
const LATER = [
  { kind: 'jira', name: 'Jira', detail: msg('An issue in a Jira Cloud project.') },
  { kind: 'gitlab', name: 'GitLab', detail: msg('An issue in a project, cloud or self-managed.') },
  { kind: 'trello', name: 'Trello', detail: msg('A card in the list you choose.') },
  { kind: 'notion', name: 'Notion', detail: msg('A row in a database.') },
  { kind: 'webhook', name: 'Webhook', detail: msg('Tells Slack or any address when a note arrives.') },
] as const;

/** What the way back from Linear says, as the worker words it in the address (FRU-134). */
const LINEAR_RETURNS: Record<string, string> = {
  declined: msg('Linear was not connected: the consent was refused there.'),
  forbidden: msg('Only an owner or an admin of the workspace connects a source.'),
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
  forbidden: msg('Only an owner or an admin of the workspace connects a source.'),
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
  forbidden: msg('Only an owner or an admin of the workspace connects a source.'),
  'connectors-unavailable': msg('This Fruitback has no GitHub App. Its operator must set one up.'),
};

/** The panel of each kind of source. */
const PANELS: Record<Connector['kind'], (props: PanelProps) => ReactNode> = {
  linear: LinearPanel,
  rest: RestPanel,
  github: GithubPanel,
};

/** The id of the title of the open panel. */
const PANEL_TITLE = 'source-panel-title';

/** The id of the list of the sources to add, which « New source » names in `aria-controls`. */
const CATALOGUE = 'source-catalogue';

/** The id of the title « Connected », where focus goes back when « New source » is not there. */
const CONNECTED_TITLE = 'connected-title';

export default function Connectors() {
  useLocale();
  const { workspace } = useWorkspace();
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
  const [toGithub, setToGithub] = useState(false);
  const [sites, setSites] = useState<Listed<Site>>('loading');
  // How many notes did not reach each address. An address that is not in it was not read: no list
  // is not an empty list, so its row then says « Connected » and no number.
  const [late, setLate] = useState<Readonly<Record<string, Late>>>({});
  // A read that failed is not an empty list (FRU-162): no « 0 site », and a way to read again.
  const [unread, setUnread] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  // Whether the panel that is about to appear was opened by a press of its row: see `Opened`.
  const opening = useRef(false);
  const [adding, setAdding] = useState<Connector['kind'] | undefined>();
  // FRU-542: whether « New source » opened the list of the sources to add. A way back from Linear or
  // GitHub that went wrong opens it: its sentence is under the source, in that list.
  const [catalogue, setCatalogue] = useState(problem !== undefined || githubProblem !== undefined);
  const catalogueTitle = useRef<HTMLHeadingElement>(null);
  const newSource = useRef(false);
  useEffect(() => {
    // The list that « New source » opens takes focus on its title: a screen reader says where it is.
    if (catalogue && newSource.current) catalogueTitle.current?.focus();
    newSource.current = false;
  }, [catalogue]);

  const load = useCallback(async () => {
    const [listed, placed] = await Promise.all([
      call<{ connectors: Connector[]; available: boolean; linearOAuth?: boolean; githubApp?: boolean }>(
        'GET',
        `${base}/connectors`,
      ),
      call<{ sites: Site[] }>('GET', `${base}/sites`),
    ]);
    // A failed read keeps what the screen already showed, and says it could not read.
    if (listed.ok) {
      setConnectors(listed.data.connectors);
      setAvailable(listed.data.available);
      setOauth(listed.data.linearOAuth === true);
      setGithubApp(listed.data.githubApp === true);
    }
    setUnread(!listed.ok || !placed.ok);

    const read = listedOf(placed, (data) => data.sites);
    setSites((current) => (read === 'failed' && typeof current !== 'string' ? current : read));

    // The notes that did not reach an address, for its row. A read that fails says nothing here: the
    // panel of the address says that it could not read them.
    if (listed.ok) {
      const addresses = listed.data.connectors.filter((connector) => connector.kind === 'rest');
      const counts = await Promise.all(
        addresses.map(async (connector) => {
          const read = await call<{ deliveries: Delivery[] }>('GET', `${base}/connectors/${connector.id}/deliveries`);

          if (!read.ok || !Array.isArray(read.data?.deliveries)) return undefined;
          // FRU-468: a call of a trigger of a site is counted apart from a note.
          const calls = read.data.deliveries.filter((delivery) => delivery.event === 'agent.requested').length;

          return [connector.id, { notes: read.data.deliveries.length - calls, calls }] as const;
        }),
      );
      setLate(Object.fromEntries(counts.filter((count) => count !== undefined)));
    }

    return listed.ok ? listed.data.connectors : [];
  }, [base]);
  /** The same read, for a panel that only needs it done. */
  const reload = useCallback(async (): Promise<void> => void (await load()), [load]);

  useEffect(() => {
    void load().then((found) => {
      // Back from Linear or GitHub with a new connector: its panel opens, and the word leaves the address.
      const linear = search.get('linear');
      const github = search.get('github');
      if (linear === null && github === null) return;
      if (linear === 'connected') setSelected(found.at(-1)?.id);
      // An installation again keeps its connector, which is then not the last of the list.
      if (github === 'connected') setSelected(found.filter((each) => each.kind === 'github').at(-1)?.id);
      setSearch({}, { replace: true });
    });
    // Once, when the screen opens: the word in the address is read one time.
  }, [load]);

  /**
   * « Close » of the list of the sources to add: the keyboard goes back to « New source ». A read
   * since the list opened can take that button away (a role, or a worker that cannot keep a key any
   * more): focus then goes to the title of the sources that are connected, never to the page.
   */
  function closeCatalogue() {
    setCatalogue(false);
    const back =
      document.querySelector<HTMLElement>(`[aria-controls="${CATALOGUE}"]`) ?? document.getElementById(CONNECTED_TITLE);
    back?.focus();
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

  const open = connectors?.find((connector) => connector.id === selected);
  const placed = known(sites);
  /** « · 3 sites », only from a list that was read. */
  const countOf = (connector: Connector): string =>
    placed === undefined
      ? ''
      : ` · ${siteCount(placed.filter((site) => placesOf(site).some((place) => place.connector === connector.id)).length)}`;

  const Panel = open === undefined ? undefined : PANELS[open.kind];
  const panel =
    open === undefined || Panel === undefined ? null : (
      <Opened
        key={open.id}
        label={`${connectorName(open)} · ${sourceLine(open)}`}
        takesFocus={opening}
        onClose={() => {
          setSelected(undefined);
          // The keyboard goes back where it came from: the row of the source.
          document.getElementById(rowId(open.id))?.focus();
        }}
      >
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
        />
      </Opened>
    );

  const cannot = !manages || !available;
  // WARNING: « Add a source » waits for the list to be read. The list arrives above it, and its
  // buttons went down by the height of the list (45 px for one source, 110 for two, measured): a
  // press that starts before a button moves and ends after is lost. And only a list that was read
  // says what « Connect Linear » does, the consent at Linear or a key: after a read that failed
  // the screen does not know, so it offers « Try again » and no source to add.
  const answered = connectors !== undefined;
  const connected = connectors !== undefined && connectors.length > 0;
  // FRU-542: with no source, the screen is the list of the sources to add. With one, it is the
  // sources that are connected, and « New source » opens the list above them. A form open in the
  // list keeps it open: the secret of an address is shown there once, after the address is connected.
  const listed = answered && (!connected || catalogue || adding !== undefined);
  // A person who cannot connect a source is not offered a button that opens disabled ones.
  const offersNew = connected && !cannot;

  return (
    <>
      <PageHead
        title={t('Connectors')}
        lead={t('Connect a tracker once. Every site of {workspace} can then send its notes there.', {
          workspace: workspace.name,
        })}
        {...(offersNew
          ? {
              action: (
                <Button
                  expanded={listed}
                  controls={CATALOGUE}
                  onClick={() => {
                    newSource.current = !listed;
                    setCatalogue(!listed);
                  }}
                >
                  {t('New source')}
                </Button>
              ),
            }
          : {})}
      />
      <div className="flex min-w-0 flex-col gap-[32px]">
        {unread ? (
          <div className="flex flex-wrap items-center gap-[12px]">
            <p role="alert" className="min-w-0 flex-1 text-small text-muted">
              {t('Fruitback did not answer. The sources and their sites could not be read.')}
            </p>
            <Button tone="outline" onClick={() => void reload()}>
              {t('Try again')}
            </Button>
          </div>
        ) : null}
        {connectors === undefined && !unread ? <p className="text-small text-muted">{t('Loading…')}</p> : null}

        {listed ? (
          <section
            id={CATALOGUE}
            aria-labelledby="add-title"
            // Over the sources that are connected, a frame of its own: it is not one of them.
            className={connected ? 'rounded-frame border border-line bg-surface px-[20px] pt-[16px] pb-[4px]' : ''}
          >
            <div className="mb-[10px] flex items-center justify-between gap-[12px]">
              <h2
                id="add-title"
                ref={catalogueTitle}
                tabIndex={-1}
                className="text-body leading-auto font-semibold focus:outline-none"
              >
                {t('Add a source')}
              </h2>
              {connected && adding === undefined ? (
                <LinkButton onClick={() => closeCatalogue()}>{t('Close')}</LinkButton>
              ) : null}
            </div>
            {connected ? null : (
              <p className="mb-[10px] text-hint text-muted">{t('No tracker yet. The notes stay in Fruitback.')}</p>
            )}
            {manages ? null : (
              <p className="mb-[10px] text-hint text-muted">{t('An owner or an admin connects a source')}</p>
            )}
            {available ? null : (
              <p className="mb-[10px] text-hint text-muted">{t(KEY_PROBLEMS['connectors-unavailable'] ?? '')}</p>
            )}
            <ul className="border-t border-line [&>li:last-child]:border-b-0">
              <Source
                kind="linear"
                name={t(KINDS.linear.name)}
                detail={t('An issue per note, in the team you choose.')}
              >
                {adding === 'linear' ? null : (
                  <span className="flex flex-wrap items-center gap-x-[16px]">
                    {oauth ? (
                      <LinkButton disabled={cannot} onClick={() => setAdding('linear')}>
                        {t('Use an API key')}
                      </LinkButton>
                    ) : null}
                    <Button
                      tone="outline"
                      inset={16}
                      disabled={cannot || leaving}
                      onClick={() => (oauth ? void connectLinear() : setAdding('linear'))}
                    >
                      {leaving ? t('Going to Linear…') : <Connect name={t(KINDS.linear.name)} />}
                    </Button>
                  </span>
                )}
                {adding === 'linear' ? (
                  <Under>
                    <AddLinear
                      base={base}
                      onDone={(connector) => {
                        setAdding(undefined);
                        if (connector !== undefined) {
                          setCatalogue(false);
                          setSelected(connector.id);
                          void load();
                        }
                      }}
                    />
                  </Under>
                ) : null}
                {problem === undefined ? null : (
                  <Under>
                    <Problem>{t(problem)}</Problem>
                  </Under>
                )}
              </Source>
              {/* FRU-331: the API of an issue of GitHub takes no file, so the files of a note do not go there. */}
              <Source
                kind="github"
                name={t(KINDS.github.name)}
                detail={t(
                  'An issue per note, in one repository. The files of a note do not go: GitHub takes none by its API.',
                )}
              >
                {githubApp ? (
                  <Button tone="outline" inset={16} disabled={cannot || toGithub} onClick={() => void connectGithub()}>
                    {toGithub ? t('Going to GitHub…') : <Connect name={t(KINDS.github.name)} />}
                  </Button>
                ) : (
                  <>
                    {/* A worker with no App connects no GitHub: the button says so, and connects nothing. */}
                    <Button tone="outline" inset={16} disabled>
                      {t('Not on this Fruitback')}
                    </Button>
                    <Under>
                      <p className="text-hint text-muted">
                        {t('The operator of this Fruitback has not set up the GitHub App.')}
                      </p>
                    </Under>
                  </>
                )}
                {githubProblem === undefined ? null : (
                  <Under>
                    <Problem>{t(githubProblem)}</Problem>
                  </Under>
                )}
              </Source>
              <Source
                kind="rest"
                name={t(KINDS.rest.name)}
                detail={t('POST each note to your own endpoint, with an address of one hour for each of its files.')}
              >
                {adding === 'rest' ? (
                  <Under>
                    <AddRest
                      base={base}
                      onAdded={(connector) => {
                        setSelected(connector.id);
                        void load();
                      }}
                      onDone={() => {
                        setAdding(undefined);
                        setCatalogue(false);
                      }}
                    />
                  </Under>
                ) : (
                  <Button tone="outline" inset={16} disabled={cannot} onClick={() => setAdding('rest')}>
                    <Connect name={t(KINDS.rest.name)} />
                  </Button>
                )}
              </Source>
              {LATER.map((source) => (
                <Source key={source.name} kind={source.kind} name={source.name} detail={t(source.detail)}>
                  {/* No connector of this kind exists: the button says when, and connects nothing. */}
                  <Button tone="outline" inset={16} disabled>
                    {t('After the beta')}
                  </Button>
                </Source>
              ))}
            </ul>
          </section>
        ) : null}

        {connected ? (
          <section aria-labelledby={CONNECTED_TITLE}>
            <h2
              id={CONNECTED_TITLE}
              tabIndex={-1}
              className="mb-[10px] text-body leading-auto font-semibold focus:outline-none"
            >
              {t('Connected')}
            </h2>
            {/* FRU-542: a card for each source, one under the other. Its panel opens inside its card
                (FRU-403): a panel between two cards of a grid reads as a stray card (FRU-433). */}
            <ul className="flex flex-col gap-[12px]">
              {connectors.map((connector) => {
                const chosen = connector.id === selected;

                return (
                  <li key={connector.id} className="overflow-hidden rounded-frame border border-line bg-surface">
                    <button
                      type="button"
                      aria-expanded={chosen}
                      id={rowId(connector.id)}
                      aria-controls={chosen ? PANEL : undefined}
                      onClick={() => {
                        // A person opened it, so the panel takes focus when it appears (FRU-197).
                        opening.current = !chosen;
                        setSelected(chosen ? undefined : connector.id);
                      }}
                      // Under 640 px the state goes under the address, in line with it (FRU-321).
                      className={`flex w-full cursor-pointer flex-wrap items-center gap-x-[14px] gap-y-[4px] px-[18px] py-[14px] text-left -outline-offset-2 sm:flex-nowrap ${
                        chosen ? 'bg-chip' : 'hover:bg-subtle'
                      }`}
                    >
                      <SourceMark kind={connector.kind} />
                      <span className="min-w-0 flex-1">
                        {/* The name its workspace gave it, or its kind (FRU-404). */}
                        <span className="block truncate text-body leading-auto font-semibold">
                          {connectorName(connector)}
                        </span>
                        {/* One line: a long address is cut at its end, and the panel writes it whole (FRU-321). */}
                        <span className="flex min-w-0 text-hint leading-auto text-muted" title={lineOf(connector)}>
                          <span className="min-w-0 truncate" data-source-line>
                            {lineOf(connector)}
                          </span>
                          <span className="flex-none whitespace-pre">{countOf(connector)}</span>
                        </span>
                      </span>
                      <span className="flex-none max-sm:basis-full max-sm:pl-[50px]">
                        <State connector={connector} late={late[connector.id]} chosen={chosen} />
                      </span>
                    </button>
                    {/* The accordion of the source opens under its row, inside its card (FRU-403). */}
                    {chosen ? panel : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}

/** The line under the name of a source: its kind first when a name hides it (FRU-404). */
function lineOf(connector: Connector): string {
  return connector.name === undefined
    ? sourceLine(connector)
    : `${t(KINDS[connector.kind].name)} · ${sourceLine(connector)}`;
}

/** « Connect », with the name of the source for a screen reader: seven buttons would say the same word. */
function Connect({ name }: { name: string }) {
  useLocale();

  return (
    <>
      {t('Connect')}
      <span className="sr-only"> {name}</span>
    </>
  );
}

/** A source to add: its mark, its name, what a note becomes there, and what connects it. */
function Source({
  kind,
  name,
  detail,
  children,
}: {
  kind: MarkedKind | LaterKind;
  name: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <li
      className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-b border-line py-[12px]"
      data-source={name}
    >
      <SourceMark kind={kind} />
      <span className="min-w-0 flex-[1_1_210px]">
        <span className="block text-body leading-auto font-semibold">{name}</span>
        <span className="block text-hint leading-auto text-muted">{detail}</span>
      </span>
      {children}
    </li>
  );
}

/** What opens under the row of a source to add: its form, or why it did not connect. */
function Under({ children }: { children: ReactNode }) {
  // In line with the name, past the mark, from 640 px; under the mark on a phone, where width is short.
  return <div className="w-full basis-full sm:pl-[52px]">{children}</div>;
}

/**
 * The state of a source, at the end of its row. A source is « Connected »: the list cannot know that
 * its notes arrive. An address says how many of its notes did not arrive, when the worker said so,
 * and a tracker that refuses the source needs somebody (FRU-102): the panel of the source says what
 * to do.
 *
 * On the row that is chosen the red is the strong accent: the accent is 4.28:1 on its tint.
 */
/** What did not reach an address yet: notes, and calls of a trigger of a site (FRU-468). */
type Late = { notes: number; calls: number };

function State({ connector, late, chosen }: { connector: Connector; late: Late | undefined; chosen: boolean }) {
  useLocale();
  const alert = `flex-none text-hint leading-auto font-semibold ${chosen ? 'text-accent-strong' : 'text-accent'}`;
  if (connector.attention !== undefined) return <span className={alert}>{t('Needs attention')}</span>;
  const words = [
    ...(late !== undefined && late.notes > 0
      ? [late.notes === 1 ? t('1 note did not arrive') : t('{count} notes did not arrive', { count: late.notes })]
      : []),
    // FRU-468: a call that waits is said too, also beside notes that wait: its agent did not start.
    ...(late !== undefined && late.calls > 0
      ? [
          late.calls === 1
            ? t('1 call of an agent did not arrive')
            : t('{count} calls of an agent did not arrive', { count: late.calls }),
        ]
      : []),
  ];
  if (words.length > 0) {
    return (
      <span className={`${alert} flex flex-col items-end text-right`}>
        {words.map((each) => (
          <span key={each}>{each}</span>
        ))}
      </span>
    );
  }

  return <span className="flex-none text-hint leading-auto font-semibold text-done">{t('Connected')}</span>;
}

/** The id of the open panel, which its row names in `aria-controls`. */
const PANEL = 'source-panel';

/** The id of the row of a source, which takes focus back when its panel closes. */
function rowId(connector: string): string {
  return `source-row-${connector}`;
}

/**
 * The open panel: an accordion under its row, at every width (FRU-161, FRU-403). The page scrolls as
 * little as shows it, or its top when it is taller than the screen. A row at the bottom of the screen
 * would otherwise open a panel nobody sees, and a second touch would close it.
 *
 * **A panel that a person opened takes focus** (FRU-197). The press of a row changes nothing a screen
 * reader says but the state of the button. So the panel is a region with the name of its source, and
 * focus goes to it: a screen reader says the name and reads on from there, and Tab goes to its first
 * control. **Escape closes it and gives focus back to the row.** A panel that appears by itself takes
 * no focus: the one of a source that Linear or GitHub just connected.
 */
function Opened({
  label,
  takesFocus,
  onClose,
  children,
}: {
  /** The name of the region: the kind of the source, and which one. */
  label: string;
  /** Set by the press that opens the panel, and spent by the panel that appears. */
  takesFocus: { current: boolean };
  onClose: () => void;
  children: ReactNode;
}) {
  const held = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (takesFocus.current) {
      takesFocus.current = false;
      // The scroll is the one below: a focus that scrolls would put the top of a tall panel off the screen.
      held.current?.focus({ preventScroll: true });
    }
    held.current?.scrollIntoView({ block: 'nearest' });
  }, [takesFocus]);

  return (
    <div
      id={PANEL}
      ref={held}
      role="region"
      aria-label={label}
      tabIndex={-1}
      // Inside the frame of the list, with the rule of the list above it and the tint of a panel.
      className="scroll-mt-4 border-t border-line bg-subtle"
      onKeyDown={(event) => {
        // `Confirmation` and an open list take their own Escape, and stop it before it gets here.
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        onClose();
      }}
    >
      {children}
    </div>
  );
}
