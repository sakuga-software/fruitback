import type { ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { msg, t } from '../i18n';
import { SettingsIcon, type SettingsIconName } from '../settings-icons';
import { useLocale } from '../use-locale';
import { useWorkspace } from './workspace';

/**
 * The shell of the settings (FRU-692): the page of the person and the settings of the workspace in
 * one frame. A bar that says « Settings », a navigation of 220 px with an icon on each entry, in two
 * groups, « Account » and « Workspace », and the page beside it.
 *
 * A page of the shell is a route under the layout `routes/settings-shell.tsx` in `routes.ts`. It draws
 * its head with `SettingsHead`: a title of 20 px, its sentence, and its actions at the right.
 */

/** A page of the settings: an entry of their navigation. */
export type SettingsPage = {
  /** The path under `/w/<workspace>/`. */
  path: string;
  label: string;
  icon: SettingsIconName;
  /**
   * The page exists. The navigation shows no entry for a page that does not, so no entry leads
   * nowhere: `settings-shell.test.ts` holds `built` to the routes of `routes.ts`.
   */
  built: boolean;
};

/**
 * The pages of the person, in the order of the mockup. « Appearance » is FRU-694. « Sign-in and
 * addresses » and « Notifications » have no ticket yet: the profile shows the addresses and the ways
 * to sign in, and the console sends no notification it could choose.
 */
export const ACCOUNT_PAGES: readonly SettingsPage[] = [
  { path: 'account', label: msg('Profile'), icon: 'profile', built: true },
  { path: 'account/sign-in', label: msg('Sign-in and addresses'), icon: 'key', built: false },
  { path: 'account/sessions', label: msg('Sessions'), icon: 'screen', built: true },
  { path: 'account/appearance', label: msg('Appearance'), icon: 'appearance', built: false },
  { path: 'account/notifications', label: msg('Notifications'), icon: 'bell', built: false },
];

/**
 * The pages of the workspace, in the order of the mockup. « General » is the page of FRU-414, which
 * FRU-693 draws again. « Members » and « Connectors » are the screens of the rail: their entries
 * lead there, out of the shell.
 */
export const WORKSPACE_PAGES: readonly SettingsPage[] = [
  { path: 'settings', label: msg('General'), icon: 'general', built: true },
  { path: 'settings/ai', label: msg('AI'), icon: 'ai', built: true },
  { path: 'settings/agents', label: msg('Agents'), icon: 'agents', built: true },
  { path: 'members', label: msg('Members'), icon: 'members', built: true },
  { path: 'connectors', label: msg('Connectors'), icon: 'connectors', built: true },
];

/**
 * The shell. `Screen` of the frame gives every screen its padding: the shell takes it back, with the
 * same values, so its bar and its navigation reach the edges of the column, as the mockup draws them.
 */
export default function SettingsShell() {
  useLocale();
  const context = useWorkspace();

  return (
    <div className="kit-settings -mx-[clamp(16px,4vw,48px)] -mt-[40px] -mb-[72px] flex flex-col">
      {/* The name of the frame, as the mockup draws it above the page: no heading, the page has its own. */}
      <div className="flex h-[48px] flex-none items-center border-b border-line px-[20px] text-lead leading-auto font-semibold">
        {t('Settings')}
      </div>
      {/* As high as the window under the bar, so the rule of the navigation reaches its foot. */}
      <div className="grid min-[768px]:min-h-[calc(100dvh-48px)] min-[768px]:grid-cols-[220px_minmax(0,1fr)]">
        <SettingsNav workspace={context.workspace.id} />
        <div className="min-w-0 px-[clamp(16px,3vw,32px)] pt-[24px] pb-[72px]">
          <Outlet context={context} />
        </div>
      </div>
    </div>
  );
}

/** Whether `page` is the one on screen: its own path, not a page under it (`account` and `account/sessions`). */
function onScreen(pathname: string, workspace: string, page: SettingsPage): boolean {
  return pathname.replace(/\/$/, '') === `/w/${workspace}/${page.path}`;
}

/**
 * The navigation of the settings: two groups of links, each named by its title. The page on screen
 * has `aria-current="page"`. Under 768 px it is one row above the page, which scrolls in its frame,
 * and the page never scrolls sideways.
 */
export function SettingsNav({ workspace }: { workspace: string }) {
  useLocale();
  const { pathname } = useLocation();
  const groups = [
    { id: 'settings-account', title: t('Account'), pages: ACCOUNT_PAGES },
    { id: 'settings-workspace', title: t('Workspace'), pages: WORKSPACE_PAGES },
  ];

  return (
    <nav
      aria-label={t('Settings')}
      className="kit-settings-nav flex min-w-0 gap-[1px] border-line px-[10px] py-[8px] max-[767px]:flex-row max-[767px]:overflow-x-auto max-[767px]:border-b max-[767px]:[scrollbar-width:none] min-[768px]:flex-col min-[768px]:border-r"
    >
      {groups.map((group) => (
        <div key={group.id} className="flex flex-none flex-col gap-[1px] max-[767px]:flex-row">
          <p
            id={group.id}
            className="px-[8px] pt-[14px] pb-[4px] text-tiny leading-none font-semibold tracking-[0.01em] text-muted max-[767px]:hidden"
          >
            {group.title}
          </p>
          <ul aria-labelledby={group.id} className="flex flex-col gap-[1px] max-[767px]:flex-row">
            {group.pages
              .filter((page) => page.built)
              .map((page) => {
                const current = onScreen(pathname, workspace, page);

                return (
                  <li key={page.path} className="flex flex-none">
                    <Link
                      to={`/w/${workspace}/${page.path}`}
                      viewTransition
                      {...(current ? { 'aria-current': 'page' as const } : {})}
                      className={`flex h-control-md min-w-0 flex-1 items-center gap-[8px] rounded-control px-[8px] text-small leading-none whitespace-nowrap no-underline ${
                        current
                          ? 'bg-selected font-semibold text-ink'
                          : 'font-medium text-ink-soft [&:hover]:bg-hover [&:hover]:text-ink'
                      }`}
                    >
                      <span className={`inline-flex ${current ? 'text-ink-soft' : 'text-muted'}`}>
                        <SettingsIcon name={page.icon} />
                      </span>
                      <span className="truncate">{t(page.label)}</span>
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * The head of a page of the settings: its title, 20 px, the sentence of what the page is for, and the
 * actions of the page at the right (« Sign out »).
 */
export function SettingsHead({ title, lead, action }: { title: string; lead: string; action?: ReactNode }) {
  return (
    <header className="kit-settings-head mb-[20px] flex flex-wrap items-end gap-x-[24px] gap-y-[12px]">
      <div className="min-w-0 flex-[1_1_320px]">
        <h1 className="text-title font-semibold tracking-[-0.01em]">{title}</h1>
        <p className="mt-[6px] text-small text-muted">{lead}</p>
      </div>
      {action === undefined ? null : <div className="ms-auto flex flex-none flex-wrap gap-[8px]">{action}</div>}
    </header>
  );
}
