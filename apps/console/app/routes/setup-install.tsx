import type { Site, Workspace } from '../api';
import { t } from '../i18n';
import { EXTENSION_GUIDE, snippetFor, useConnect, useCopy } from '../install-options';
import { AutoGrid, Button, LinkButton, OptionCard, Problem, Snippet } from '../ui';
import { useLocale } from '../use-locale';

/** Step 3 of the setup, « Put it on the site » (FRU-242). */

/**
 * Step 3: the two ways to put Fruitback on the site, each in its card, then what to do on the site.
 *
 * Two things of the mockup are not here, each for a decision that is open (FRU-230). The extension
 * does not « sign in with this account » yet (Q8): a browser is connected from here, with a code
 * that nobody types. And nothing tells the console that a first note came (FRU-237): so the step
 * does not say that it waits for one, and « Open the console » is always there.
 */
export function PutOnSite({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const snippet = snippetFor(site);
  const { copied, copy } = useCopy(snippet);
  const { link, problem, connect } = useConnect(workspace);
  const host = new URL(site.origin).host;

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
      <p className="mt-4.5 text-small">
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
