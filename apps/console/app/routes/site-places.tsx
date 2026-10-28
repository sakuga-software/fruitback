import { useEffect, useState } from 'react';
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
import { Button, Chip, LinkButton, type OptionGroup, Problem, SearchChoice } from '../ui';
import { useLocale } from '../use-locale';
import { KINDS, accountOf, hostOf, sourceLine } from './connector-parts';
import { GITHUB_APP_PAGE } from './connector-github';

/** What a source offers: its teams, its repositories, or nothing to choose for an address. */
type Offer =
  | { kind: 'linear'; teams: Team[] }
  | { kind: 'github'; repositories: Repository[] }
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

  // The teams of each Linear and the repositories of each GitHub are read when the page draws them, and
  // again on « Try again ». An address has nothing to choose.
  useEffect(() => {
    let stale = false;
    for (const source of sources) {
      if (source.kind === 'rest') {
        setOffers((current) => ({ ...current, [source.id]: { kind: 'rest' } }));
        continue;
      }
      setOffers((current) => ({ ...current, [source.id]: 'loading' }));
      const path = source.kind === 'linear' ? 'teams' : 'repositories';
      void call<{ teams?: Team[]; repositories?: Repository[] }>('GET', `${base}/connectors/${source.id}/${path}`).then(
        (answer) => {
          if (stale) return;
          let offer: Offer = 'failed';
          if (answer.ok && source.kind === 'linear') offer = { kind: 'linear', teams: answer.data.teams ?? [] };
          if (answer.ok && source.kind === 'github')
            offer = { kind: 'github', repositories: answer.data.repositories ?? [] };
          setOffers((current) => ({ ...current, [source.id]: offer }));
        },
      );
    }

    return () => {
      stale = true;
    };
    // The sources are a new array at each render: the ids are what the reads depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, ids, reads]);

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
        ? offer.teams.find((one) => one.id === each.teamId)
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
    const team = offer.teams.find((one) => one.id === each.teamId);
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
          options: offer.teams
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
  const chosenOffer = chosen === undefined ? undefined : offers[chosen.source];
  const chosenTeam =
    typeof chosenOffer === 'object' && chosenOffer.kind === 'linear'
      ? chosenOffer.teams.find((team) => team.id === chosen?.team)
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
          <Problem>{t('The sources of this workspace did not load.')}</Problem>
          <Button tone="outline" onClick={onRetry}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof connectors !== 'string' && connectors.length === 0 ? (
        <p className="text-small text-muted">
          {t('No source is connected.')}{' '}
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
            disabled={writing || offered.length === 0}
            groups={offered}
            clearLabel={t('Clear the search')}
            noMatch={t('No destination matches this search.')}
            moreLabel={(more, left) => t('Show {more} more ({left} left)', { more, left })}
            onChoose={(value) => {
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
      {silent.length === 0 ? null : (
        <div className="flex flex-col items-start gap-[8px]">
          <Problem>
            {silent.length === 1
              ? t('{source} did not answer with its places.', {
                  source: `${t(KINDS[silent[0]?.kind ?? 'linear'].name)} · ${sourceLine(silent[0] as Connector)}`,
                })
              : t('Some sources did not answer with their places.')}
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
