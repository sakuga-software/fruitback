import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router';
import { type Me, type Role, type Workspace, callUntilAnswered, saveLanguage } from '../api';
import { adoptLanguage, msg, t } from '../i18n';
import { PageHead as KitPageHead, Logo, Menu } from '../ui';
import { useLocale } from '../use-locale';

/**
 * The frame of a workspace, as the mockup of 2026-10-13 draws it (FRU-234): a dark rail with the
 * workspace and its sections, and the section beside it. Under 888 px the rail is above the section,
 * and at 900 px and under its sections are one row.
 */

export type WorkspaceContext = { me: Me; workspace: Workspace };

export function useWorkspace(): WorkspaceContext {
  return useOutletContext<WorkspaceContext>();
}

/** A section of a workspace: an entry of the rail, and the widest its screen is drawn. */
export type Section = { path: string; label: string; width: string; built: boolean };

/**
 * The sections, in the order of the mockup. `built` says that the screen exists: the rail shows no
 * entry for a screen that does not, so no entry leads nowhere. `frame.test.ts` holds `built` to the
 * routes of `routes.ts`. `width` is a whole class name, so Tailwind finds it.
 */
export const SECTIONS: readonly Section[] = [
  { path: 'sites', label: msg('Sites'), width: 'max-w-[1120px]', built: true },
  { path: 'notes', label: msg('Notes'), width: 'max-w-[1240px]', built: true },
  { path: 'connectors', label: msg('Connectors'), width: 'max-w-[1180px]', built: true },
  { path: 'members', label: msg('Members'), width: 'max-w-[1120px]', built: true },
  { path: 'account', label: msg('My account'), width: 'max-w-[820px]', built: true },
];

const ROLE_WORDS: Readonly<Record<Role, string>> = {
  owner: msg('Owner'),
  admin: msg('Admin'),
  member: msg('Member'),
  guest: msg('Guest'),
};

export default function WorkspaceFrame() {
  useLocale();
  const { workspace: id } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [context, setContext] = useState<WorkspaceContext | undefined>();

  // No answer is not a signed-out person: the call waits under the banner and asks again.
  useEffect(() => {
    return callUntilAnswered<Me>('GET', '/console/me', (me) => {
      if (!me.ok) return navigate('/sign-in', { replace: true });
      adoptLanguage(me.data.account, saveLanguage);
      const workspace = me.data.workspaces.find((each) => each.id === id);
      if (workspace === undefined) return navigate('/', { replace: true });
      setContext({ me: me.data, workspace });
    });
  }, [id, navigate]);

  // WARNING: the context of another workspace is not shown. After a change of workspace the address
  // names the new one at once, and the answer of the worker comes later: a screen drawn in between
  // would read, and write, in the workspace of before.
  if (context === undefined || context.workspace.id !== id)
    return <p className="p-8 text-sm text-muted">{t('Loading…')}</p>;

  const sections = SECTIONS.filter((section) => section.built);
  const current = sections.find((section) => pathname.startsWith(`/w/${context.workspace.id}/${section.path}`));

  return (
    // Under 888 px the rail is above the section (248 + 640). `content-start` keeps it at its own
    // height there: the screen is at least as high as the window, and a short section left the rest
    // of that height to the rail, as the mockup does at 390 px (286 px of rail on « did not load »).
    <div className="flex min-h-screen flex-wrap bg-page text-ink max-[887px]:content-start">
      <Rail
        workspace={context.workspace}
        workspaces={context.me.workspaces}
        sections={sections}
        current={current?.path}
        onWorkspace={(chosen) => navigate(`/w/${chosen}/sites`)}
      />
      <div className="min-w-0 flex-[999_1_640px]">
        <main className={`box-border px-[clamp(16px,4vw,48px)] pt-[40px] pb-[72px] ${current?.width ?? ''}`}>
          <Outlet context={context} />
        </main>
      </div>
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
};

/**
 * The rail: the workspace, its sections, and the way to the documentation.
 *
 * `kit-rail` gives every control in it the focus ring of the rail. The sections are links, and the
 * one on screen has `aria-current="page"`.
 */
export function Rail({ workspace, workspaces, sections, current, onWorkspace }: RailProps) {
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
  const box = 'flex w-full items-center gap-[10px] rounded-box p-[8px] text-left text-white';

  return (
    <aside className="kit-rail box-border flex min-w-0 flex-[1_1_248px] flex-col gap-[20px] bg-rail px-[12px] py-[16px] text-white">
      {workspaces.length > 1 ? (
        <Menu
          triggerClassName={`${box} hover:bg-rail-active`}
          chosen={workspace.id}
          onAction={(chosen) => {
            if (chosen !== workspace.id) onWorkspace(chosen);
          }}
          items={workspaces.map((each) => ({ id: each.id, label: each.name, detail: t(ROLE_WORDS[each.role]) }))}
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
        <div className={box}>{name}</div>
      )}
      <Sections workspace={workspace.id} sections={sections} current={current} />
      <div className="mt-auto flex flex-col gap-[14px] p-[8px] max-[900px]:hidden">
        <a
          href="https://fruitback.com"
          target="_blank"
          rel="noreferrer"
          className="self-start text-small leading-auto text-rail-text underline decoration-1 underline-offset-[3px] hover:text-white"
        >
          {t('Help and docs')}
        </a>
        <Logo on="rail" />
      </div>
    </aside>
  );
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
 * The sections of the rail. At 900 px and under they are one row, which scrolls in the rail when it
 * is wider than the screen: the page never scrolls sideways (the mockup does, at 390 px). An edge of
 * the row that hides a section fades. The section on screen, and the section that takes focus, are
 * scrolled into view, clear of the fade.
 *
 * The row scrolls, so it clips: its padding leaves room for the focus ring of a section, and its
 * negative margin gives the padding back, so a section stays where the mockup draws it.
 */
function Sections({ workspace, sections, current }: Pick<RailProps, 'sections' | 'current'> & { workspace: string }) {
  useLocale();
  const row = useRef<HTMLElement>(null);
  const more = useMore(row);
  useEffect(() => {
    const link = row.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (link !== null && link !== undefined) reveal(link);
  }, [current]);

  return (
    <nav
      ref={row}
      aria-label={t('Workspace')}
      // Measured in Chromium: focus alone does not scroll the row to a section that is half hidden.
      onFocus={(event) => reveal(event.target)}
      data-more-start={more.start}
      data-more-end={more.end}
      className="flex min-w-0 flex-col gap-[2px] [--fade-end:0px] [--fade-start:0px] [scrollbar-width:none] max-[900px]:-m-[4px] max-[900px]:flex-row max-[900px]:overflow-x-auto max-[900px]:p-[4px] max-[900px]:[mask-image:linear-gradient(to_right,transparent,black_var(--fade-start),black_calc(100%_-_var(--fade-end)),transparent)] max-[900px]:data-[more-end=true]:[--fade-end:40px] max-[900px]:data-[more-start=true]:[--fade-start:40px]"
    >
      {sections.map((section) => {
        const active = section.path === current;

        return (
          <Link
            key={section.path}
            to={`/w/${workspace}/${section.path}`}
            {...(active ? { 'aria-current': 'page' as const } : {})}
            className={`flex min-h-[40px] flex-none items-center gap-[10px] rounded-box text-body leading-auto whitespace-nowrap ${
              active
                ? 'bg-rail-active px-[12px] font-semibold text-white'
                : 'pr-[12px] pl-[31px] text-rail-text hover:bg-rail-active hover:text-white'
            }`}
          >
            {active ? <span aria-hidden="true" className="kit-drop bg-rail-accent" data-size="9" /> : null}
            {t(section.label)}
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
