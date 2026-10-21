import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate, useOutletContext } from 'react-router';
import { API, type Me, callUntilAnswered, knownMe, saveLanguage } from '../api';
import { adoptLanguage, msg, t } from '../i18n';
import { instanceOf } from '../instance';
import { useLocale } from '../use-locale';
import { RAIL_HEAD, RailFrame, RailNav } from './workspace';

/**
 * The frame of the administration of the instance, as screens 17 to 20 of the mockup of 2026-10-13
 * draw it (FRU-262): the dark rail with the instance and its screens, and the screen beside it.
 *
 * Only the administrator of the instance (`instanceAdmin` of `/console/me`, FRU-261) sees it. Any
 * other account goes to the front door, as for a page that does not exist. The worker answers `404`
 * to each route of the administration for them: this redirect protects nothing alone.
 */

export type AdminContext = { me: Me };

export function useAdmin(): AdminContext {
  return useOutletContext<AdminContext>();
}

/**
 * The screens of the administration, in the order of the mockup. The rail shows an entry only for a
 * screen that exists. `layout` is a whole class name, so Tailwind finds it.
 */
const SCREENS = [
  { path: '/admin', label: msg('Instance'), layout: 'max-w-[1040px] flex flex-col gap-[44px]' },
  { path: '/admin/workspaces', label: msg('Workspaces'), layout: 'max-w-[1240px]' },
  { path: '/admin/users', label: msg('Users'), layout: 'max-w-[1240px]' },
  { path: '/admin/notes', label: msg('Notes'), layout: 'max-w-[1240px]' },
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
      if (me.data.instanceAdmin !== true) return navigate('/', { replace: true });
      setContext({ me: me.data });
    });
  }, [navigate]);

  if (context === undefined) return <p className="p-8 text-sm text-muted">{t('Loading…')}</p>;

  const current = SCREENS.find((screen) => screen.path === pathname);

  return (
    <div className="flex min-h-screen flex-wrap bg-page text-ink max-[887px]:content-start">
      <AdminRail current={current?.path} back={context.me.workspaces[0]?.id} />
      <div className="min-w-0 flex-[999_1_640px]">
        <main
          className={`kit-screen box-border px-[clamp(16px,4vw,48px)] pt-[40px] pb-[72px] ${current?.layout ?? ''}`}
        >
          <Outlet context={context} />
        </main>
      </div>
    </div>
  );
}

/**
 * The rail of the instance: its host and what it is, the screens of the administration, the way back
 * to the workspaces of the person, and the guide of a server.
 */
function AdminRail({ current, back }: { current: string | undefined; back: string | undefined }) {
  useLocale();
  const instance = instanceOf(API);
  const head = (
    <div className={RAIL_HEAD}>
      <span
        aria-hidden="true"
        className="box-border flex h-[32px] w-[32px] flex-none items-center justify-center rounded-field border border-ink-soft"
      >
        <svg viewBox="16 6 96 116" className="h-[16px] w-[13px] fill-rail-accent">
          <path
            fillRule="evenodd"
            d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z M 64 37 A 17 17 0 1 0 64 71 A 17 17 0 1 0 64 37 Z"
          />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body leading-auto font-semibold">{instance.host}</span>
        <span className="block text-tiny text-rail-muted">
          {instance.cloud ? t('Fruitback Cloud') : t('Self-hosted instance')}
        </span>
      </span>
    </div>
  );

  return (
    <RailFrame head={head} foot={{ href: GUIDE, label: t('Self-hosting guide') }}>
      <RailNav
        label={t('Instance')}
        entries={[
          ...SCREENS.map((screen) => ({ to: screen.path, label: t(screen.label), current: screen.path === current })),
          // Straight to the first workspace: the front door asked three questions before it went there.
          { to: back === undefined ? '/' : `/w/${back}/sites`, label: t('My workspaces'), current: false },
        ]}
      />
    </RailFrame>
  );
}
