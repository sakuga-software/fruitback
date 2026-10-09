import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { type Me, type Workspace, call } from '../api';

/**
 * The frame of a workspace (design/boards/4-connectors.png, 5-workspace.png): its name in the corner,
 * the sections on the left, the section on the right.
 */

export type WorkspaceContext = { me: Me; workspace: Workspace };

export function useWorkspace(): WorkspaceContext {
  return useOutletContext<WorkspaceContext>();
}

const SECTIONS = [
  { path: 'sites', label: 'Sites' },
  { path: 'connectors', label: 'Connectors' },
  { path: 'members', label: 'Members' },
  { path: 'account', label: 'My account' },
] as const;

export default function WorkspaceFrame() {
  const { workspace: id } = useParams();
  const navigate = useNavigate();
  const [context, setContext] = useState<WorkspaceContext | undefined>();

  useEffect(() => {
    void call<Me>('GET', '/console/me').then((me) => {
      if (!me.ok) return navigate('/setup', { replace: true });
      const workspace = me.data.workspaces.find((each) => each.id === id);
      if (workspace === undefined) return navigate('/', { replace: true });
      setContext({ me: me.data, workspace });
    });
  }, [id, navigate]);

  if (context === undefined) return <p className="p-8 text-sm text-muted">Loading…</p>;

  return (
    <div className="mx-auto grid min-h-screen max-w-[1440px] gap-8 px-4 py-6 md:grid-cols-[224px_1fr] md:px-6">
      <aside className="md:sticky md:top-6 md:self-start">
        <div className="mb-6 flex items-center gap-3 px-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-sm font-bold text-white">
            {context.workspace.name.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{context.workspace.name}</span>
            <span className="block text-xs text-muted">Cloud workspace · beta</span>
          </span>
        </div>
        <nav aria-label="Workspace" className="flex gap-1 overflow-x-auto md:flex-col">
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
              {section.label}
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

export function PageHead({ title, lead }: { title: string; lead: string }) {
  return (
    <header className="mb-6 pt-4">
      <h1 className="text-[26px] font-bold tracking-[-0.02em]">{title}</h1>
      <p className="mt-1.5 text-[15px] text-muted">{lead}</p>
    </header>
  );
}
