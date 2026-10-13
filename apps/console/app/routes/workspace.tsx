import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { type Me, type Workspace, callUntilAnswered, saveLanguage } from '../api';
import { adoptLanguage, msg, t } from '../i18n';
import { PageHead as KitPageHead } from '../ui';
import { useLocale } from '../use-locale';

/**
 * The frame of a workspace (design/boards/4-connectors.png, 5-workspace.png): its name in the corner,
 * the sections on the left, the section on the right.
 */

export type WorkspaceContext = { me: Me; workspace: Workspace };

export function useWorkspace(): WorkspaceContext {
  return useOutletContext<WorkspaceContext>();
}

const SECTIONS = [
  { path: 'sites', label: msg('Sites') },
  { path: 'connectors', label: msg('Connectors') },
  { path: 'members', label: msg('Members') },
  { path: 'account', label: msg('My account') },
] as const;

export default function WorkspaceFrame() {
  useLocale();
  const { workspace: id } = useParams();
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

  if (context === undefined) return <p className="p-8 text-sm text-muted">{t('Loading…')}</p>;

  return (
    // Under md the grid is one column (FRU-159). `content-start` keeps its rows at their height: the
    // minimum height of the screen went into the first row, and left a gap under the sections. The
    // gap is smaller there, because the title has its own space above it. `min-w-0` lets the row of
    // sections scroll instead of widening the page.
    <div className="mx-auto grid min-h-screen max-w-[1440px] content-start gap-4 px-4 py-6 md:grid-cols-[224px_1fr] md:content-normal md:gap-8 md:px-6">
      <aside className="min-w-0 md:sticky md:top-6 md:self-start">
        <div className="mb-6 flex items-center gap-3 px-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-sm font-bold text-white">
            {context.workspace.name.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{context.workspace.name}</span>
            <span className="block text-xs text-muted">{t('Cloud workspace · beta')}</span>
          </span>
        </div>
        <nav aria-label={t('Workspace')} className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.path}
              to={`/w/${context.workspace.id}/${section.path}`}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-[10px] px-3 py-2 text-[15px] ${
                  isActive
                    ? 'border border-line bg-surface font-semibold'
                    : 'border border-transparent text-ink hover:bg-chip'
                }`
              }
            >
              {t(section.label)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 pb-16">
        <Outlet context={context} />
      </main>
    </div>
  );
}

/** The head of a page of the workspace, in the space the frame of before gives it. */
export function PageHead({ title, lead }: { title: string; lead: string }) {
  return <KitPageHead title={title} lead={lead} className="mb-6 pt-4" />;
}
