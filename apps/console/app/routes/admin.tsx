import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate, useOutletContext } from 'react-router';
import { API, type Account, type Me, callUntilAnswered, knownMe, saveLanguage } from '../api';
import { adoptLanguage, msg, t } from '../i18n';
import { adoptAppearance } from '../appearance';
import { instanceOf } from '../instance';
import { RailIcon, type RailIconName } from '../rail-icons';
import { ReleaseBanner } from '../release-banner';
import { useLocale } from '../use-locale';
import { ACCOUNT, Frame, RAIL_HEAD, RailFoot, RailFrame, RailNav, Screen } from './workspace';

/**
 * The frame of the administration of the instance, as screens 17 to 20 of the mockup of 2026-10-13
 * draw it (FRU-262): the bar with the instance and its screens, and the screen beside it. The bar is
 * the compact one of FRU-684, as for a workspace.
 *
 * Only the administrator of the instance (`instanceAdmin` of `/console/me`, FRU-261) sees it. Any
 * other account goes to the front door, as for a page that does not exist. The worker answers `404`
 * to each route of the administration for them: this redirect protects nothing alone.
 */

type AdminContext = { me: Me };

export function useAdmin(): AdminContext {
  return useOutletContext<AdminContext>();
}

/**
 * The screens of the administration, in the order of the mockup. The bar shows an entry only for a
 * screen that exists. `layout` is a whole class name, so Tailwind finds it. It sets no width: a
 * screen is as wide as its column (FRU-398).
 */
const SCREENS: readonly { path: string; label: string; layout: string; icon: RailIconName }[] = [
  { path: '/admin', label: msg('Instance'), layout: 'flex flex-col gap-[44px]', icon: 'instance' },
  { path: '/admin/workspaces', label: msg('Workspaces'), layout: '', icon: 'workspaces' },
  { path: '/admin/users', label: msg('Users'), layout: '', icon: 'members' },
  { path: '/admin/notes', label: msg('Notes'), layout: '', icon: 'notes' },
];

const GUIDE = 'https://fruitback.com/self-hosting.html';

export default function AdminFrame() {
  useLocale();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Drawn at once from the last answer of this tab (FRU-356), and read again below. The worker
  // answers `404` to each route of the administration for anybody else: this protects nothing alone.
  const [context, setContext] = useState<AdminContext | undefined>(() => {
    const me = knownMe();

    return me?.instanceAdmin === true ? { me } : undefined;
  });

  // No answer is not a signed-out person: the call waits under the banner and asks again.
  useEffect(() => {
    return callUntilAnswered<Me>('GET', '/console/me', (me) => {
      if (!me.ok) return navigate('/sign-in', { replace: true });
      adoptLanguage(me.data.account, saveLanguage);
      adoptAppearance(me.data.account);
      if (me.data.instanceAdmin !== true) return navigate('/', { replace: true });
      setContext({ me: me.data });
    });
  }, [navigate]);

  if (context === undefined) return <p className="p-8 text-sm text-muted">{t('Loading…')}</p>;

  const current = SCREENS.find((screen) => screen.path === pathname);

  return (
    <Frame
      rail={<AdminRail current={current?.path} back={context.me.workspaces[0]?.id} account={context.me.account} />}
    >
      {/* The screen « Instance » says the release itself. */}
      <ReleaseBanner show={pathname !== '/admin'} />
      <Screen className={current?.layout ?? ''}>
        <Outlet context={context} />
      </Screen>
    </Frame>
  );
}

/**
 * The bar of the instance: its host and what it is, the screens of the administration, the way back
 * to the workspaces of the person, and a foot with the guide of a server in place of the help.
 */
function AdminRail({
  current,
  back,
  account,
}: {
  current: string | undefined;
  back: string | undefined;
  account: Account;
}) {
  useLocale();
  const instance = instanceOf(API);
  // The host, and what it is: the words of the tile are read, the tile is not.
  const head = (
    <div className={`${RAIL_HEAD} hover:bg-transparent`}>
      <span
        aria-hidden="true"
        className="flex h-[20px] w-[20px] flex-none items-center justify-center rounded-inner bg-ink text-on-ink"
      >
        <RailIcon name="instance" small />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {instance.host}
        <span className="sr-only">, </span>
        <span className="ms-[6px] text-hint font-medium text-muted">
          {instance.cloud ? t('Fruitback Cloud') : t('Self-hosted instance')}
        </span>
      </span>
    </div>
  );

  return (
    <RailFrame
      head={head}
      foot={
        <RailFoot
          help={{ href: GUIDE, label: t('Self-hosting guide') }}
          account={account}
          {...(back === undefined ? {} : { accountPage: `/w/${back}/${ACCOUNT}` })}
        />
      }
    >
      <RailNav
        label={t('Instance')}
        entries={[
          ...SCREENS.map((screen) => ({
            to: screen.path,
            label: t(screen.label),
            current: screen.path === current,
            icon: screen.icon,
          })),
          // Straight to the first workspace: the front door asked three questions before it went there.
          // The arrow says the link leaves the administration (FRU-476).
          {
            to: back === undefined ? '/' : `/w/${back}/sites`,
            label: t('My workspaces'),
            current: false,
            icon: 'back',
          },
        ]}
      />
    </RailFrame>
  );
}
