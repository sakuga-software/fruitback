import { useState } from 'react';
import { useNavigate } from 'react-router';
import { call, signOut, saveLanguage } from '../api';
import { Button, Card, Choice, Problem } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { LOCALES, chooseLanguage, locale, t } from '../i18n';
import { useLocale } from '../use-locale';

/** My account (design/boards/5-workspace.png): the profile, how I sign in, and the workspace's end. */
export default function Account() {
  useLocale();
  const { me, workspace } = useWorkspace();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [unsent, setUnsent] = useState(false);

  async function leave() {
    await signOut();
    navigate('/setup', { replace: true });
  }

  async function destroy() {
    const deleted = await call('DELETE', `/console/workspaces/${workspace.id}`);
    if (deleted.ok) navigate('/', { replace: true });
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
            <div className="flex justify-between">
              <dt>{t('GitHub')}</dt>
              <dd className="text-muted">{t('Soon')}</dd>
            </div>
            <div className="flex justify-between">
              <dt>{t('Google')}</dt>
              <dd className="text-muted">{t('After the beta')}</dd>
            </div>
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
        </Card>
      </div>
      {workspace.role === 'owner' ? (
        <Card className="mt-4 flex flex-col gap-3 border-accent/40 p-5 sm:flex-row sm:items-center">
          <span className="flex-1">
            <span className="block text-[15px] font-semibold">{t('Delete the workspace')}</span>
            <span className="block text-sm text-muted">
              {t('Sites, members and pin positions go. Items already in your sources stay there.')}
            </span>
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
