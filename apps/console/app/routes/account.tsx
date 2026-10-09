import { useState } from 'react';
import { useNavigate } from 'react-router';
import { call, signOut } from '../api';
import { Button, Card } from '../ui';
import { PageHead, useWorkspace } from './workspace';

/** My account (design/boards/5-workspace.png): the profile, how I sign in, and the workspace's end. */
export default function Account() {
  const { me, workspace } = useWorkspace();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  async function leave() {
    await signOut();
    navigate('/setup', { replace: true });
  }

  async function destroy() {
    const deleted = await call('DELETE', `/console/workspaces/${workspace.id}`);
    if (deleted.ok) navigate('/', { replace: true });
  }

  return (
    <>
      <PageHead title="My account" lead="How you sign in, and the workspace you are in." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-[15px] font-semibold">Profile</h2>
          <p className="text-xs text-muted">Address</p>
          <p className="mb-4 text-[15px]">{me.account.email}</p>
          <p className="mb-1 text-xs text-muted">Sign-in</p>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt>Email link</dt>
              <dd className="font-semibold text-done">On</dd>
            </div>
            <div className="flex justify-between">
              <dt>GitHub</dt>
              <dd className="text-muted">Soon</dd>
            </div>
            <div className="flex justify-between">
              <dt>Google</dt>
              <dd className="text-muted">After the beta</dd>
            </div>
          </dl>
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 text-[15px] font-semibold">Where you are signed in</h2>
          <div className="flex items-center justify-between">
            <span>
              <span className="block text-sm font-semibold">Console · this browser</span>
              <span className="block text-xs text-muted">Active now</span>
            </span>
            <Button tone="outline" onClick={() => void leave()}>
              Sign out
            </Button>
          </div>
        </Card>
      </div>
      {workspace.role === 'owner' ? (
        <Card className="mt-4 flex flex-col gap-3 border-accent/40 p-5 sm:flex-row sm:items-center">
          <span className="flex-1">
            <span className="block text-[15px] font-semibold">Delete the workspace</span>
            <span className="block text-sm text-muted">
              Sites, members and pin positions go. Items already in your sources stay there.
            </span>
          </span>
          {confirming ? (
            <span className="flex gap-2">
              <Button tone="quiet" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
              <Button onClick={() => void destroy()}>Delete {workspace.name}</Button>
            </span>
          ) : (
            <Button tone="danger" onClick={() => setConfirming(true)}>
              Delete workspace
            </Button>
          )}
        </Card>
      ) : null}
    </>
  );
}
