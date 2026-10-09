import { useState } from 'react';
import { useNavigate } from 'react-router';
import { call, signOut } from '../api';
import { Button, Card } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { LOCALES, locale, setLocale, t } from '../i18n';

/** My account (design/boards/5-workspace.png): the profile, how I sign in, and the workspace's end. */
export default function Account() {
  const { me, workspace } = useWorkspace();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

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
          <label className="block">
            <span className="mb-1 block text-[15px] font-semibold">{t('Language')}</span>
            <span className="mb-3 block text-xs text-muted">
              {t('The language of the console, and of the e-mails Fruitback sends you.')}
            </span>
            <select
              value={locale()}
              onChange={(event) => {
                // The screen changes at once. The account keeps the choice for the e-mails and for
                // the next browser; a worker that did not answer leaves it in this browser only.
                setLocale(event.target.value);
                void call('POST', '/console/me/locale', { locale: event.target.value });
              }}
              className="h-10 w-full rounded-md border border-line bg-surface px-3 text-[15px]"
            >
              {LOCALES.map((each) => (
                <option key={each.tag} value={each.tag}>
                  {each.name}
                </option>
              ))}
            </select>
          </label>
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
