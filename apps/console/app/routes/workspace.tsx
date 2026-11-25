import { type ComponentProps, type ReactNode, useEffect, useId, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router';
import {
  type Account,
  type Me,
  type Role,
  type Workspace,
  callUntilAnswered,
  knownMe,
  logoSource,
  onWorkspaceSuspended,
  saveLanguage,
  signOut,
} from '../api';
import { dayOf } from '../ago';
import { adoptLanguage, msg, t } from '../i18n';
import { extensionInstallFor } from '../extension-store';
import { useConnectedExtension } from '../extension-connected';
import { BY_SIGN_IN, CONNECT_PAGE } from '../install-options';
import { IconButton, PageHead as KitPageHead, Menu } from '../ui';
import { ReleaseBanner } from '../release-banner';
import { RailIcon, type RailIconName } from '../rail-icons';
import { manages } from '../setup-stage';
import { useLocale } from '../use-locale';
import { underSettings } from '../settings-path';
import { CONSOLE_VERSION, RELEASES, hasNews, markSeen, seenVersion } from '../whats-new';

/**
 * The frame of a workspace (FRU-234): the bar with the workspace and its sections, and the section
 * beside it. The bar is the compact one of FRU-684: from 1024 px it is beside the section, and under
 * 1024 px it is folded above it.
 */

type WorkspaceContext = {
  me: Me;
  workspace: Workspace;
  /** The worker renamed the workspace (FRU-414): the bar shows the new name at once. */
  renamed: (workspace: Workspace) => void;
  /** The worker kept a new logo, or removed it (FRU-428): the bar shows it at once. */
  logoChanged: (logo: string | null) => void;
};

type Read = Omit<WorkspaceContext, 'renamed' | 'logoChanged'>;

export function useWorkspace(): WorkspaceContext {
  return useOutletContext<WorkspaceContext>();
}

/** A section of a workspace: an entry of the bar. */
export type Section = { path: string; label: string; built: boolean };

/**
 * The sections, in the order of the mockup of FRU-684. `built` says that the screen exists: the bar
 * shows no entry for a screen that does not, so no entry leads nowhere. `frame.test.ts` holds `built`
 * to the routes of `routes.ts`. « My account » is no section: the menu of the person, at the foot of
 * the bar, leads to it (`ACCOUNT`).
 */
export const SECTIONS: readonly Section[] = [
  { path: 'notes', label: msg('Notes'), built: true },
  { path: 'sites', label: msg('Sites'), built: true },
  { path: 'connectors', label: msg('Connectors'), built: true },
  { path: 'members', label: msg('Members'), built: true },
  { path: 'settings', label: msg('Settings'), built: true },
];

/** The screen of the person, which the menu at the foot of the bar opens (FRU-684). */
export const ACCOUNT = 'account';

/**
 * The settings of the workspace are an entry of the bar for whoever manages it (FRU-503): an owner
 * or an admin renames it, changes its logo and makes its agent keys there, and the owner deletes it.
 * Another role still reads them from the name of the workspace, at the top of the bar.
 */
function sectionsFor(workspace: Workspace): readonly Section[] {
  return SECTIONS.filter((section) => section.built && (section.path !== 'settings' || manages(workspace)));
}

/** The icon of each section of the bar (FRU-477). */
const SECTION_ICONS: Readonly<Record<string, RailIconName>> = {
  sites: 'sites',
  notes: 'notes',
  connectors: 'connectors',
  members: 'members',
  settings: 'settings',
};

const ROLE_WORDS: Readonly<Record<Role, string>> = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};

/** The context of workspace `id` in what `/console/me` answered, if it names it. */
function contextOf(me: Me | undefined, id: string | undefined): Read | undefined {
  const workspace = me?.workspaces.find((each) => each.id === id);

  return me === undefined || workspace === undefined ? undefined : { me, workspace };
}

export default function WorkspaceFrame() {
  useLocale();
  const { workspace: id } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Drawn at once from the last answer of this tab (FRU-356), and read again below.
  const [read, setContext] = useState<Read | undefined>(() => contextOf(knownMe(), id));
  // Asks `/console/me` again: after a rename, so that the answer this tab keeps has the new name.
  const [asked, askAgain] = useState(0);
  // A change of workspace draws the new one from the last answer too, while the worker is asked.
  const context = read?.workspace.id === id ? read : (contextOf(knownMe(), id) ?? read);

  // No answer is not a signed-out person: the call waits under the banner and asks again.
  useEffect(() => {
    return callUntilAnswered<Me>('GET', '/console/me', (me) => {
      if (!me.ok) return navigate('/sign-in', { replace: true });
      adoptLanguage(me.data.account, saveLanguage);
      const workspace = me.data.workspaces.find((each) => each.id === id);
      if (workspace === undefined) return navigate('/', { replace: true });
      setContext({ me: me.data, workspace });
    });
  }, [id, navigate, asked]);

  // A write refused because the workspace is suspended shows the banner, also when the suspension
  // came after `/console/me` was read. Only a refusal of the workspace on screen: a write sent in
  // another workspace can be answered after the person came here.
  useEffect(
    () =>
      onWorkspaceSuspended((workspace, suspendedAt) =>
        setContext((current) =>
          current === undefined || current.workspace.id !== workspace || current.workspace.suspended === true
            ? current
            : {
                ...current,
                workspace: {
                  ...current.workspace,
                  suspended: true,
                  ...(suspendedAt === undefined ? {} : { suspendedAt }),
                },
              },
        ),
      ),
    [],
  );

  // WARNING: the context of another workspace is not shown. After a change of workspace the address
  // names the new one at once, and the answer of the worker comes later: a screen drawn in between
  // would read, and write, in the workspace of before.
  if (context === undefined || context.workspace.id !== id)
    return <p className="p-8 text-sm text-muted">{t('Loading…')}</p>;

  /** Writes `change` in the workspace on screen, and asks `/console/me` again for the tab to keep it. */
  const changed = (change: Partial<Pick<Workspace, 'name' | 'logo'>>) => {
    const id = context.workspace.id;
    const apply = (each: Workspace) => (each.id === id ? { ...each, ...change } : each);
    setContext({
      me: { ...context.me, workspaces: context.me.workspaces.map(apply) },
      workspace: apply(context.workspace),
    });
    askAgain((count) => count + 1);
  };
  const outlet: WorkspaceContext = {
    ...context,
    renamed: (workspace) => changed({ name: workspace.name }),
    logoChanged: (logo) => changed({ logo }),
  };

  const sections = sectionsFor(context.workspace);
  const current = sections.find((section) => pathname.startsWith(`/w/${context.workspace.id}/${section.path}`));

  return (
    <Frame
      rail={
        <Rail
          workspace={context.workspace}
          workspaces={context.me.workspaces}
          sections={sections}
          current={current?.path}
          onWorkspace={(chosen) => navigate(`/w/${chosen}/sites`, { viewTransition: true })}
          onSettings={() => navigate(`/w/${context.workspace.id}/settings`, { viewTransition: true })}
          // The entry « Settings » is the one on screen when the rail has it: the name is not a second one.
          // Every page of the settings is the settings: « General » and « AI » (FRU-544).
          settings={current?.path !== 'settings' && underSettings(pathname, context.workspace.id)}
          admin={context.me.instanceAdmin === true}
          account={context.me.account}
        />
      }
    >
      <ReleaseBanner show={context.me.instanceAdmin === true} />
      <SuspendedBanner workspace={context.workspace} />
      <Screen>
        <Outlet context={outlet} />
      </Screen>
    </Frame>
  );
}

/**
 * The frame of a workspace and of the instance: the bar, and the column of the screen beside it.
 *
 * From 1024 px the bar is beside the column, 232 px wide (FRU-684), and is as high as the window: it
 * stays in place while the document scrolls the screen (FRU-402). The document scrolls, not the
 * column, so the keys of the keyboard, `scrollIntoView` and the address of an anchor keep their usual
 * scroller. `flex-nowrap` there: with a classic scroll bar the window is wider than the document, and
 * the column would wrap under a bar as high as the window.
 *
 * Under 1024 px the bar is folded above the column, at its own height.
 *
 * **The screen fills the height of the window** (FRU-564): the column is a flex column, and `Screen`
 * takes what is left under the banner of a suspended workspace. Under 1024 px the frame is a column
 * too, so the column of the screen takes the height under the bar, and the bar none of it.
 */
export function Frame({ rail, children }: { rail: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-page text-ink max-[1023px]:flex-col">
      {rail}
      <div className="flex min-w-0 flex-[999_1_640px] flex-col max-[1023px]:flex-[1_0_auto]">{children}</div>
    </div>
  );
}

/**
 * The room of a screen: as wide as the column beside the bar (FRU-398), with the padding of the
 * mockup. The mockup capped each screen at its own width (820 to 1240 px), which left an empty band
 * at the right of a wide window. `className` adds the layout of a screen, never a width.
 */
export function Screen({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <main className={`kit-screen box-border flex-1 px-[clamp(16px,4vw,48px)] pt-[40px] pb-[72px] ${className}`}>
      {children}
    </main>
  );
}

/**
 * Says to a member that an administrator of the instance suspended the workspace (FRU-328): since
 * when, what still works, and who to ask. Every write of the workspace is refused while it shows.
 *
 * No reason: it is a note of the administrator of the instance, which the worker answers to them only.
 */
function SuspendedBanner({ workspace }: { workspace: Workspace }) {
  useLocale();
  if (workspace.suspended !== true) return null;

  return (
    <div
      role="status"
      className="border-b border-line bg-subtle px-[clamp(16px,4vw,48px)] py-[14px] text-small leading-auto text-ink"
    >
      <p className="font-semibold text-accent-strong">
        {workspace.suspendedAt === undefined
          ? t('This workspace is suspended.')
          : t('This workspace has been suspended since {day}.', { day: dayOf(workspace.suspendedAt) })}
      </p>
      <p className="mt-[2px]">
        {t(
          'An administrator of this instance suspended it. You can still read it, but nothing in it can change, and its sites take no notes. To restore it, contact the administrator of this instance.',
        )}
      </p>
    </div>
  );
}

type RailProps = {
  workspace: Workspace;
  /** Every workspace of the person. With one alone, the name opens no menu. */
  workspaces: readonly Workspace[];
  sections: readonly Section[];
  /** The `path` of the section on screen. */
  current: string | undefined;
  onWorkspace: (id: string) => void;
  /** Opens the settings of the workspace (FRU-414), from its name. */
  onSettings: () => void;
  /** The settings of the workspace are on screen. */
  settings?: boolean;
  /** The person administers the instance (FRU-262): the bar leads to the administration. */
  admin?: boolean;
  /** The person signed in: the menu at the foot of the bar (FRU-684). */
  account: Account;
  /**
   * The counts at the right of the entries, by the `path` of a section (FRU-684). A section with no
   * count shows none: no read gives them yet, and the bar asks nothing for them.
   */
  counts?: Readonly<Partial<Record<string, number>>>;
  /** How many sends of the connectors failed: a red dot and the number on « Connectors ». */
  failing?: number;
};

/**
 * An entry of the bar: where it leads, its words, whether its screen is the one shown, its icon
 * (FRU-477), and what it counts at its right (FRU-684). `alert` is a count that something failed.
 */
type RailEntry = { to: string; label: string; current: boolean; icon?: RailIconName; count?: number; alert?: number };

/** The item of the menu of the workspaces that opens the settings: no workspace id has a space. */
const SETTINGS = 'workspace settings';

/**
 * The classes of an entry of the bar (FRU-684): 28 px, 8 px in, the icon 16 px and 8 px from the
 * words. Under the pointer an entry takes `hover`, a step lighter than the entry on screen.
 */
const ENTRY =
  'flex h-control-md min-w-0 items-center gap-[8px] rounded-control px-[8px] text-label leading-none font-medium whitespace-nowrap text-ink-soft hover:bg-hover hover:text-ink';
/** The entry on screen: the tint, and its words in 600. */
const ENTRY_CURRENT = 'bg-selected font-semibold text-ink';
/** The icon of an entry, in the secondary text of the bar. */
const ENTRY_ICON = 'inline-flex flex-none text-muted';
/** A count at the right of an entry. */
const COUNT = 'ms-auto flex-none text-hint leading-none font-medium text-muted tabular-nums';

/** The classes of the box at the top of the bar: what the bar is of. */
export const RAIL_HEAD =
  'flex h-control-lg min-w-0 flex-1 items-center gap-[8px] rounded-control px-[6px] text-left text-label leading-none font-semibold text-ink hover:bg-hover';

/**
 * The bar of the mockup (FRU-684, option A), for a workspace or for the instance (FRU-262): what it
 * is of and a button beside it, its entries, and a fixed foot. Each link of the foot that leaves the
 * console opens in another tab.
 *
 * From 1024 px the bar is 232 px wide, beside the screen, as high as the window, and stays in place
 * while the screen scrolls (FRU-402); a window lower than the bar scrolls the bar itself. Under
 * 1024 px it is folded above the screen: its head, and a button that unfolds the entries and the foot
 * under it. A move to another screen folds it again.
 */
export function RailFrame({
  head,
  tool,
  children,
  foot,
}: {
  head: ReactNode;
  /** A button beside the head: the search of a workspace. */
  tool?: ReactNode;
  children: ReactNode;
  foot: ReactNode;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  // A move folds the bar: the screen the person chose is under it.
  useEffect(() => setOpen(false), [pathname]);
  const panel = useId();

  return (
    <aside
      data-open={open}
      // Escape folds the bar that was unfolded, and gives focus back to its button.
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open || event.defaultPrevented) return;
        setOpen(false);
        event.currentTarget.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(panel)}"]`)?.focus();
      }}
      className="kit-rail group/rail [view-transition-name:rail] box-border flex min-w-0 flex-col border-line bg-sidebar pt-[4px] text-ink max-[1023px]:flex-none max-[1023px]:border-b min-[1024px]:sticky min-[1024px]:top-0 min-[1024px]:h-dvh min-[1024px]:w-[232px] min-[1024px]:flex-none min-[1024px]:overflow-y-auto min-[1024px]:border-r"
    >
      <div className="flex h-[40px] flex-none items-center gap-[8px] px-[6px]">
        {head}
        {tool}
        <span className="inline-flex flex-none min-[1024px]:hidden">
          <IconButton
            label={t('Menu')}
            size="chip"
            expanded={open}
            controls={panel}
            onClick={() => setOpen((before) => !before)}
          >
            <RailIcon name="menu" />
          </IconButton>
        </span>
      </div>
      <div
        id={panel}
        className="flex flex-1 flex-col max-[1023px]:hidden max-[1023px]:group-data-[open=true]/rail:flex"
      >
        {children}
        <div className="mt-auto flex flex-col gap-px px-[6px] pt-[6px] pb-[8px]">{foot}</div>
      </div>
    </aside>
  );
}

/**
 * The bar of a workspace: the workspace and the search of its notes, its sections, and the foot. The
 * sections are links, and the one on screen has `aria-current="page"`.
 */
export function Rail({
  workspace,
  workspaces,
  sections,
  current,
  onWorkspace,
  onSettings,
  settings = false,
  admin = false,
  account,
  counts = {},
  failing = 0,
}: RailProps) {
  useLocale();
  const name = (
    <>
      <WorkspaceMark workspace={workspace} size={20} />
      <span className="min-w-0 truncate">{workspace.name}</span>
    </>
  );
  const head =
    workspaces.length > 1 ? (
      <Menu
        triggerClassName={RAIL_HEAD}
        chosen={workspace.id}
        choiceLabel={t('Workspaces')}
        onAction={(chosen) => {
          if (chosen === SETTINGS) onSettings();
          else if (chosen !== workspace.id) onWorkspace(chosen);
        }}
        items={workspaces.map((each) => ({ id: each.id, label: each.name, detail: t(ROLE_WORDS[each.role]) }))}
        after={[{ id: SETTINGS, label: t('Workspace settings') }]}
      >
        {name}
        <span className="inline-flex flex-none text-muted">
          <RailIcon name="chevron" small />
        </span>
      </Menu>
    ) : (
      // One workspace: its name leads to its settings (FRU-414). A screen reader hears where.
      <Link
        to={`/w/${workspace.id}/settings`}
        viewTransition
        {...(settings ? { 'aria-current': 'page' as const } : {})}
        className={`${RAIL_HEAD} ${settings ? 'bg-selected' : ''}`}
      >
        {name}
        <span className="sr-only"> {t('Workspace settings')}</span>
      </Link>
    );
  // The search of the bar is the one of the notes (FRU-684): no screen searches the whole workspace.
  const search = (
    <Link
      to={`/w/${workspace.id}/notes`}
      state={{ search: true }}
      viewTransition
      aria-label={t('Search notes')}
      className="inline-flex h-control-md w-control-md flex-none items-center justify-center rounded-control text-ink-soft hover:bg-hover"
    >
      <RailIcon name="search" small />
    </Link>
  );

  return (
    <RailFrame
      head={head}
      tool={search}
      foot={
        <RailFoot
          help={{ href: 'https://fruitback.com', label: t('Help and docs') }}
          account={account}
          accountPage={`/w/${workspace.id}/${ACCOUNT}`}
        />
      }
    >
      <RailNav
        label={t('Workspace')}
        entries={sections.map((section) => ({
          to: `/w/${workspace.id}/${section.path}`,
          label: t(section.label),
          current: section.path === current,
          ...(SECTION_ICONS[section.path] === undefined ? {} : { icon: SECTION_ICONS[section.path] }),
          ...(counts[section.path] === undefined ? {} : { count: counts[section.path] }),
          ...(section.path === 'connectors' && failing > 0 ? { alert: failing } : {}),
        }))}
      />
      {admin ? (
        <RailNav
          label={t('Instance')}
          entries={[{ to: '/admin', label: t('Administration'), current: false, icon: 'admin' }]}
        />
      ) : null}
    </RailFrame>
  );
}

/**
 * The mark of a workspace: its logo (FRU-428), or the initial of its name when it has none, or when
 * its logo does not load. The logo is drawn whole in its square, whatever its pixels: the worker
 * resizes nothing. Decorative: the name is beside it. 20 px in the bar (FRU-684), 64 px on the settings.
 */
export function WorkspaceMark({ workspace, size = 20 }: { workspace: Workspace; size?: 20 | 64 }) {
  const source = logoSource(workspace);
  // The address of the logo that did not load: another address (a new logo) is tried again.
  const [broken, setBroken] = useState<string | undefined>();
  // The 64 px of the settings are drawn as before FRU-684; the 20 px tile of the bar is ink.
  const box =
    size === 64 ? 'h-[64px] w-[64px] rounded-control text-section' : 'h-[20px] w-[20px] rounded-inner text-tiny';
  if (source !== undefined && source !== broken)
    return (
      <img
        src={source}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(source)}
        className={`${box} flex-none bg-page object-contain`}
      />
    );

  return (
    <span
      aria-hidden="true"
      className={`${box} flex flex-none items-center justify-center font-bold ${size === 64 ? 'bg-page leading-auto text-ink' : 'bg-ink leading-none text-on-ink'}`}
    >
      {workspace.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * A link of the foot that leaves the console: it opens in another tab, so a screen keeps what is
 * typed in it.
 */
function FootLink({
  href,
  icon,
  children,
  ...rest
}: { href: string; icon: ReactNode; children: ReactNode } & Omit<
  ComponentProps<'a'>,
  'href' | 'children' | 'className' | 'target' | 'rel'
>) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={ENTRY} {...rest}>
      {icon}
      {children}
    </a>
  );
}

/**
 * The fixed foot of the bar (FRU-684): « What's new », the extension, the help, a rule, and the menu
 * of the person. The foot of the instance has its guide in place of the help.
 */
export function RailFoot({
  help,
  account,
  accountPage,
}: {
  help: { href: string; label: string };
  account: Account;
  /** Where « My account » leads. Absent: the menu has no « My account ». */
  accountPage?: string;
}) {
  useLocale();

  return (
    <>
      <WhatsNew />
      <ExtensionEntry />
      <FootLink
        href={help.href}
        icon={
          <span className={ENTRY_ICON}>
            <RailIcon name="help" />
          </span>
        }
      >
        <span className="min-w-0 truncate">{help.label}</span>
      </FootLink>
      <hr aria-hidden="true" className="mx-[2px] my-[6px] h-px border-0 bg-line" />
      <PersonMenu account={account} {...(accountPage === undefined ? {} : { accountPage })} />
    </>
  );
}

/** « What's new »: the releases of Fruitback, with a dot until this version of the console opened it. */
function WhatsNew() {
  useLocale();
  const [news, setNews] = useState(() => hasNews(CONSOLE_VERSION, seenVersion()));

  return (
    <FootLink
      href={RELEASES}
      icon={
        <span className={ENTRY_ICON}>
          <RailIcon name="news" />
        </span>
      }
      onClick={() => {
        if (CONSOLE_VERSION !== undefined) markSeen(CONSOLE_VERSION);
        setNews(false);
      }}
    >
      <span className="min-w-0 truncate">{t("What's new")}</span>
      {news ? (
        <>
          <span className="sr-only">, {t('new release')}</span>
          <span aria-hidden="true" data-news="" className="ms-auto size-[6px] flex-none rounded-full bg-accent" />
        </>
      ) : null}
    </FootLink>
  );
}

/**
 * The browser extension, at the foot of both bars (FRU-406). Chrome and Edge go to the Chrome Web
 * Store, where 0.3.0 is public, and Firefox to addons.mozilla.org (FRU-536). Every other browser goes
 * to the page that installs the archive of the release.
 *
 * With a browser of the extension connected to the account, the entry has a green dot on its icon and
 * names that browser at its right, and it leads to connect another one (FRU-441): `/connect` on
 * Fruitback Cloud, the page that installs it elsewhere, as a self-hosted console connects a browser
 * from a site.
 */
function ExtensionEntry() {
  useLocale();
  const connected = useConnectedExtension();
  const install = extensionInstallFor(navigator.userAgent);
  const icon = (
    <span className={`${ENTRY_ICON} relative`}>
      <RailIcon name="extension" />
      {connected === undefined ? null : (
        <span
          aria-hidden="true"
          data-connected=""
          className="absolute -right-[2px] -bottom-[2px] box-border size-[7px] rounded-full border-[1.5px] border-sidebar bg-done"
        />
      )}
    </span>
  );
  if (connected === undefined)
    return (
      <FootLink href={install} icon={icon}>
        <span className="min-w-0 truncate">{t('Install the extension (beta)')}</span>
      </FootLink>
    );

  return (
    <FootLink href={BY_SIGN_IN ? CONNECT_PAGE : install} icon={icon} data-rail-extension="">
      <span className="min-w-0 flex-none">{t('Extension')}</span>
      <span className="sr-only">, {t('connected in')}</span>
      {/* A long name ends with « … »; the whole of it is in the title. */}
      <span title={connected.browser} className="ms-auto min-w-0 truncate text-hint text-muted">
        {connected.browser}
      </span>
      <span className="sr-only">. {t('Connect another browser')}</span>
    </FootLink>
  );
}

/** The items of the menu of the person. */
const ACCOUNT_ITEM = 'account';
const SIGN_OUT_ITEM = 'sign-out';

/**
 * The person signed in, at the bottom of the bar (FRU-684): their initial, name and address, and a
 * menu with « My account » and « Sign out ». « Sign out » says nothing is done before the worker does
 * (FRU-204): when it does not confirm, the bar says so under the menu.
 */
function PersonMenu({ account, accountPage }: { account: Account; accountPage?: string }) {
  useLocale();
  const navigate = useNavigate();
  const [stillIn, setStillIn] = useState(false);
  const name = account.name?.trim() || account.email;

  async function leave() {
    setStillIn(false);
    if (await signOut()) return navigate('/setup', { replace: true });
    // The worker did not say that the session ended: it can still be good (FRU-204).
    setStillIn(true);
  }

  return (
    <>
      <Menu
        triggerClassName="flex h-[40px] w-full min-w-0 items-center gap-[8px] rounded-control px-[8px] text-left hover:bg-hover"
        items={[
          ...(accountPage === undefined ? [] : [{ id: ACCOUNT_ITEM, label: t('My account') }]),
          { id: SIGN_OUT_ITEM, label: t('Sign out') },
        ]}
        onAction={(id) => {
          if (id === ACCOUNT_ITEM && accountPage !== undefined) void navigate(accountPage, { viewTransition: true });
          else if (id === SIGN_OUT_ITEM) void leave();
        }}
      >
        <span
          aria-hidden="true"
          className="flex size-[24px] flex-none items-center justify-center rounded-full bg-avatar text-tiny leading-none font-semibold text-on-ink"
        >
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="truncate text-label leading-[1.1] font-semibold text-ink">{name}</span>
          {name === account.email ? null : (
            <span className="truncate text-hint leading-[1.1] text-muted">{account.email}</span>
          )}
        </span>
        <span className="inline-flex flex-none text-muted">
          <RailIcon name="upDown" small />
        </span>
      </Menu>
      {stillIn ? (
        <p role="alert" className="px-[8px] pt-[4px] text-hint text-accent-strong">
          {t('You are still signed in: Fruitback did not confirm the sign-out. Try again.')}
        </p>
      ) : null}
    </>
  );
}

/** What an entry counts, at its right: a count of what failed is red, after a red dot. */
function EntryCount({ count, alert }: { count: number | undefined; alert: number | undefined }) {
  useLocale();
  if (alert !== undefined)
    return (
      <span
        data-failing=""
        className="ms-auto inline-flex flex-none items-center gap-[4px] text-hint leading-none font-semibold text-accent-strong tabular-nums"
      >
        <span aria-hidden="true" className="size-[6px] rounded-full bg-accent" />
        <span className="sr-only">, {t('failed sends:')} </span>
        {alert}
      </span>
    );
  if (count === undefined) return null;

  return (
    <span className={COUNT}>
      <span className="sr-only">, </span>
      {count}
    </span>
  );
}

/**
 * The entries of the bar, one under the other. An entry has its icon, its words, and at its right
 * what it counts (FRU-684); a count of what failed is red, after a red dot. The words of a count are
 * read with the entry.
 */
export function RailNav({ label, entries }: { label: string; entries: readonly RailEntry[] }) {
  useLocale();

  return (
    <nav aria-label={label} className="flex min-w-0 flex-col gap-px px-[6px] py-[4px]">
      {entries.map((entry) => (
        <Link
          key={entry.to}
          to={entry.to}
          // A move between screens and frames cross-fades the screen, the bar held (FRU-356).
          viewTransition
          {...(entry.current ? { 'aria-current': 'page' as const } : {})}
          className={`${ENTRY} ${entry.current ? ENTRY_CURRENT : ''}`}
        >
          {entry.icon === undefined ? null : (
            <span className={`${ENTRY_ICON} ${entry.current ? 'text-ink-soft' : ''}`}>
              <RailIcon name={entry.icon} />
            </span>
          )}
          <span className="min-w-0 truncate">{entry.label}</span>
          <EntryCount count={entry.count} alert={entry.alert} />
        </Link>
      ))}
    </nav>
  );
}

/** The head of a page of the workspace: its title, what the page is for, and the action of the page. */
export function PageHead({ title, lead, action }: { title: string; lead: string; action?: ReactNode }) {
  return <KitPageHead title={title} lead={lead} {...(action === undefined ? {} : { action })} className="mb-[28px]" />;
}
