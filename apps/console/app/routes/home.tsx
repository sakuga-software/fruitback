import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { type Me, callUntilAnswered, myInvitations } from '../api';
import { t } from '../i18n';
import { useLocale } from '../use-locale';

/**
 * The front door: the invitations that wait for a signed-in person, then their first workspace, or
 * the setup.
 *
 * Somebody who was invited (FRU-104) signs in from the link of the message, and lands here: they see
 * the invitation before the setup offers to make a workspace of their own.
 */
export default function Home() {
  useLocale();
  const navigate = useNavigate();

  // No answer is not a signed-out person: the call waits under the banner and asks again.
  useEffect(() => {
    let stopped = false;
    const stop = callUntilAnswered<Me>('GET', '/console/me', (me) => {
      if (!me.ok) return navigate('/setup', { replace: true });
      void myInvitations().then((invitations) => {
        if (stopped) return;
        // An invitation that could not be read does not hold the front door: it is on its own page.
        if (invitations.ok && invitations.data.length > 0) return navigate('/invitations', { replace: true });
        const workspace = me.data.workspaces[0];
        navigate(workspace === undefined ? '/setup' : `/w/${workspace.id}/sites`, { replace: true });
      });
    });

    return () => {
      stopped = true;
      stop();
    };
  }, [navigate]);

  return <p className="p-8 text-sm text-muted">{t('Loading…')}</p>;
}
