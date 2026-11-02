import { useEffect, useRef, useState } from 'react';
import {
  type Connector,
  type Destination,
  MAX_DESTINATIONS,
  type Repository,
  type Site,
  type Team,
  call,
  placesOf,
  samePlace,
  setPlaces,
} from '../api';
import { ConnectorMark } from '../connector-marks';
import { msg, t } from '../i18n';
import type { Listed } from '../listed';
import { writeProblemOf } from '../problems';
import { Button, Chip, Field, LinkButton, type OptionGroup, Problem, SearchChoice } from '../ui';
import { type TeamList, type TeamListEvent, offersMore, searchToAsk, stepTeamList, teamListOf } from '../team-list';
import { useLocale } from '../use-locale';
import { KINDS, accountOf, hostOf, sourceLine } from './connector-parts';
import { GITHUB_APP_PAGE } from './connector-github';
import { ReadProblem } from '../read-problem';

/**
 * What a source offers: its teams, its repositories, or nothing to choose for an address. The teams of
 * a Linear come a page at a time, and a search asks the worker (FRU-501): `team-list.ts` holds them.
 */
type Offer =
  | { kind: 'linear'; list: TeamList }
  /**
   * `listed`: how many GitHub listed; `total`: how many it counts, which can pass the list (FRU-500).
   * A repository added by its name joins `repositories`, not `listed`.
   */
  | { kind: 'github'; repositories: Repository[]; listed: number; total: number }
  | { kind: 'rest' }
  | 'loading'
  | 'failed';

/**
 * Where the notes of a site go (FRU-399): its places in their order, and the places of every source
 * of the workspace to add. The page of the site sets them (FRU-433), and no longer the panel of a source.
 *
 * WARNING: the list is written whole, from the list on the screen (FRU-123). A second change made
 * before the first one is kept would start from the list of before, and take the first one away: the
 * controls wait while a list is written.
 */
export function SitePlaces({
  base,
  workspaceId,
  site,
  connectors,
  onRetry,
  onPlaced,
}: {
  base: string;
  workspaceId: string;
  site: Site;
  /** Every source of the workspace: a list is written with the kind of each one (`setPlaces`). */
  connectors: Listed<Connector>;
  /** Reads the sources again, after a read that failed. */
  onRetry: () => void;
  /** The places the worker kept, with the words it wrote for each. */
  onPlaced: (places: Destination[]) => void;
}) {
  useLocale();
  const [offers, setOffers] = useState<Readonly<Record<string, Offer>>>({});
  const [reads, setReads] = useState(0);
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  /** The team of Linear chosen in the first list: the second list offers its projects (FRU-458). */
  const [chosen, setChosen] = useState<{ source: string; team: string } | undefined>();
  const sources = typeof connectors === 'string' ? [] : connectors;
  const ids = sources.map((each) => each.id).join();

  /**
   * The id of the last request of a list of teams (FRU-501). Each answer carries the id of its
   * request, and a list drops an answer to any other: see `team-list.ts`.
   */
  const requests = useRef(0);
  /** The search typed so far, for a list whose first page comes after it. */
  const typed = useRef('');

  /** Moves the list of teams of `source` on, when it has one. */
  function step(source: string, event: TeamListEvent) {
    setOffers((current) => {
      const offer = current[source];
      if (typeof offer !== 'object' || offer.kind !== 'linear') return current;

      return { ...current, [source]: { kind: 'linear', list: stepTeamList(offer.list, event) } };
    });
  }

  /** Moves every list of teams on, as they are now: a list read during a pause gets the event too. */
  function stepAll(event: TeamListEvent) {
    setOffers((current) =>
      Object.fromEntries(
        Object.entries(current).map(([source, offer]) => [
          source,
          typeof offer === 'object' && offer.kind === 'linear'
            ? { kind: 'linear', list: stepTeamList(offer.list, event) }
            : offer,
        ]),
      ),
    );
  }

  // The teams of each Linear and the repositories of each GitHub are read when the page draws them, and
  // again on « Try again », which starts each list of teams again. An address has nothing to choose.
  // React runs an effect twice when it mounts in development: the lists are read once for each
  // sources and « Try again » (FRU-557). Each read calls Linear or GitHub, 51 calls for 300 teams.
  // An answer to a read that a newer one replaced is dropped.
  const readFor = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  // Whether the panel is on the page: an answer that comes after it left is dropped. The development
  // mount runs this cleanup and this setup again, so the answer of the one read is kept there.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const key = `${base} ${ids} ${reads}`;
    if (readFor.current === key) return;
    readFor.current = key;
    generation.current += 1;
    const mine = generation.current;
    // A source that left takes its list with it: a read of the sources can answer fewer of them.
    const kept = new Set(sources.map((source) => source.id));
    setOffers((current) => Object.fromEntries(Object.entries(current).filter(([id]) => kept.has(id))));
    for (const source of sources) {
      if (source.kind === 'rest') {
        setOffers((current) => ({ ...current, [source.id]: { kind: 'rest' } }));
        continue;
      }
      setOffers((current) => ({ ...current, [source.id]: 'loading' }));
      const path = source.kind === 'linear' ? 'teams' : 'repositories';
      requests.current += 1;
      const asked = requests.current;
      void call<{ teams?: Team[]; next?: string; repositories?: Repository[]; total?: number }>(
        'GET',
        `${base}/connectors/${source.id}/${path}`,
      ).then((answer) => {
        if (!mounted.current || mine !== generation.current) return;
        let offer: Offer = 'failed';
        if (answer.ok && source.kind === 'linear')
          offer = { kind: 'linear', list: teamListOf(answer.data, asked, typed.current) };
        if (answer.ok && source.kind === 'github') {
          const repositories = answer.data.repositories ?? [];
          const listed = repositories.length;
          offer = { kind: 'github', repositories, listed, total: answer.data.total ?? listed };
        }
        setOffers((current) => ({ ...current, [source.id]: offer }));
      });
    }
    // The sources are a new array at each render: the ids are what the reads depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, ids, reads]);

  /** Asks the worker for teams of a Linear, and gives the answer to its list with the id of the request. */
  function readTeams(source: string, query: URLSearchParams, ask: 'ask-page' | 'ask-search') {
    requests.current += 1;
    const requestId = requests.current;
    step(source, { type: ask, requestId });
    void call<{ teams?: Team[]; next?: string }>('GET', `${base}/connectors/${source}/teams?${query}`).then((answer) =>
      step(
        source,
        answer.ok
          ? { type: 'answer', requestId, teams: answer.data.teams ?? [], next: answer.data.next }
          : { type: 'fail', requestId },
      ),
    );
  }

  // A list that is not complete asks the worker for the words of the search, once for each words.
  useEffect(() => {
    for (const [source, offer] of Object.entries(offers)) {
      if (typeof offer !== 'object' || offer.kind !== 'linear') continue;
      const words = searchToAsk(offer.list);
      if (words !== undefined) readTeams(source, new URLSearchParams({ q: words }), 'ask-search');
    }
    // `readTeams` is a new function at each render; the offers are what a search depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offers]);

  // What is typed goes to the lists once the person stops typing; an empty search at once.
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pause.current), []);
  function type(search: string) {
    clearTimeout(pause.current);
    const give = () => {
      typed.current = search.trim();
      stepAll({ type: 'type', query: search });
    };
    if (search.trim() === '') give();
    else pause.current = setTimeout(give, SEARCH_PAUSE_MS);
  }

  const places = placesOf(site);

  // A list is written with the kind of each source (`setPlaces`): with no list of the sources, a
  // GitHub place would go as a team, and the worker would refuse the whole list (raised in review).
  const blocked = writing || typeof connectors === 'string';

  async function place(next: Destination[]) {
    // One write at a time: see the warning above. And none before the sources are read.
    if (blocked) return;
    setWriting(true);
    setProblem(undefined);
    const set = await setPlaces(base, site, next, sources);
    if (set.ok) {
      setChosen(undefined);
      const kept = (set.data as { destinations?: Destination[] } | undefined)?.destinations;
      onPlaced(Array.isArray(kept) ? kept : next);
    } else setProblem(writeProblemOf(set, msg('The destinations of this site did not change. Try again.')));
    setWriting(false);
  }

  /** The source of a place, when the workspace still has it. */
  const sourceOf = (each: Destination) => sources.find((source) => source.id === each.connector);

  /** The words of a place: what the worker wrote, or what the console knows while that is all there is. */
  function nameOf(each: Destination): string {
    if (each.label !== undefined) return each.label;
    const source = sourceOf(each);
    if (source === undefined) return t('A tracker');
    if (source.kind === 'rest') return `${t(KINDS.rest.name)} · ${hostOf(source)}`;
    if (source.kind === 'github') return `GitHub · ${each.teamId ?? ''}`;
    const offer = offers[source.id];
    const team =
      typeof offer === 'object' && offer.kind === 'linear'
        ? offer.list.items.find((one) => one.id === each.teamId)
        : undefined;
    const project = team?.projects.find((one) => one.id === each.projectId);

    return [t('Linear'), team?.name, project?.name].filter(Boolean).join(' · ');
  }

  /**
   * The colour Linear draws a place of Linear with (FRU-459): its project's, else its team's. Known once
   * the teams of its source are read: until then, and when that read failed, the mark of the source shows alone.
   */
  function colorOf(each: Destination): string | undefined {
    const source = sourceOf(each);
    if (source?.kind !== 'linear') return undefined;
    const offer = offers[source.id];
    if (typeof offer !== 'object' || offer.kind !== 'linear') return undefined;
    const team = offer.list.items.find((one) => one.id === each.teamId);
    const project = team?.projects.find((one) => one.id === each.projectId);

    return project?.color ?? team?.color;
  }

  /** Whether a GitHub place is public: GitHub's list wins once it names the repository (FRU-382). */
  function isPublic(each: Destination): boolean {
    const source = sourceOf(each);
    if (source?.kind !== 'github') return false;
    const offer = offers[source.id];
    const listed =
      typeof offer === 'object' && offer.kind === 'github'
        ? offer.repositories.find((one) => one.fullName.toLowerCase() === each.teamId)
        : undefined;

    return (listed?.private ?? each.private) === false;
  }

  // A place is a value of the list: its source, its team or repository, its project.
  const valueOf = (each: Destination) => [each.connector, each.teamId ?? '', each.projectId ?? ''].join('|');
  const placeOf = (value: string): Destination | undefined => {
    const [connector, teamId, projectId] = value.split('|');
    if (connector === undefined || connector === '') return undefined;

    return {
      connector,
      ...(teamId === undefined || teamId === '' ? {} : { teamId }),
      ...(projectId === undefined || projectId === '' ? {} : { projectId }),
    };
  };
  // A place that is already in the list is not offered again: the worker refuses it twice.
  const free = (value: string) => {
    const wanted = placeOf(value);

    return wanted !== undefined && !places.some((each) => samePlace(each, wanted));
  };

  const groups: OptionGroup[] = sources.flatMap((source): OptionGroup[] => {
    const offer = offers[source.id];
    const named = `${t(KINDS[source.kind].name)} · ${sourceLine(source)}`;
    if (typeof offer !== 'object') return [];
    if (offer.kind === 'rest')
      return [
        {
          heading: t(KINDS.rest.name),
          options: [{ value: `${source.id}||`, label: hostOf(source).replace(/^https?:\/\//, '') }],
        },
      ];
    if (offer.kind === 'linear')
      return [
        {
          heading: named,
          // A team, and not its places: its projects are in a list of their own (FRU-458). A team is
          // offered while one of its places is free.
          options: offer.list.items
            .filter((team) => placesOfTeam(source.id, team).some((value) => free(value)))
            .map((team) => ({ value: `${TEAM}${source.id}|${team.id}`, label: teamLine(team) })),
        },
      ];
    const sorted = [...offer.repositories].sort((one, other) => one.fullName.localeCompare(other.fullName));
    const option = (repository: Repository) => ({
      value: `${source.id}|${repository.fullName.toLowerCase()}|`,
      label: repository.fullName,
    });
    const account = accountOf(source);

    return [
      {
        heading: t('GitHub, private repositories of {account}', { account }),
        options: sorted.filter((each) => each.private).map(option),
      },
      {
        heading: t('GitHub, public repositories of {account}: their issues are public', { account }),
        options: sorted.filter((each) => !each.private).map(option),
      },
    ];
  });
  const offered = groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => option.value.startsWith(TEAM) || free(option.value)),
    }))
    .filter((group) => group.options.length > 0);
  // The teams each Linear did not give yet: its next page, on demand (FRU-501), after every option.
  const moreTeams = sources.flatMap((source) => {
    const offer = offers[source.id];

    return typeof offer === 'object' && offer.kind === 'linear' && offersMore(offer.list)
      ? [
          {
            value: `${MORE_TEAMS}${source.id}`,
            label: t('More teams of {source}…', { source: `${t(KINDS[source.kind].name)} · ${sourceLine(source)}` }),
          },
        ]
      : [];
  });
  /** The Linears whose last read of more teams failed: a new read, or « Try again », takes it away. */
  const teamsFailed = sources.filter((source) => {
    const offer = offers[source.id];

    return typeof offer === 'object' && offer.kind === 'linear' && offer.list.status === 'error';
  });
  const chosenOffer = chosen === undefined ? undefined : offers[chosen.source];
  const chosenTeam =
    typeof chosenOffer === 'object' && chosenOffer.kind === 'linear'
      ? chosenOffer.list.items.find((team) => team.id === chosen?.team)
      : undefined;
  const projectGroups =
    chosen === undefined || chosenTeam === undefined ? [] : projectGroupsOf(chosen.source, chosenTeam, free);
  const silent = sources.filter((source) => offers[source.id] === 'failed');
  const reading = sources.some((source) => offers[source.id] === 'loading');
  const host = new URL(site.origin).host;

  return (
    <section
      aria-label={t('Where the notes of {site} go', { site: host })}
      className="flex min-w-0 flex-col gap-[12px]"
    >
      <h2 className="text-section font-bold">{t('Where the notes of {site} go', { site: host })}</h2>
      {places.length === 0 ? (
        <p className="text-small text-muted">{t('Its notes stay in Fruitback, in this workspace.')}</p>
      ) : (
        <ol className="flex flex-col">
          {places.map((each, index) => {
            const rest = places.filter((_, position) => position !== index);

            return (
              <li key={valueOf(each)} className="border-b border-line py-[8px] text-small">
                <span className="flex items-center gap-[8px]">
                  {/* The mark of the source, and the colour Linear gives the place (FRU-459): the name says both. */}
                  {sourceOf(each) === undefined ? null : (
                    <span className="flex flex-none items-center gap-[6px] text-muted" data-place-mark>
                      <ConnectorMark kind={sourceOf(each)?.kind ?? 'linear'} />
                      {colorOf(each) === undefined ? null : (
                        <span
                          aria-hidden="true"
                          className="size-[10px] flex-none rounded-full border border-line"
                          data-place-color={colorOf(each)}
                          style={{ background: colorOf(each) }}
                        />
                      )}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{nameOf(each)}</span>
                  {index === 0 ? <Chip>{t('Default')}</Chip> : null}
                </span>
                {isPublic(each) ? (
                  <div className="my-[4px]" data-public>
                    <Problem>
                      {t('{repository} is public: each note of this site becomes an issue that anybody can read.', {
                        repository: each.teamId ?? '',
                      })}
                    </Problem>
                  </div>
                ) : null}
                <span className="flex flex-wrap gap-x-[16px]">
                  {index === 0 ? null : (
                    <LinkButton disabled={blocked} onClick={() => void place([each, ...rest])}>
                      {t('Make it the default')}
                    </LinkButton>
                  )}
                  <LinkButton disabled={blocked} onClick={() => void place(rest)}>
                    {t('Remove')}
                  </LinkButton>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {connectors === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {connectors === 'failed' ? (
        <div className="flex flex-col items-start gap-[8px]">
          <Problem>
            {t('The connectors of this workspace did not load.')} <ReadProblem />
          </Problem>
          <Button tone="outline" onClick={onRetry}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof connectors !== 'string' && connectors.length === 0 ? (
        <p className="text-small text-muted">
          {t('No connector is added.')}{' '}
          <LinkButton space="inline" to={`/w/${workspaceId}/connectors`}>
            {t('Connect a tracker')}
          </LinkButton>
        </p>
      ) : null}

      {places.length < MAX_DESTINATIONS && sources.length > 0 ? (
        <div className="max-w-[420px]">
          <SearchChoice
            label={t('Add a destination for {site}', { site: host })}
            searchLabel={t('Search the destinations')}
            placeholder={reading && offered.length === 0 ? t('Loading…') : t('Add a destination…')}
            disabled={writing || (offered.length === 0 && moreTeams.length === 0)}
            groups={offered}
            tail={moreTeams}
            clearLabel={t('Clear the search')}
            noMatch={t('No destination matches this search.')}
            moreLabel={(more, left) => t('Show {more} more ({left} left)', { more, left })}
            onSearch={type}
            onChoose={(value) => {
              if (value.startsWith(MORE_TEAMS)) {
                const source = value.slice(MORE_TEAMS.length);
                const offer = offers[source];
                if (typeof offer === 'object' && offer.kind === 'linear' && offer.list.cursor !== null) {
                  readTeams(source, new URLSearchParams({ after: offer.list.cursor }), 'ask-page');
                }

                return;
              }
              if (value.startsWith(TEAM)) {
                const [source = '', team = ''] = value.slice(TEAM.length).split('|');
                setChosen({ source, team });

                return;
              }
              const added = placeOf(value);
              if (added !== undefined) void place([...places, added]);
            }}
          />
        </div>
      ) : null}
      {places.length < MAX_DESTINATIONS && chosenTeam !== undefined && projectGroups.length > 0 ? (
        <div className="flex max-w-[420px] flex-col gap-[8px]" data-team-projects>
          <p className="flex flex-wrap items-baseline gap-x-[12px] text-small">
            <span className="font-semibold">{t('Team {team}', { team: chosenTeam.name })}</span>
            <LinkButton disabled={writing} onClick={() => setChosen(undefined)}>
              {t('Choose another team')}
            </LinkButton>
          </p>
          {/* Its key changes with the team: the search and the pages of the team before do not stay. */}
          <SearchChoice
            key={`${chosen?.source}|${chosenTeam.id}`}
            label={t('Add a project of {team}', { team: chosenTeam.name })}
            searchLabel={t('Search the projects of {team}', { team: chosenTeam.name })}
            placeholder={t('Choose a project of {team}…', { team: chosenTeam.name })}
            disabled={writing}
            groups={projectGroups}
            clearLabel={t('Clear the search')}
            noMatch={t('No project matches this search.')}
            moreLabel={(more, left) => t('Show {more} more ({left} left)', { more, left })}
            onChoose={(value) => {
              const added = placeOf(value);
              if (added !== undefined) void place([...places, added]);
            }}
          />
        </div>
      ) : null}
      {places.length < MAX_DESTINATIONS
        ? sources.map((source) => {
            const offer = offers[source.id];
            if (typeof offer !== 'object' || offer.kind !== 'github' || offer.total <= offer.listed) {
              return null;
            }

            return (
              <RepositoryByName
                key={source.id}
                base={base}
                source={source}
                listed={offer.listed}
                total={offer.total}
                disabled={blocked}
                onFound={(repository) => {
                  setOffers((current) => {
                    const now = current[source.id];
                    if (typeof now !== 'object' || now.kind !== 'github') return current;
                    if (now.repositories.some((each) => each.fullName === repository.fullName)) return current;

                    return { ...current, [source.id]: { ...now, repositories: [...now.repositories, repository] } };
                  });
                  const added = placeOf(`${source.id}|${repository.fullName.toLowerCase()}|`);
                  if (added !== undefined && !places.some((each) => samePlace(each, added))) {
                    void place([...places, added]);
                  }
                }}
              />
            );
          })
        : null}
      {places.length >= MAX_DESTINATIONS ? (
        <p className="text-hint text-muted">
          {t('A site sends to {count} places at most.', { count: MAX_DESTINATIONS })}
        </p>
      ) : null}
      {sources
        .filter((source) => {
          const offer = offers[source.id];

          return typeof offer === 'object' && offer.kind === 'github' && offer.repositories.length === 0;
        })
        .map((source) => (
          <p key={source.id} className="text-hint text-muted">
            {t('The App reaches no repository of {account}. On GitHub, give it access to one.', {
              account: accountOf(source),
            })}{' '}
            <LinkButton space="inline" href={GITHUB_APP_PAGE} newTab>
              {t('Open the App on GitHub')}
            </LinkButton>
          </p>
        ))}
      {teamsFailed.length === 0 ? null : (
        <Problem>
          {t('{source} did not answer with more teams. Try again.', {
            source: teamsFailed.map((source) => `${t(KINDS[source.kind].name)} · ${sourceLine(source)}`).join(', '),
          })}
        </Problem>
      )}
      {silent.length === 0 ? null : (
        <div className="flex flex-col items-start gap-[8px]">
          <Problem>
            {silent.length === 1
              ? t('{source} did not send its places. Try again in a moment.', {
                  source: `${t(KINDS[silent[0]?.kind ?? 'linear'].name)} · ${sourceLine(silent[0] as Connector)}`,
                })
              : t('Some connectors did not send their places. Try again in a moment.')}
          </Problem>
          <Button tone="outline" onClick={() => setReads((count) => count + 1)}>
            {t('Try again')}
          </Button>
        </div>
      )}
      {places.length > 1 || offered.length > 0 ? (
        <p className="text-hint text-muted">
          {t(
            'A note goes to the default place. With two places or more, a member chooses one in the widget when they write.',
          )}
        </p>
      ) : null}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </section>
  );
}

/** The value of a team in the first list: it opens the list of its projects, and adds nothing. */
const TEAM = 'team:';

/** The value of the last option of a Linear that has more teams: it reads them, and adds nothing. */
const MORE_TEAMS = 'more-teams:';

/** How long a search waits for the person to stop typing before it asks Linear. */
const SEARCH_PAUSE_MS = 300;

/** The places a team offers: the team itself, and each of its projects. */
function placesOfTeam(source: string, team: Team): string[] {
  return [`${source}|${team.id}|`, ...team.projects.map((project) => `${source}|${team.id}|${project.id}`)];
}

/**
 * A team in the first list (FRU-458): its name and its key, how many projects it has, and whether it is
 * private, so a person tells two teams of one name apart and sees which ones are worth opening.
 */
function teamLine(team: Team): string {
  const count = team.projects.length;
  let projects = t('{count} projects', { count });
  if (count === 0) projects = t('no project');
  else if (count === 1) projects = t('{count} project', { count });

  return [
    team.key === '' ? team.name : `${team.name} (${team.key})`,
    projects,
    ...(team.private === true ? [t('private')] : []),
  ].join(' · ');
}

/** The kinds of status of Linear, in the order a person looks for them: what is under way first. */
const STATUS_ORDER = ['started', 'planned', 'backlog', 'paused', 'completed', 'canceled'] as const;
const STATUS_HEADINGS: Record<(typeof STATUS_ORDER)[number], string> = {
  started: msg('Started'),
  planned: msg('Planned'),
  backlog: msg('Backlog'),
  paused: msg('Paused'),
  completed: msg('Completed'),
  canceled: msg('Canceled'),
};

/**
 * The second list (FRU-458): the team itself, then its projects under the kind of their status, what is
 * under way first, and those with no status last. Each project says the name of its status, as its
 * workspace of Linear calls it. A place that is already in the list is not offered.
 */
function projectGroupsOf(source: string, team: Team, free: (value: string) => boolean): OptionGroup[] {
  const whole = `${source}|${team.id}|`;
  const option = (project: Team['projects'][number]) => ({
    value: `${source}|${team.id}|${project.id}`,
    label: project.status === undefined ? project.name : `${project.name} · ${project.status.name}`,
  });
  const byName = (one: { name: string }, other: { name: string }) => one.name.localeCompare(other.name);
  const known = new Set<string>(STATUS_ORDER);

  return [
    { heading: t('The whole team'), options: [{ value: whole, label: t('{team}, no project', { team: team.name }) }] },
    ...STATUS_ORDER.map((type) => ({
      heading: t(STATUS_HEADINGS[type]),
      options: team.projects
        .filter((project) => project.status?.type === type)
        .sort(byName)
        .map(option),
    })),
    {
      heading: t('No status'),
      options: team.projects
        .filter((project) => project.status === undefined || !known.has(project.status.type))
        .sort(byName)
        .map(option),
    },
  ]
    .map((group) => ({ ...group, options: group.options.filter((each) => free(each.value)) }))
    .filter((group) => group.options.length > 0);
}

/**
 * A repository past the list (FRU-500): GitHub lists 1,000 repositories of an installation at most, so
 * a person names another one, which the worker reads alone, by its name, with a token of that
 * repository. Found, it is added as a destination.
 */
function RepositoryByName({
  base,
  source,
  listed,
  total,
  disabled,
  onFound,
}: {
  base: string;
  source: Connector;
  listed: number;
  total: number;
  disabled: boolean;
  onFound: (repository: Repository) => void;
}) {
  useLocale();
  const [name, setName] = useState('');
  const [asking, setAsking] = useState(false);
  // In English, with its values: translated where it is shown, so it follows a change of language.
  const [said, setSaid] = useState<{ text: string; values?: Record<string, string> } | undefined>();
  const account = accountOf(source);

  async function find() {
    const wanted = name.trim();
    if (wanted === '' || asking) return;
    setAsking(true);
    setSaid(undefined);
    const answer = await call<{ repository?: Repository }>(
      'GET',
      `${base}/connectors/${source.id}/repositories?name=${encodeURIComponent(wanted)}`,
    );
    setAsking(false);
    if (answer.ok && answer.data.repository !== undefined) {
      setName('');
      onFound(answer.data.repository);
    } else if (!answer.ok && answer.status === 404) {
      setSaid({ text: msg('The App reaches no repository {name}.'), values: { name: wanted } });
    } else if (!answer.ok && answer.error === 'connection-ended') {
      setSaid({
        text: msg(
          'The GitHub App is no longer installed on {account}. Disconnect it on the Connectors screen, then connect GitHub again.',
        ),
        values: { account },
      });
    } else if (!answer.ok && answer.status === 400) {
      setSaid({ text: msg('Write the repository as owner/name.') });
    } else {
      setSaid({ text: msg('GitHub did not answer. Try again in a moment.') });
    }
  }

  return (
    <form
      className="flex max-w-[420px] flex-col gap-[8px]"
      data-repository-by-name
      onSubmit={(event) => {
        event.preventDefault();
        void find();
      }}
    >
      <p className="text-hint text-muted">
        {t('GitHub lists {listed} of the {total} repositories of {account}. Add another one by its name.', {
          listed,
          total,
          account,
        })}
      </p>
      <div className="flex items-end gap-[8px]">
        <Field
          label={t('Repository of {account}', { account })}
          placeholder="owner/name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={disabled || asking}
          compact
          code
        />
        <Button tone="outline" type="submit" disabled={disabled || asking || name.trim() === ''}>
          {t('Add')}
        </Button>
      </div>
      {said === undefined ? null : <Problem>{t(said.text, said.values)}</Problem>}
    </form>
  );
}
