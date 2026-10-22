import { useEffect, useState } from 'react';
import {
  type Connector,
  type Destination,
  MAX_DESTINATIONS,
  type Repository,
  type Site,
  call,
  placesOf,
  samePlace,
  setPlaces,
} from '../api';
import { msg, t } from '../i18n';
import { writeProblemOf } from '../problems';
import { known } from '../listed';
import { Button, Chip, Choice, LinkButton, Problem, SidePanel } from '../ui';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import {
  BlockTitle,
  Disconnect,
  KINDS,
  type PanelProps,
  SitesState,
  accountOf,
  moment,
  sourceLine,
} from './connector-parts';

/** The value of the list « Add a destination… » before a repository is chosen. */
const NONE = 'fruitback';

/**
 * The page of the App on GitHub, where « Configure » opens the installation of each account. The
 * console does not know the id of an installation: the worker keeps it sealed (FRU-359).
 */
export const GITHUB_APP_PAGE = 'https://github.com/apps/fruitback-app';

/** What to do about an installation that GitHub refuses (FRU-359). `{when}` is the first refusal. */
const ATTENTION: Record<NonNullable<Connector['attention']>['reason'], string> = {
  'key-refused': msg(
    'GitHub refuses this installation since {when}, and the notes of its sites do not reach GitHub. Disconnect it, then connect GitHub again.',
  ),
  'key-lacks-access': msg(
    'Since {when}, GitHub refuses a repository that a site sends to, and its notes do not reach GitHub. On GitHub, give the App access to that repository, or choose another one here.',
  ),
  'connection-ended': msg(
    'The GitHub App is no longer installed on {account}, and since {when} the notes of its sites do not reach GitHub. Disconnect it, then connect GitHub again.',
  ),
};

/** The panel of a GitHub installation: which sites send their notes there, to which repository. */
export function GithubPanel({ id, base, connector, connectors, sites, manages, onChanged, onRemoved }: PanelProps) {
  useLocale();
  const [repositories, setRepositories] = useState<Repository[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [silent, setSilent] = useState(false);
  const [reads, setReads] = useState(0);
  // A list is written whole, from the list on the screen: see `writing` in the panel of Linear.
  const [writing, setWriting] = useState(false);
  const account = accountOf(connector);

  useEffect(() => {
    if (!manages) return;
    setSilent(false);
    void call<{ repositories: Repository[] }>('GET', `${base}/connectors/${connector.id}/repositories`).then(
      (answer) => {
        if (answer.ok) return setRepositories(answer.data.repositories);
        setRepositories([]);
        setSilent(true);
        // This read can be what told the worker that the installation is gone: the list is read again.
        void onChanged();
      },
    );
    // `onChanged` is not a reason to ask GitHub again: the read above runs once for a connector, and
    // again for each « Try again ».
  }, [base, connector.id, manages, reads]);

  /** The repository of a place, as GitHub lists it, when the list has it. */
  const repositoryOf = (place: Destination): Repository | undefined =>
    repositories?.find((each) => each.fullName.toLowerCase() === place.teamId);

  async function place(site: Site, places: Destination[]) {
    if (writing) return;
    setWriting(true);
    setProblem(undefined);
    const set = await setPlaces(base, site, places, connectors);
    if (!set.ok) setProblem(writeProblemOf(set, msg('The destinations of this site did not change. Try again.')));
    await onChanged();
    setWriting(false);
  }

  function nameOf(each: Destination): string {
    if (each.label !== undefined) return each.label;
    if (each.connector !== connector.id) return t('Another source');

    return `GitHub · ${each.teamId ?? ''}`;
  }

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(writeProblemOf(removed, msg('This source is still connected. Try again.')));
  }

  const listed = known(sites) ?? [];
  const sendsHere = (site: Site) => placesOf(site).some((each) => each.connector === connector.id);
  const senders = listed.filter(sendsHere);
  const others = manages ? listed.filter((site) => !sendsHere(site)) : [];
  const sorted = [...(repositories ?? [])].sort((one, other) => one.fullName.localeCompare(other.fullName));

  function row(site: Site) {
    const places = placesOf(site);
    const host = new URL(site.origin).host;
    const free = (repository: Repository): boolean =>
      !places.some((each) => samePlace(each, { connector: connector.id, teamId: repository.fullName.toLowerCase() }));
    const option = (repository: Repository) => ({
      value: repository.fullName.toLowerCase(),
      label: repository.fullName,
    });
    const offered = [
      { heading: t('Private repositories'), options: sorted.filter((each) => each.private && free(each)).map(option) },
      {
        heading: t('Public repositories: their issues are public'),
        options: sorted.filter((each) => !each.private && free(each)).map(option),
      },
    ].filter((group) => group.options.length > 0);

    return (
      <li key={site.id} className="border-b border-line py-[8px] text-small" data-site={host}>
        <p className="font-semibold [overflow-wrap:anywhere]">{siteLabel(site.origin)}</p>
        {places.length === 0 ? (
          <p className="text-hint text-muted">{t('Its notes stay in Fruitback, in this workspace.')}</p>
        ) : null}
        <ol className="flex flex-col">
          {places.map((each, index) => {
            const own = each.connector === connector.id;
            const rest = places.filter((_, position) => position !== index);
            // FRU-382: the worker's word comes with the destination, so the warning shows at once, for
            // every role that reads the destination, whatever the list. The list, when it is read,
            // can only add a warning: a repository it lists as public is public now.
            const open = own && (each.private === false || repositoryOf(each)?.private === false);

            return (
              <li key={`${each.connector}/${each.teamId}/${each.projectId}`}>
                <span className="flex items-center gap-[8px] text-muted">
                  <span className="min-w-0 flex-1 truncate">{nameOf(each)}</span>
                  {index === 0 ? <Chip>{t('Default')}</Chip> : null}
                </span>
                {open ? (
                  <div className="my-[4px]" data-public>
                    <Problem>
                      {t('{repository} is public: each note of this site becomes an issue that anybody can read.', {
                        repository: each.teamId ?? '',
                      })}
                    </Problem>
                  </div>
                ) : null}
                {manages && own ? (
                  <span className="flex flex-wrap gap-x-[16px]">
                    {index === 0 ? null : (
                      <LinkButton disabled={writing} onClick={() => void place(site, [each, ...rest])}>
                        {t('Make it the default')}
                      </LinkButton>
                    )}
                    <LinkButton disabled={writing} onClick={() => void place(site, rest)}>
                      {t('Remove')}
                    </LinkButton>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
        {manages && places.length < MAX_DESTINATIONS && offered.length > 0 ? (
          <div className="mt-[6px]">
            <Choice
              compact
              label={t('Add a repository for {site}', { site: host })}
              labelHidden
              value={NONE}
              disabled={repositories === undefined || writing}
              onChange={(value) => {
                if (value !== NONE) void place(site, [...places, { connector: connector.id, teamId: value }]);
              }}
              options={[{ value: NONE, label: t('Add a repository…') }, ...offered]}
            />
          </div>
        ) : null}
        {manages && places.length >= MAX_DESTINATIONS ? (
          <p className="mt-[4px] text-hint text-muted">
            {t('A site sends to {count} places at most.', { count: MAX_DESTINATIONS })}
          </p>
        ) : null}
      </li>
    );
  }

  return (
    <SidePanel
      id={id}
      title={t(KINDS.github.name)}
      detail={t('The GitHub App, installed on {account}', { account })}
      {...(manages
        ? {
            foot: (
              <Disconnect
                label={t('Disconnect {source}', { source: t(KINDS.github.name) })}
                confirmLabel={t('Disconnect {source}', { source: sourceLine(connector) })}
                consequence={t(
                  'Its sites keep their notes in the workspace again. The issues already on GitHub stay there, and the App stays installed until you remove it on GitHub.',
                )}
                onConfirm={() => void disconnect()}
              />
            ),
          }
        : {})}
    >
      {connector.attention === undefined ? null : (
        <div className="flex flex-col gap-[6px]">
          <Problem>
            {t(ATTENTION[connector.attention.reason], { when: moment(connector.attention.since), account })}
          </Problem>
          <p className="text-hint">
            <LinkButton space="inline" href={GITHUB_APP_PAGE} newTab>
              {t('Open the App on GitHub')}
            </LinkButton>
          </p>
        </div>
      )}
      <section>
        <BlockTitle>{t('Sites sending here')}</BlockTitle>
        <div className="mt-[8px]">
          <SitesState sites={sites} />
          {typeof sites !== 'string' && sites.length > 0 && senders.length === 0 ? (
            <p className="text-small text-muted">{t('No site sends its notes here yet.')}</p>
          ) : null}
          <ul>{senders.map(row)}</ul>
        </div>
        {others.length === 0 ? null : (
          <div className="mt-[16px]">
            <BlockTitle>{t('Other sites')}</BlockTitle>
            <ul>{others.map(row)}</ul>
          </div>
        )}
        {manages && repositories?.length === 0 && !silent ? (
          <p className="mt-[8px] text-hint text-muted">
            {t('The App reaches no repository of {account}. On GitHub, give it access to one.', { account })}{' '}
            <LinkButton space="inline" href={GITHUB_APP_PAGE} newTab>
              {t('Open the App on GitHub')}
            </LinkButton>
          </p>
        ) : null}
        {listed.length === 0 ? null : (
          <p className="mt-[8px] text-hint text-muted">
            {t('Each note becomes an issue of the repository. Its files do not go: GitHub takes none by its API.')}
          </p>
        )}
        {silent && connector.attention === undefined ? (
          <div className="mt-[12px] flex flex-col items-start gap-[8px]">
            <Problem>{t('GitHub did not answer with the repositories of this installation.')}</Problem>
            <Button tone="outline" onClick={() => setReads((count) => count + 1)}>
              {t('Try again')}
            </Button>
          </div>
        ) : null}
        {problem === undefined ? null : (
          <div className="mt-[12px]">
            <Problem>{t(problem)}</Problem>
          </div>
        )}
      </section>
    </SidePanel>
  );
}
