import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { type Me, type Site, call, callUntilAnswered, myInvitations } from '../api';
import { t } from '../i18n';
import { takeConnect } from '../connect-return';
import { LinkButton, Problem } from '../ui';
import { useLocale } from '../use-locale';

/**
 * The front door: the invitations that wait for a signed-in person, then their first workspace, or
 * the setup, which a workspace with no site goes back to.
 *
 * Somebody who was invited (FRU-104) signs in from the link of the message, and lands here: they see
 * the invitation before the setup offers to make a workspace of their own.
 */
export default function Home() {
  useLocale();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  // GitHub sent the person back with no start of this browser (FRU-361), for example after an
  // installation from github.com. The worker knows no workspace for it, so the Connectors screen of
  // the first one that the person manages says what to do.
  const unstarted = search.get('github') === 'unstarted';
  const [managesNone, setManagesNone] = useState(false);

  // No answer is not a signed-out person: the call waits under the banner and asks again.
  useEffect(() => {
    let stopped = false;
    const stop = callUntilAnswered<Me>('GET', '/console/me', (me) => {
      if (!me.ok) return navigate('/setup', { replace: true });
      // A sign-in with a provider that started on « Connect this browser » goes back to its question.
      const connecting = takeConnect();
      if (connecting !== undefined) return navigate(`/connect/${connecting}`, { replace: true });
      const manages = me.data.workspaces.find((each) => each.role === 'owner' || each.role === 'admin');
      if (unstarted && manages !== undefined) {
        return navigate(`/w/${manages.id}/connectors?github=unstarted`, { replace: true });
      }
      // The front door must not take this person on with no word: they think GitHub is connected.
      if (unstarted) return setManagesNone(true);
      const workspace = me.data.workspaces[0];
      // Only somebody who adds a site is sent back to the step that adds one.
      const adds = workspace !== undefined && (workspace.role === 'owner' || workspace.role === 'admin');
      // The invitations and the sites are read side by side (FRU-492): one after the other, they
      // were a third round trip before the first screen, 160 ms on a phone. The sites are read for
      // nothing when an invitation waits.
      // One site is enough to know there is one, and no note is counted (FRU-497).
      const listing = adds
        ? call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites?limit=1&counts=none`)
        : undefined;
      void Promise.all([myInvitations(), listing]).then(([invitations, listed]) => {
        if (stopped) return;
        // An invitation that could not be read does not hold the front door: it is on its own page.
        if (invitations.ok && invitations.data.length > 0) return navigate('/invitations', { replace: true });
        if (workspace === undefined) return navigate('/setup', { replace: true });
        const sites = `/w/${workspace.id}/sites`;
        // A workspace with no site is a setup that stopped at its second step (FRU-239). A list
        // that could not be read is not an empty list: the Sites screen says so itself.
        navigate(listed?.ok === true && listed.data.sites.length === 0 ? '/setup' : sites, { replace: true });
      });
    });

    return () => {
      stopped = true;
      stop();
    };
  }, [navigate, unstarted]);

  if (managesNone && unstarted) {
    return (
      <div className="flex max-w-xl flex-col items-start gap-4 p-8">
        <Problem>
          {t(
            'GitHub sent you back, but nothing was connected. Only an owner or an admin of a workspace connects GitHub, from the Connectors of that workspace.',
          )}
        </Problem>
        <LinkButton to="/">{t('Continue')}</LinkButton>
      </div>
    );
  }

  return <p className="p-8 text-sm text-muted">{t('Loading…')}</p>;
}
