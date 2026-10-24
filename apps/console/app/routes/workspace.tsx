import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router';
import {
  type Me,
  type Role,
  type Workspace,
  callUntilAnswered,
  knownMe,
  onWorkspaceSuspended,
  saveLanguage,
} from '../api';
import { dayOf } from '../ago';
import { adoptLanguage, msg, t } from '../i18n';
import { extensionInstallFor } from '../extension-store';
import { useConnectedExtension } from '../extension-connected';
import { BY_SIGN_IN, CONNECT_PAGE } from '../install-options';
import { PageHead as KitPageHead, Logo, Menu } from '../ui';
import { useLocale } from '../use-locale';

/**
 * The frame of a workspace, as the mockup of 2026-10-13 draws it (FRU-234): a dark rail with the
 * workspace and its sections, and the section beside it. Under 888 px the rail is above the section,
 * and at 900 px and under its sections are one row.
 */

export type WorkspaceContext = {
  me: Me;
  workspace: Workspace;
  /** The worker renamed the workspace (FRU-414): the rail shows the new name at once. */
  renamed: (workspace: Workspace) => void;
};

type Read = Omit<WorkspaceContext, 'renamed'>;

export function useWorkspace(): WorkspaceContext {
  return useOutletContext<WorkspaceContext>();
}

/** A section of a workspace: an entry of the rail. */
export type Section = { path: string; label: string; built: boolean };

/**
 * The sections, in the order of the mockup. `built` says that the screen exists: the rail shows no
 * entry for a screen that does not, so no entry leads nowhere. `frame.test.ts` holds `built` to the
 * routes of `routes.ts`.
 */
export const SECTIONS: readonly Section[] = [
  { path: 'sites', label: msg('Sites'), built: true },
  { path: 'notes', label: msg('Notes'), built: true },
  { path: 'connectors', label: msg('Connectors'), built: true },
  { path: 'members', label: msg('Members'), built: true },
  { path: 'account', label: msg('My account'), built: true },
];

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

  const outlet: WorkspaceContext = {
    ...context,
    renamed: (workspace) => {
      const name = (each: Workspace) => (each.id === workspace.id ? { ...each, name: workspace.name } : each);
      setContext({
        me: { ...context.me, workspaces: context.me.workspaces.map(name) },
        workspace: name(context.workspace),
      });
      askAgain((count) => count + 1);
    },
  };

  const sections = SECTIONS.filter((section) => section.built);
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
          settings={pathname === `/w/${context.workspace.id}/settings`}
          admin={context.me.instanceAdmin === true}
        />
      }
    >
      <SuspendedBanner workspace={context.workspace} />
      <Screen>
        <Outlet context={outlet} />
      </Screen>
    </Frame>
  );
}

/**
 * The frame of a workspace and of the instance: the rail, and the column of the screen beside it.
 *
 * From 888 px (248 + 640) the rail is beside the column, and is as high as the window: it stays in
 * place while the document scrolls the screen (FRU-402). The document scrolls, not the column, so
 * the keys of the keyboard, `scrollIntoView` and the address of an anchor keep their usual scroller.
 * `flex-nowrap` there: with a classic scroll bar the window is wider than the document, and the
 * column would wrap under a rail as high as the window.
 *
 * Under 888 px the rail is above the column. `content-start` keeps it at its own height there: the
 * frame is at least as high as the window, and a short screen left the rest of that height to the
 * rail, as the mockup does at 390 px (286 px of rail on « did not load »).
 */
export function Frame({ rail, children }: { rail: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-wrap bg-page text-ink max-[887px]:content-start min-[888px]:flex-nowrap">
      {rail}
      <div className="min-w-0 flex-[999_1_640px]">{children}</div>
    </div>
  );
}

/**
 * The room of a screen: as wide as the column beside the rail (FRU-398), with the padding of the
 * mockup. The mockup capped each screen at its own width (820 to 1240 px), which left an empty band
 * at the right of a wide window. `className` adds the layout of a screen, never a width.
 */
export function Screen({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <main className={`kit-screen box-border px-[clamp(16px,4vw,48px)] pt-[40px] pb-[72px] ${className}`}>
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
export function SuspendedBanner({ workspace }: { workspace: Workspace }) {
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
  /** The person administers the instance (FRU-262): the rail leads to the administration. */
  admin?: boolean;
};

/** An entry of the rail: where it leads, its words, and whether its screen is the one shown. */
export type RailEntry = { to: string; label: string; current: boolean };

/** The item of the menu of the workspaces that opens the settings: no workspace id has a space. */
const SETTINGS = 'workspace settings';

/** The classes of the box at the top of the rail: what the rail is of. */
export const RAIL_HEAD = 'flex w-full items-center gap-[10px] rounded-box p-[8px] text-left text-white';

/**
 * The dark rail of the mockup, for a workspace or for the instance (FRU-262): what it is of, its
 * entries, what more the frame puts under them, and a foot with the way to the extension (FRU-406)
 * and to the documentation. Each link of the foot opens in another tab.
 *
 * `kit-rail` gives every control in it the focus ring of the rail.
 */
export function RailFrame({
  head,
  children,
  foot,
}: {
  head: ReactNode;
  children: ReactNode;
  foot: readonly RailLink[];
}) {
  return (
    // From 888 px the rail is beside the screen, as high as the window, and stays in place while the
    // screen scrolls (FRU-402). A window lower than the rail scrolls the rail itself.
    <aside className="kit-rail box-border flex min-w-0 flex-[1_1_248px] flex-col gap-[20px] bg-rail px-[12px] py-[16px] text-white min-[888px]:sticky min-[888px]:top-0 min-[888px]:h-dvh min-[888px]:overflow-y-auto">
      {head}
      {children}
      <div className="mt-auto flex flex-col gap-[14px] p-[8px] max-[900px]:hidden">
        {foot.map((link) => {
          const anchor = (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="self-start text-small leading-auto text-rail-text underline decoration-1 underline-offset-[3px] hover:text-white"
            >
              {link.label}
            </a>
          );
          if (link.status === undefined) return anchor;

          // The line of the extension and its link read as one entry: 6 px apart, 14 px from the next.
          return (
            <div key={link.href} className="flex flex-col gap-[6px]">
              <p className="flex items-center gap-[8px] text-small leading-auto text-white">
                <span aria-hidden="true" className="kit-drop bg-status-done" data-size="9" />
                {link.status}
              </p>
              {anchor}
            </div>
          );
        })}
        <Logo on="rail" />
      </div>
    </aside>
  );
}

/**
 * The rail of a workspace: the workspace, its sections, and the way to the documentation. The
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
}: RailProps) {
  useLocale();
  const name = (
    <>
      <span
        aria-hidden="true"
        className="flex h-[32px] w-[32px] flex-none items-center justify-center rounded-field bg-page text-small leading-auto font-bold text-ink"
      >
        {workspace.name.trim().charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body leading-auto font-semibold">{workspace.name}</span>
        <span className="block text-tiny text-rail-muted">{t('Cloud workspace')}</span>
      </span>
    </>
  );
  const head =
    workspaces.length > 1 ? (
      <Menu
        triggerClassName={`${RAIL_HEAD} hover:bg-rail-active`}
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
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[16px] w-[16px] flex-none text-rail-muted">
          <path
            d="M8 10l4-4 4 4M8 14l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Menu>
    ) : (
      // One workspace: its name leads to its settings (FRU-414). A screen reader hears where.
      <Link
        to={`/w/${workspace.id}/settings`}
        viewTransition
        {...(settings ? { 'aria-current': 'page' as const } : {})}
        className={`${RAIL_HEAD} hover:bg-rail-active ${settings ? 'bg-rail-active' : ''}`}
      >
        {name}
        <span className="sr-only"> {t('Workspace settings')}</span>
      </Link>
    );

  const extension = useExtensionLink();

  return (
    <RailFrame head={head} foot={[extension, { href: 'https://fruitback.com', label: t('Help and docs') }]}>
      <RailNav
        label={t('Workspace')}
        entries={sections.map((section) => ({
          to: `/w/${workspace.id}/${section.path}`,
          label: t(section.label),
          current: section.path === current,
        }))}
      />
      {admin ? (
        <RailNav label={t('Instance')} entries={[{ to: '/admin', label: t('Administration'), current: false }]} />
      ) : null}
    </RailFrame>
  );
}

/** A link at the foot of a rail, which opens a new tab. `status`: a line above it, which is no link. */
export type RailLink = { href: string; label: string; status?: string };

/**
 * The way to the browser extension, at the foot of both rails (FRU-406). Chrome and Edge go to the
 * Chrome Web Store, where 0.3.0 is public. Firefox is not on AMO yet: it, and every other browser,
 * goes to the page that installs the archive of the release.
 *
 * With a browser of the extension connected to the account, the rail says so and names it, and the
 * link is « Connect another browser » (FRU-441): `/connect` on Fruitback Cloud, the page that installs
 * it elsewhere, as a self-hosted console connects a browser from a site.
 */
export function useExtensionLink(): RailLink {
  const connected = useConnectedExtension();
  const install = extensionInstallFor(navigator.userAgent);
  if (connected === undefined) return { href: install, label: t('Install the extension (beta)') };

  return {
    href: BY_SIGN_IN ? CONNECT_PAGE : install,
    label: t('Connect another browser'),
    status: t('Extension connected · {browser}', { browser: connected.browser }),
  };
}

/** Whether a row that scrolls holds more before its start and after its end. */
function useMore(row: { current: HTMLElement | null }): { start: boolean; end: boolean } {
  const [more, setMore] = useState({ start: false, end: false });
  useEffect(() => {
    const element = row.current;
    if (element === null) return;
    const read = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setMore((before) => (before.start === start && before.end === end ? before : { start, end }));
    };
    read();
    element.addEventListener('scroll', read, { passive: true });
    const resized = new ResizeObserver(read);
    resized.observe(element);

    return () => {
      element.removeEventListener('scroll', read);
      resized.disconnect();
    };
  }, [row]);

  return more;
}

/** The width of the fade at an edge of the row, and a little more: what a section must be clear of. */
const CLEAR = 44;

/**
 * Scrolls the row of sections so that one of them is whole, and clear of the fade of an edge.
 *
 * WARNING: not `scrollIntoView`. Measured in Chromium: it makes the section the place the next Tab
 * starts from, so the first Tab of a page skipped the workspace and the section on screen.
 */
function reveal(link: HTMLElement): void {
  const row = link.parentElement;
  if (row === null || row.scrollWidth <= row.clientWidth) return;
  const frame = row.getBoundingClientRect();
  const box = link.getBoundingClientRect();
  if (box.left < frame.left + CLEAR) row.scrollLeft -= frame.left + CLEAR - box.left;
  else if (box.right > frame.right - CLEAR) row.scrollLeft += box.right - (frame.right - CLEAR);
}

/**
 * The entries of the rail. At 900 px and under they are one row, which scrolls in the rail when it
 * is wider than the screen: the page never scrolls sideways (the mockup does, at 390 px). An edge of
 * the row that hides a section fades. The section on screen, and the section that takes focus, are
 * scrolled into view, clear of the fade.
 *
 * The row scrolls, so it clips: its padding leaves room for the focus ring of a section, and its
 * negative margin gives the padding back, so a section stays where the mockup draws it.
 */
export function RailNav({ label, entries }: { label: string; entries: readonly RailEntry[] }) {
  const row = useRef<HTMLElement>(null);
  const more = useMore(row);
  const shown = entries.find((entry) => entry.current)?.to;
  useEffect(() => {
    const link = row.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (link !== null && link !== undefined) reveal(link);
  }, [shown]);

  return (
    <nav
      ref={row}
      aria-label={label}
      // Measured in Chromium: focus alone does not scroll the row to a section that is half hidden.
      onFocus={(event) => reveal(event.target)}
      data-more-start={more.start}
      data-more-end={more.end}
      className="flex min-w-0 flex-col gap-[2px] [--fade-end:0px] [--fade-start:0px] [scrollbar-width:none] max-[900px]:-m-[4px] max-[900px]:flex-row max-[900px]:overflow-x-auto max-[900px]:p-[4px] max-[900px]:[mask-image:linear-gradient(to_right,transparent,black_var(--fade-start),black_calc(100%_-_var(--fade-end)),transparent)] max-[900px]:data-[more-end=true]:[--fade-end:40px] max-[900px]:data-[more-start=true]:[--fade-start:40px]"
    >
      {entries.map((entry) => {
        const active = entry.current;

        return (
          <Link
            key={entry.to}
            to={entry.to}
            // A move between screens and frames cross-fades the screen, the rail held (FRU-356).
            viewTransition
            {...(active ? { 'aria-current': 'page' as const } : {})}
            className={`flex min-h-[40px] flex-none items-center gap-[10px] rounded-box text-body leading-auto whitespace-nowrap ${
              active
                ? 'bg-rail-active px-[12px] font-semibold text-white'
                : 'pr-[12px] pl-[31px] text-rail-text hover:bg-rail-active hover:text-white'
            }`}
          >
            {/* The drop of the entry on screen slides to the next one in a move (FRU-413): `kit-rail-drop`. */}
            {active ? (
              <span aria-hidden="true" className="kit-drop kit-rail-drop bg-rail-accent" data-size="9" />
            ) : null}
            {entry.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The head of a page of the workspace: its title, what the page is for, and the action of the page. */
export function PageHead({ title, lead, action }: { title: string; lead: string; action?: ReactNode }) {
  return <KitPageHead title={title} lead={lead} {...(action === undefined ? {} : { action })} className="mb-[28px]" />;
}
