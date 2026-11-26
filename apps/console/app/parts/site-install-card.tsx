import { useState } from 'react';
import { type Site, type Workspace } from '../api';
import { agoInSentence } from '../ago';
import { useConnectedExtension } from '../extension-connected';
import { t } from '../i18n';
import { BY_SIGN_IN, CONNECT_PAGE, snippetFor, useConnect, useCopy } from '../install-options';
import { siteName } from '../site-address';
import { Button, Chip, Problem, Segments, Snippet } from '../ui';
import { useLocale } from '../use-locale';
import { SiteIcon } from './site-icons';

type Way = 'script' | 'extension';

/**
 * When the widget was last seen on the site by a way (FRU-721): the worker writes it from the read of
 * the pins of a page, an hour apart at most. Before that date exists (a site of before FRU-721), it
 * says whether notes came by that way, and when the last note of the site came (FRU-689).
 */
function seenLine(site: Site, way: Way): string {
  const seen = site.seen?.[way];
  if (seen !== undefined)
    return way === 'script'
      ? t('Seen on the site {when}.', { when: agoInSentence(seen) })
      : t('Seen with the extension {when}.', { when: agoInSentence(seen) });
  const came = site.via?.includes(way) === true;
  if (!came)
    return way === 'script' ? t('No note came through the script yet.') : t('No note came through the extension yet.');
  const when = site.lastNoteAt === undefined ? undefined : agoInSentence(site.lastNoteAt);
  if (when === undefined)
    return way === 'script' ? t('Notes came through the script.') : t('Notes came through the extension.');

  return way === 'script'
    ? t('Notes came through the script. The last note of the site came {when}.', { when })
    : t('Notes came through the extension. The last note of the site came {when}.', { when });
}

/**
 * The card « Install » of the overview of a site (FRU-689), in the column of 420 px: the two ways in
 * a segment, « Script » first. The script is on ink, with the address of this console, which is the
 * one of the instance in production (`snippetFor`), and « Copy ». The extension connects this browser.
 * The tab « Install » says both at length.
 */
export function InstallCard({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const [way, setWay] = useState<Way>('script');
  const snippet = snippetFor(site);
  const { copied, copy } = useCopy(snippet);
  const { link, problem, connect } = useConnect(workspace);
  const connected = useConnectedExtension();
  const host = siteName(site.origin);
  const used = site.via !== undefined && site.via.length > 0;
  // FRU-721: « Installed » once the widget was seen on the site, by either way.
  const installed = site.seen?.script !== undefined || site.seen?.extension !== undefined;
  let state: 'installed' | 'used' | 'unseen' = 'unseen';
  if (installed) state = 'installed';
  else if (used) state = 'used';

  return (
    <section
      aria-label={t('Install on {site}', { site: host })}
      className="overflow-hidden rounded-card border border-line bg-surface"
    >
      <div className="flex min-h-[44px] items-center gap-[8px] px-[16px]">
        <h2 className="min-w-0 text-small leading-auto font-semibold">{t('Install')}</h2>
        <span className="ms-auto" data-install-state={state}>
          {state === 'installed' ? <Chip tone="done">{t('Installed')}</Chip> : null}
          {state === 'used' ? <Chip tone="done">{t('Notes came')}</Chip> : null}
          {state === 'unseen' ? <Chip>{t('Not seen yet')}</Chip> : null}
        </span>
      </div>
      <div className="flex flex-col gap-[12px] px-[16px] pb-[14px]">
        <div>
          <Segments
            label={t('How to put Fruitback on {site}', { site: host })}
            value={way}
            onChange={setWay}
            options={[
              { value: 'script', label: t('Script'), icon: <SiteIcon name="install" /> },
              { value: 'extension', label: t('Extension'), icon: <SiteIcon name="extension" /> },
            ]}
          />
        </div>
        {way === 'script' ? (
          <>
            {/* The box of the script takes focus, so a keyboard scrolls its long lines (axe, FRU-239). */}
            <Snippet label={t('Script')} tone="ink">
              {snippet}
            </Snippet>
            <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[6px]">
              <Button
                tone="outline"
                size="small"
                inset={10}
                gap={6}
                onClick={copy}
                label={copied === 'yes' ? t('Copied') : t('Copy the script')}
              >
                <SiteIcon name="copy" />
                {copied === 'yes' ? t('Copied') : t('Copy')}
              </Button>
              <span className="min-w-0 flex-1 text-hint text-muted" data-install-seen>
                {seenLine(site, 'script')}
              </span>
            </div>
            {copied === 'refused' ? (
              <p role="alert" className="text-hint text-muted">
                {t('The browser refused the copy. Select the script above and copy it by hand.')}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-small text-muted">
              {connected === undefined
                ? t(
                    'Nothing to change on the site. Connect this browser, then click the Fruitback icon on the page that opens.',
                  )
                : t('Extension connected · {browser}', { browser: connected.browser })}
            </p>
            <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[6px]">
              {BY_SIGN_IN ? (
                <Button tone="outline" size="small" href={CONNECT_PAGE} newTab>
                  {connected === undefined ? t('Connect this browser') : t('Connect another browser')}
                </Button>
              ) : (
                <Button tone="outline" size="small" onClick={connect}>
                  {connected === undefined ? t('Connect this browser') : t('Connect another browser')}
                </Button>
              )}
              <span className="min-w-0 flex-1 text-hint text-muted" data-install-seen>
                {seenLine(site, 'extension')}
              </span>
            </div>
            {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
            {link === undefined ? null : (
              <p className="text-hint text-muted">
                {t('A page opened in a new tab. If it did not, open')}{' '}
                <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
                  {t('this link')}
                </a>
                {t(': it works once, for fifteen minutes.')}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
