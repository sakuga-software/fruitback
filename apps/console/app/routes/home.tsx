import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { type Me, call } from '../api';

/** The front door: the first workspace of a signed-in person, or the setup. */
export default function Home() {
  const navigate = useNavigate();

  useEffect(() => {
    void call<Me>('GET', '/console/me').then((me) => {
      const workspace = me.ok ? me.data.workspaces[0] : undefined;
      navigate(workspace === undefined ? '/setup' : `/w/${workspace.id}/sites`, { replace: true });
    });
  }, [navigate]);

  return <p className="p-8 text-sm text-muted">Loading…</p>;
}
