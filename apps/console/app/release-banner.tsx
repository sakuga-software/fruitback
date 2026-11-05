import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { API, type ReleaseFacts, releaseFacts } from './api';
import { t } from './i18n';
import { releaseToShow } from './instance';
import { dismissRelease, dismissedRelease, releaseToAnnounce } from './release-notice';
import { IconButton } from './ui';
import { useLocale } from './use-locale';

type Release = NonNullable<ReleaseFacts['update']>;

/**
 * Says to the administrator of the instance that a newer release is out (FRU-520), at the top of each
 * frame, until they dismiss it. It leads to the screen « Instance », which says how to update.
 *
 * `show` false asks nothing: the worker answers the release to the administrator only.
 */
export function ReleaseBanner({ show }: { show: boolean }) {
  useLocale();
  const [release, setRelease] = useState<Release | null>(null);

  useEffect(() => {
    if (!show) return;
    let current = true;
    void releaseFacts().then((answer) => {
      if (!current || !answer.ok) return;
      setRelease(releaseToAnnounce(releaseToShow(answer.data?.update, API), dismissedRelease()));
    });

    return () => {
      current = false;
    };
  }, [show]);

  if (!show || release === null) return null;

  return (
    <aside
      aria-label={t('New release')}
      className="flex items-center gap-[12px] border-b border-line bg-subtle px-[clamp(16px,4vw,48px)] py-[10px] text-small leading-auto text-ink"
    >
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{t('Fruitback {version} is out.', { version: release.version })}</span>{' '}
        <Link to="/admin" className="underline underline-offset-2">
          {t('How to update')}
        </Link>
      </p>
      <IconButton
        label={t('Dismiss')}
        size="small"
        onClick={() => {
          dismissRelease(release.version);
          setRelease(null);
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </IconButton>
    </aside>
  );
}
