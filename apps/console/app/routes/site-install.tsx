import { t } from '../i18n';
import { InstallOptions } from '../install-options';
import { siteName } from '../site-address';
import { useLocale } from '../use-locale';
import { useSite } from './site-frame';

/**
 * The tab « Install » of a site (FRU-689): the two ways to put Fruitback on it, at length, for every
 * role. The script, with the address of this console, and the browser of the person. A new site opens
 * its page here (FRU-433).
 */
export default function SiteInstall() {
  useLocale();
  const { workspace, site } = useSite();
  const host = siteName(site.origin);

  return (
    <section
      aria-label={t('Install on {site}', { site: host })}
      className="flex max-w-[760px] min-w-0 flex-col gap-[12px]"
    >
      <p className="text-small text-muted">
        {t('Paste the script on the site, or connect the browser of each person who reviews it.')}
      </p>
      <InstallOptions workspace={workspace} site={site} />
    </section>
  );
}
