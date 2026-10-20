import type { Site, Workspace } from '../api';
import { ago } from '../ago';
import { locale, t } from '../i18n';
import { EXTENSION_GUIDE, snippetFor, useConnect, useCopy } from '../install-options';
import { AutoGrid, Button, LinkButton, OptionCard, Problem, Snippet } from '../ui';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';

/** Step 3 of the setup, « Put it on the site » (FRU-242). */

/**
 * Step 3: the two ways to put Fruitback on the site, each in its card, then what to do on the site.
 *
 * The extension does not « sign in with this account » here yet: a browser is connected from here,
 * with a code that nobody types, until the popup asks by itself (FRU-238, FRU-251). The step waits
 * for the first note (`setup.tsx` reads the site again), and « Open the console » stays, for a person
 * who does not send one now.
 */
export function PutOnSite({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const snippet = snippetFor(site);
  const { copied, copy } = useCopy(snippet);
  const { link, problem, connect } = useConnect(workspace);
  const host = siteLabel(site.origin);

  return (
    <>
      <p className="mt-1 mb-4 text-body text-muted">{t('Use one, or both.')}</p>
      <AutoGrid min={230}>
        <OptionCard title={t('Browser extension')}>
          <p className="text-small text-muted">{t("Nothing to deploy. Right for a client's site you cannot touch.")}</p>
          <p className="mb-1.5 text-hint">
            {t('Add it, then connect this browser: a page opens, and you click the Fruitback icon there.')}
          </p>
          <div className="mt-auto flex flex-col gap-2">
            <Button tone="outline" size="page" wide href={EXTENSION_GUIDE} newTab>
              {t('Add to Chrome')}
              <Away />
            </Button>
            <div>
              <LinkButton onClick={connect}>{t('Connect this browser')}</LinkButton>
            </div>
          </div>
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
          {link === undefined ? null : (
            <p className="text-hint text-muted">
              {t('A page opened in a new tab. If it did not, open')}{' '}
              <LinkButton space="inline" href={link} newTab>
                {t('this link')}
              </LinkButton>
              {t(': it works once, for fifteen minutes.')}
            </p>
          )}
        </OptionCard>
        <OptionCard title={t('Script tag')}>
          <p className="text-small text-muted">
            {site.visibility === 'members'
              ? t('Before the closing body tag. Members see their pins on every visit.')
              : t('Before the closing body tag. Every visitor sees the pins.')}
          </p>
          <Snippet label={t('Script tag')} className="mb-1.5">
            {snippet}
          </Snippet>
          <div className="mt-auto">
            <Button tone="outline" size="page" wide onClick={copy}>
              {copied === 'yes' ? t('Copied') : t('Copy script')}
            </Button>
          </div>
          {copied === 'refused' ? (
            <p role="alert" className="text-hint text-muted">
              {t('The browser refused the copy. Select the script above and copy it by hand.')}
            </p>
          ) : null}
        </OptionCard>
      </AutoGrid>
      <p role="status" className="mt-4.5 text-small">
        <strong className="font-semibold">{t('Waiting for your first note.')}</strong>{' '}
        <span className="text-muted">{t('Open the site, click Leave feedback, then any part of the page.')}</span>{' '}
        <LinkButton space="inline" href={site.origin} newTab>
          {t('Open {site}', { site: host })}
        </LinkButton>
      </p>
      <div className="mt-6">
        <Button to={`/w/${workspace.id}/sites`}>{t('Open the console')}</Button>
      </div>
    </>
  );
}

/**
 * How the first note came: the extension, the script, or the worker does not say. The mockup says
 * « Extension on in Chrome »; the worker does not say which browser sent the note, and this page may
 * be in another one, so no browser is named.
 */
function howItCame(via: readonly ('script' | 'extension')[]): string {
  if (via.includes('extension')) return t('Extension on');
  if (via.includes('script')) return t('Script on the site');

  return t('Fruitback on the site');
}

/** Step 3, done: how the first note came, and when (the state `first-note` of the mockup). */
export function PutDone({ site }: { site: Site }) {
  useLocale();
  const how = howItCame(site.via ?? []);
  return (
    <div className="mt-1.5 flex flex-col gap-1 text-body">
      <p className="font-semibold">{how}</p>
      <p className="text-muted">{received(site.lastNoteAt)}</p>
    </div>
  );
}

/** When the first note came. A worker that counts the notes and gives no day says no moment. */
function received(at: string | undefined): string {
  if (at === undefined) return t('First note received');
  if (Date.now() - new Date(at).getTime() < 60_000) return t('First note received just now');

  return t('First note received {when}', { when: ago(at).toLocaleLowerCase(locale()) });
}

/** The arrow of a link that leaves the console. */
function Away() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5">
      <path
        d="M8 16L16 8M9.5 8H16v6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
