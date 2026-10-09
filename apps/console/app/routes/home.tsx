import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { type Me, callUntilAnswered } from '../api';

/** The front door: the first workspace of a signed-in person, or the setup. */
export default function Home() {
  const navigate = useNavigate();

  // No answer is not a signed-out person: the call waits under the banner and asks again.
  useEffect(() => {
    return callUntilAnswered<Me>('GET', '/console/me', (me) => {
      const workspace = me.ok ? me.data.workspaces[0] : undefined;
      navigate(workspace === undefined ? '/setup' : `/w/${workspace.id}/sites`, { replace: true });
    });
  }, [navigate]);

  return <p className="p-8 text-sm text-muted">Loading…</p>;
}
