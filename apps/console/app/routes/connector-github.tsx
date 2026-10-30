import { useEffect, useState } from 'react';
import { type Connector, type Repository, call } from '../api';
import { msg, t } from '../i18n';
import { writeProblemOf } from '../problems';
import { known } from '../listed';
import { Button, LinkButton, Problem, SidePanel } from '../ui';
import { useLocale } from '../use-locale';
import { Disconnect, KINDS, type PanelProps, SendersList, accountOf, moment, sourceLine } from './connector-parts';
import { useWorkspace } from './workspace';

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

/**
 * The panel of a GitHub installation: the sites that send their notes there (read only: a site
 * chooses its repository on the Sites screen, FRU-399).
 */
export function GithubPanel({ id, base, connector, sites, manages, onRemoved }: PanelProps) {
  useLocale();
  const { workspace } = useWorkspace();
  const [problem, setProblem] = useState<string | undefined>();
  const account = accountOf(connector);
  // The repositories, for the warning of a public one (FRU-382): read for who manages the sources,
  // once for a connector and again on « Try again ». A member reads the worker's word only.
  const [repositories, setRepositories] = useState<Repository[] | undefined>();
  const [silent, setSilent] = useState(false);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!manages) return;
    setSilent(false);
    void call<{ repositories: Repository[] }>('GET', `${base}/connectors/${connector.id}/repositories`).then(
      (answer) => {
        if (answer.ok) return setRepositories(answer.data.repositories);
        setRepositories(undefined);
        setSilent(true);
      },
    );
  }, [base, connector.id, manages, reads]);

  async function disconnect() {
    const removed = await call('DELETE', `${base}/connectors/${connector.id}`);
    if (removed.ok) return onRemoved();
    setProblem(writeProblemOf(removed, msg('This connector is still connected. Try again.')));
  }

  return (
    <SidePanel
      id={id}
      flush
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
      <SendersList
        connector={connector}
        sites={sites}
        workspaceId={workspace.id}
        {...(repositories === undefined ? {} : { repositories })}
      />
      {/* A list that failed leaves the worker's word on each repository, and says so. */}
      {silent ? (
        <div className="flex flex-col items-start gap-[8px]">
          <Problem>{t('GitHub did not send the repositories of this installation. Try again in a moment.')}</Problem>
          <Button tone="outline" onClick={() => setReads((count) => count + 1)}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {known(sites)?.length ? (
        <p className="text-hint text-muted">
          {t('Each note becomes an issue of the repository. Its files do not go: GitHub takes none by its API.')}
        </p>
      ) : null}
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
    </SidePanel>
  );
}
