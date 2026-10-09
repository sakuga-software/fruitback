import { Card, Chip, Initial } from '../ui';
import { PageHead, useWorkspace } from './workspace';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';

const ROLE_WORDS = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
} as const;

/**
 * Who belongs to the workspace (design/boards/5-workspace.png). Inviting somebody is FRU-104: the
 * form is drawn where the design puts it, and says so.
 */
export default function Members() {
  useLocale();
  const { me, workspace } = useWorkspace();
  const name = me.account.name ?? me.account.email.split('@')[0] ?? me.account.email;

  return (
    <>
      <PageHead title={t('Members')} lead={t('Who can see and leave feedback, and who can change the workspace.')} />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <input
          disabled
          placeholder="name@company.com"
          className="h-10 flex-1 rounded-md border border-line bg-surface px-3 text-[15px] placeholder:text-faint"
        />
        <button
          type="button"
          disabled
          className="h-10 rounded-full bg-faint px-5 text-sm font-semibold text-white"
          title={t('Invitations come after the beta')}
        >
          {t('Invite')}
        </button>
      </div>
      <p className="mb-4 text-xs text-muted">
        {t('Invitations come after the beta. Until then, each person signs in and makes their own workspace.')}
      </p>
      <Card>
        <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-line px-4 py-3 text-xs text-muted sm:grid-cols-[1fr_120px_120px]">
          <span>{t('Person')}</span>
          <span>{t('Role')}</span>
          <span className="hidden sm:block">{t('Sites')}</span>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 sm:grid-cols-[1fr_120px_120px]">
          <span className="flex min-w-0 items-center gap-3">
            <Initial name={name} />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold">{name}</span>
              <span className="block truncate text-xs text-muted">{me.account.email}</span>
            </span>
          </span>
          <span>
            <Chip tone={workspace.role === 'owner' ? 'accent' : 'neutral'}>{t(ROLE_WORDS[workspace.role])}</Chip>
          </span>
          <span className="hidden text-sm sm:block">{t('All')}</span>
        </div>
      </Card>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-semibold">{t('Admin')}</dt>
          <dd className="text-muted">{t('Sites, connectors, members.')}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t('Member')}</dt>
          <dd className="text-muted">{t('Every site. Sees the tracker links.')}</dd>
        </div>
        <div>
          <dt className="font-semibold">{t('Guest')}</dt>
          <dd className="text-muted">{t('Only the sites shared with them. Free, never sees the tracker.')}</dd>
        </div>
      </dl>
    </>
  );
}
