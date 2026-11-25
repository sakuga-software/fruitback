import { t } from '../i18n';
import { SubNav } from '../ui';
import { useLocale } from '../use-locale';

/**
 * The tabs of the page of a site (FRU-703): « Overview », what the page showed before, and « Access ».
 * FRU-689 makes the page tabs of its own (Install, Destinations, Statuses, Advanced); until then the
 * row has these two, drawn as the pages of the settings of a workspace.
 */
export function SiteTabs({
  workspace,
  site,
  current,
}: {
  workspace: string;
  site: string;
  current: 'overview' | 'access';
}) {
  useLocale();
  const base = `/w/${workspace}/sites/${encodeURIComponent(site)}`;

  return (
    <SubNav
      label={t('Sections of the site')}
      entries={[
        { to: base, label: t('Overview'), current: current === 'overview' },
        { to: `${base}/access`, label: t('Access'), current: current === 'access' },
      ]}
    />
  );
}
