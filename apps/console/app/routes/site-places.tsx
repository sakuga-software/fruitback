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
import { msg, t } from '../i18n';
import type { Listed } from '../listed';
import { writeProblemOf } from '../problems';
import { Button, Chip, Choice, LinkButton, type OptionGroup, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { KINDS, accountOf, hostOf, sourceLine } from './connector-parts';
import { GITHUB_APP_PAGE } from './connector-github';

/** The value of the list « Add a destination… » before a place is chosen. */
const NONE = 'none';

/** What a source offers: its teams, its repositories, or nothing to choose for an address. */
type Offer =
  | { kind: 'linear'; teams: Team[] }
  | { kind: 'github'; repositories: Repository[] }
  | { kind: 'rest' }
  | 'loading'
  | 'failed';

/**
 * Where the notes of a site go (FRU-399): its places in their order, and the places of every source
 * of the workspace to add. It is the Sites screen that sets them, and no longer the panel of a source.
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
  const sources = typeof connectors === 'string' ? [] : connectors;
  const ids = sources.map((each) => each.id).join();

  // The teams of each Linear and the repositories of each GitHub are read when the panel opens, and
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

  async function place(next: Destination[]) {
    // One write at a time: see the warning above.
    if (writing) return;
    setWriting(true);
    setProblem(undefined);
    const set = await setPlaces(base, site, next, sources);
    if (set.ok) {
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
          options: offer.teams.flatMap((team) => [
            { value: `${source.id}|${team.id}|`, label: t('{team}, no project', { team: team.name }) },
            ...team.projects.map((project) => ({
              value: `${source.id}|${team.id}|${project.id}`,
              label: `${team.name} · ${project.name}`,
            })),
          ]),
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
    .map((group) => ({ ...group, options: group.options.filter((option) => free(option.value)) }))
    .filter((group) => group.options.length > 0);
  const silent = sources.filter((source) => offers[source.id] === 'failed');
  const reading = sources.some((source) => offers[source.id] === 'loading');
  const host = new URL(site.origin).host;

  return (
    <section
      aria-label={t('Where the notes of {site} go', { site: host })}
      className="flex min-w-0 flex-col gap-[12px]"
    >
      <h3 className="text-small leading-auto font-semibold">{t('Where the notes of {site} go', { site: host })}</h3>
      {places.length === 0 ? (
        <p className="text-small text-muted">{t('Its notes stay in Fruitback, in this workspace.')}</p>
      ) : (
        <ol className="flex flex-col">
          {places.map((each, index) => {
            const rest = places.filter((_, position) => position !== index);

            return (
              <li key={valueOf(each)} className="border-b border-line py-[8px] text-small">
                <span className="flex items-center gap-[8px]">
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
                    <LinkButton disabled={writing} onClick={() => void place([each, ...rest])}>
                      {t('Make it the default')}
                    </LinkButton>
                  )}
                  <LinkButton disabled={writing} onClick={() => void place(rest)}>
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
          <Choice
            compact
            label={t('Add a destination for {site}', { site: host })}
            labelHidden
            value={NONE}
            disabled={writing || offered.length === 0}
            onChange={(value) => {
              const added = placeOf(value);
              if (value !== NONE && added !== undefined) void place([...places, added]);
            }}
            options={[
              { value: NONE, label: reading && offered.length === 0 ? t('Loading…') : t('Add a destination…') },
              ...offered,
            ]}
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
