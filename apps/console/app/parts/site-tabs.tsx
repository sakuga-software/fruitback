import { Link } from 'react-router';
import { msg, t } from '../i18n';
import { useLocale } from '../use-locale';
import { SiteIcon, type SiteIconName } from './site-icons';

/** A tab of the page of a site: its path under the page, and the roles that see it. */
export type SiteTab = 'overview' | 'install' | 'destinations' | 'statuses' | 'access' | 'advanced';

/**
 * The tabs of the page of a site (FRU-689), in the order of the mockup « Un site », with « Access »
 * (FRU-703) before « Advanced ». Each tab is a route: the tab on screen is in the address, so a link,
 * a reload and the way back keep it.
 *
 * - `manages`: only an owner or an admin sets it. A member and a guest have no such tab.
 * - `tracker`: only who sees the tracker reads where the notes go (not a guest).
 */
const TABS: readonly {
  tab: SiteTab;
  path: string;
  label: string;
  icon: SiteIconName;
  manages?: true;
  tracker?: true;
}[] = [
  { tab: 'overview', path: '', label: msg('Overview'), icon: 'overview' },
  { tab: 'install', path: '/install', label: msg('Install'), icon: 'install' },
  {
    tab: 'destinations',
    path: '/destinations',
    label: msg('Destinations'),
    icon: 'destinations',
    manages: true,
    tracker: true,
  },
  { tab: 'statuses', path: '/statuses', label: msg('Statuses'), icon: 'statuses', manages: true },
  { tab: 'access', path: '/access', label: msg('Access'), icon: 'access' },
  { tab: 'advanced', path: '/advanced', label: msg('Advanced'), icon: 'advanced', manages: true },
];

/** The address of a tab of a site. `workspace` is the address of the workspace (FRU-715): `workspaceAddress`. */
export function siteTabPath(workspace: string, site: string, tab: SiteTab): string {
  const path = TABS.find((each) => each.tab === tab)?.path ?? '';

  return `/w/${workspace}/sites/${encodeURIComponent(site)}${path}`;
}

/**
 * The row of the tabs, 44 px, from one edge of the screen to the other: an icon and the words of each
 * tab, the one on screen in ink over 2 px of ink, the others muted. The row scrolls in its frame on a
 * narrow screen, and the page does not.
 */
export function SiteTabs({
  workspace,
  site,
  current,
  manages,
  seesTracker,
  className = '',
}: {
  workspace: string;
  site: string;
  current: SiteTab;
  manages: boolean;
  seesTracker: boolean;
  className?: string;
}) {
  useLocale();
  const shown = TABS.filter((each) => (each.manages !== true || manages) && (each.tracker !== true || seesTracker));

  return (
    <nav
      aria-label={t('Sections of the site')}
      className={`kit-site-tabs overflow-x-auto border-b border-line pr-[16px] pl-[20px] [scrollbar-width:none] ${className}`}
    >
      <ul className="flex min-w-max gap-[18px]">
        {shown.map((each) => (
          <li key={each.tab}>
            <Link
              to={siteTabPath(workspace, site, each.tab)}
              {...(each.tab === current ? { 'aria-current': 'page' as const } : {})}
              data-site-tab={each.tab}
              className={`inline-flex h-[44px] items-center gap-[6px] px-[2px] text-small leading-auto font-medium [text-decoration:none] focus-visible:outline-offset-[-2px]! ${each.tab === current ? 'text-ink [box-shadow:inset_0_-2px_0_var(--color-ink)]' : 'text-muted hover:text-ink'}`}
            >
              <SiteIcon name={each.icon} />
              {t(each.label)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
