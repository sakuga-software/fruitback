import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { type Providers, call, saveLanguage, signInProviders, signOut } from '../api';
import { problemOf } from '../problems';
import { Button, Card, Choice, Problem } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { LOCALES, chooseLanguage, locale, msg, t } from '../i18n';
import { useLocale } from '../use-locale';

/** `asking`: the worker has not answered yet. `silent`: it did not say, and nothing is in flight. */
type Asked = Providers | 'asking' | 'silent';

const ON = msg('On');

/** What the page says of one provider. WARNING: « Not set up » only when the worker said so. */
function providerWord(asked: Asked, provider: keyof Providers): string {
  if (asked === 'asking') return msg('Checking…');
  if (asked === 'silent') return msg('Could not check');

  return asked[provider] ? ON : msg('Not set up');
}

/** My account (design/boards/5-workspace.png): the profile, how I sign in, and the workspace's end. */
const DELETION_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only the owner of the workspace deletes it.'),
};
const WORKSPACE_NOT_DELETED = msg('The workspace was not deleted. Try again.');

export default function Account() {
  useLocale();
  const { me, workspace } = useWorkspace();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  // What the worker signs people in with (FRU-135). A provider is on or "not set up" only when the
  // worker said so: a slow answer and no answer prove neither, and each has its own word.
  const [providers, setProviders] = useState<Asked>('asking');
  useEffect(() => {
    let asked = true;
    void signInProviders().then((has) => {
      if (asked) setProviders(has ?? 'silent');
    });

    return () => {
      asked = false;
    };
  }, []);
  const [unsent, setUnsent] = useState(false);

  const [stillIn, setStillIn] = useState(false);

  async function leave() {
    setStillIn(false);
    if (await signOut()) return navigate('/setup', { replace: true });
    // The worker did not say that the session ended: it can still be good (FRU-204).
    setStillIn(true);
  }

  const [undeleted, setUndeleted] = useState<string | undefined>();

  async function destroy() {
    setUndeleted(undefined);
    const deleted = await call('DELETE', `/console/workspaces/${workspace.id}`);
    if (deleted.ok) return navigate('/', { replace: true });
    // The workspace is still there: say so beside the button (FRU-164).
    setUndeleted(problemOf(deleted, DELETION_PROBLEMS, WORKSPACE_NOT_DELETED));
  }

  return (
    <>
      <PageHead title={t('My account')} lead={t('How you sign in, and the workspace you are in.')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-[15px] font-semibold">{t('Profile')}</h2>
          <p className="text-xs text-muted">{t('Address')}</p>
          <p className="mb-4 text-[15px]">{me.account.email}</p>
          <p className="mb-1 text-xs text-muted">{t('Sign-in')}</p>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt>{t('Email link')}</dt>
              <dd className="font-semibold text-done">{t('On')}</dd>
            </div>
            {(['GitHub', 'Google'] as const).map((provider) => {
              const word = providerWord(providers, provider === 'GitHub' ? 'github' : 'google');

              return (
                <div key={provider} className="flex justify-between">
                  <dt>{provider}</dt>
                  <dd className={word === ON ? 'font-semibold text-done' : 'text-muted'}>{t(word)}</dd>
                </div>
              );
            })}
          </dl>
        </Card>
        <Card className="p-5">
          <Choice
            label={t('Language')}
            hint={t('The language of the console, and of the e-mails Fruitback sends you.')}
            value={locale()}
            options={LOCALES.map((each) => ({ value: each.tag, label: each.name }))}
            onChange={(tag) => {
              // The screen changes at once. The account keeps the choice for the e-mails and for
              // the next browser. When it did not hear it, say so: the choice stays in this browser
              // and is sent again at the next visit.
              setUnsent(false);
              void chooseLanguage(tag, saveLanguage).then((heard) => setUnsent(!heard));
            }}
          />
          {unsent ? (
            <div className="mt-3">
              <Problem>
                {t(
                  'Your account did not take this language yet. It is kept in this browser, and sent again the next time you open the console.',
                )}
              </Problem>
            </div>
          ) : null}
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 text-[15px] font-semibold">{t('Where you are signed in')}</h2>
          <div className="flex items-center justify-between">
            <span>
              <span className="block text-sm font-semibold">{t('Console · this browser')}</span>
              <span className="block text-xs text-muted">{t('Active now')}</span>
            </span>
            <Button tone="outline" onClick={() => void leave()}>
              {t('Sign out')}
            </Button>
          </div>
          {stillIn ? (
            <div className="mt-3">
              <Problem>{t('You are still signed in: Fruitback did not confirm the sign-out. Try again.')}</Problem>
            </div>
          ) : null}
        </Card>
      </div>
      {workspace.role === 'owner' ? (
        <Card className="mt-4 flex flex-col gap-3 border-accent/40 p-5 sm:flex-row sm:items-center">
          <span className="flex-1">
            <span className="block text-[15px] font-semibold">{t('Delete the workspace')}</span>
            <span className="block text-sm text-muted">
              {t('Sites, members and pin positions go. Items already in your sources stay there.')}
            </span>
            {undeleted === undefined ? null : (
              <span className="mt-2 block">
                <Problem>{t(undeleted)}</Problem>
              </span>
            )}
          </span>
          {confirming ? (
            <span className="flex gap-2">
              <Button tone="quiet" onClick={() => setConfirming(false)}>
                {t('Keep it')}
              </Button>
              <Button onClick={() => void destroy()}>{t('Delete {workspace}', { workspace: workspace.name })}</Button>
            </span>
          ) : (
            <Button tone="danger" onClick={() => setConfirming(true)}>
              {t('Delete workspace')}
            </Button>
          )}
        </Card>
      ) : null}
    </>
  );
}
