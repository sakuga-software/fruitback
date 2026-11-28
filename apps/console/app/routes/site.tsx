import { useCallback, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { type Connector, type Destination, call, workspaceAddress } from '../api';
import { accessOf } from '../access-policy';
import { type Listed, listedOf } from '../listed';
import { useLocale } from '../use-locale';
import { InstallCard } from '../parts/site-install-card';
import { PlacesCard, SiteFigures, SiteRows } from '../parts/site-overview';
import { type SiteTab, siteTabPath } from '../parts/site-tabs';
import { useSite } from './site-frame';

/**
 * The sections the page of a site had before its tabs (FRU-433, FRU-538), and the tab that holds each
 * now (FRU-689). A link of before, or one kept in a browser, opens its tab; a section inside a tab
 * keeps its hash, and the tab scrolls to it.
 */
const MOVED: Readonly<Record<string, { tab: SiteTab; hash?: string }>> = {
  install: { tab: 'install' },
  destinations: { tab: 'destinations' },
  advanced: { tab: 'advanced' },
  statuses: { tab: 'statuses' },
  agent: { tab: 'advanced', hash: '#agent' },
  previews: { tab: 'advanced', hash: '#previews' },
  remove: { tab: 'advanced', hash: '#remove' },
};

/**
 * The tab « Overview » of a site (FRU-689), as the mockup « Un site » draws it. On the left, its three
 * figures, the card « Site » and, for who manages the sites and sees the tracker, where its notes go.
 * On the right, in a column of 420 px from 1100 px, how to install Fruitback on it, for every role.
 */
export default function SiteOverview() {
  useLocale();
  const { workspace, site, setSite, manages, seesTracker } = useSite();
  const { hash } = useLocation();
  const base = `/console/workspaces/${workspace.id}`;

  // The sources of the workspace, for who sets where the notes of the site go (FRU-399).
  const [connectors, setConnectors] = useState<Listed<Connector>>('loading');
  // `current` says whether the answer is still wanted: a read that a newer one, or the page leaving,
  // replaced is dropped (FRU-557).
  const readConnectors = useCallback(
    async (current: () => boolean = () => true) => {
      setConnectors('loading');
      const answer = await call<{ connectors: Connector[] }>('GET', `${base}/connectors`);
      if (current()) setConnectors(listedOf(answer, (data) => data.connectors));
    },
    [base],
  );
  useEffect(() => {
    if (!manages || !seesTracker) return;
    let current = true;
    void readConnectors(() => current);

    return () => {
      current = false;
    };
  }, [manages, seesTracker, readConnectors]);

  /** The places the worker kept, in place of the ones of the list: no read again. */
  function placed(places: Destination[]) {
    setSite((current) => ({
      ...current,
      destinations: places,
      ...(places[0] === undefined ? { destination: undefined } : { destination: places[0] }),
    }));
  }

  const moved = MOVED[hash.slice(1)];
  if (moved !== undefined)
    return (
      <Navigate replace to={`${siteTabPath(workspaceAddress(workspace), site.id, moved.tab)}${moved.hash ?? ''}`} />
    );

  // Who writes, and the e-mail of FRU-604, as the tab « Access » reads them (FRU-703).
  const access = accessOf(site);

  return (
    <div className="grid items-start gap-[16px] min-[1100px]:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex min-w-0 flex-col gap-[16px]">
        <SiteFigures workspace={workspaceAddress(workspace)} site={site} seesTracker={seesTracker} />
        <SiteRows
          workspace={workspaceAddress(workspace)}
          site={site}
          manages={manages}
          writers={access.writers}
          notifyDone={access.notifyDone}
        />
        {manages && seesTracker ? (
          <PlacesCard
            base={base}
            workspace={workspaceAddress(workspace)}
            site={site}
            connectors={connectors}
            onPlaced={placed}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-[16px]">
        <InstallCard workspace={workspace} site={site} />
      </div>
    </div>
  );
}
