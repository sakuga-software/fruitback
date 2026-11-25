import { useCallback, useEffect, useState } from 'react';
import { type Connector, type Destination, call } from '../api';
import { t } from '../i18n';
import { type Listed, listedOf } from '../listed';
import { useLocale } from '../use-locale';
import { SitePlaces } from '../parts/site-places';
import { useSite } from './site-frame';

/**
 * The tab « Destinations » of a site (FRU-689): where its notes go (`site-places.tsx`, FRU-399), with
 * the search of the places of every source of the workspace. For an owner or an admin who sees the
 * tracker; anybody else reads one sentence, and the tab asks the worker nothing.
 */
export default function SiteDestinations() {
  useLocale();
  const { workspace, site, setSite, manages, seesTracker } = useSite();
  const base = `/console/workspaces/${workspace.id}`;
  const [connectors, setConnectors] = useState<Listed<Connector>>('loading');
  // A read that a newer one, or the tab leaving, replaced is dropped (FRU-557).
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

  if (!manages || !seesTracker)
    return (
      <p className="text-body text-muted">
        {t('Only an owner or an admin of the workspace sets where the notes of a site go.')}
      </p>
    );

  /** The places the worker kept, in place of the ones of the list: no read again. */
  function placed(places: Destination[]) {
    setSite((current) => ({
      ...current,
      destinations: places,
      ...(places[0] === undefined ? { destination: undefined } : { destination: places[0] }),
    }));
  }

  return (
    <div className="max-w-[760px]">
      <SitePlaces
        base={base}
        workspaceId={workspace.id}
        site={site}
        connectors={connectors}
        onRetry={() => void readConnectors()}
        onPlaced={placed}
      />
    </div>
  );
}
