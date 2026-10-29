import type { Site, Workspace } from '../api';
import { ago } from '../ago';
import { locale, t } from '../i18n';
import { extensionInstallFor } from '../extension-store';
import { useConnectedExtension } from '../extension-connected';
import { EXTENSION_IDS, hereProblemOf, useExtensionHere } from '../extension-here';
import { type ReactNode, useState } from 'react';
import { BY_SIGN_IN, CONNECT_PAGE, snippetFor, useConnect, useCopy } from '../install-options';
import { AutoGrid, Button, LinkButton, OptionCard, Problem, Snippet, StatusDot } from '../ui';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import { SetupGuide } from '../setup-guide';

/** Step 3 of the setup, « Put it on the site » (FRU-242). */

/**
 * Step 3: the two ways to put Fruitback on the site, each in its card, then what to do on the site.
 *
 * « Connect this browser » opens `/connect` on Fruitback Cloud (FRU-313): the popup signs in with the
 * account, as everywhere. A self-hosted console still opens the pairing link of its worker, with a
 * code that nobody types (FRU-238). The step waits
 * for the first note (`setup.tsx` reads the site again), and « Open the console » stays, for a person
 * who does not send one now.
 *
 * With a browser of the extension already connected to the account, the card says so and names it,
 * and « Connect another browser » is the only way on (FRU-441): nothing asks to install it again.
 *
 * On the console of the Cloud, the extension of this browser answers the page (FRU-487,
 * `extension-here.ts`): installed and signed out, « Connect this browser » connects it in place, with
 * no tab and no word. Installed and signed in, the card says so. Elsewhere, nothing changes.
 *
 * On Fruitback Cloud, the guide of the extension is folded under the cards (FRU-486).
 */
export function PutOnSite({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const snippet = snippetFor(site);
  const { copied, copy } = useCopy(snippet);
  const { link, problem, connect } = useConnect(workspace);
  const host = siteLabel(site.origin);
  const connected = useConnectedExtension();
  const { here, connect: connectHere } = useExtensionHere(EXTENSION_IDS);
  const [hereBusy, setHereBusy] = useState(false);
  const [hereProblem, setHereProblem] = useState<string | undefined>();
  const connectInPlace = async () => {
    if (hereBusy) return;
    setHereBusy(true);
    setHereProblem(undefined);
    try {
      setHereProblem(hereProblemOf(await connectHere()));
    } finally {
      setHereBusy(false);
    }
  };
  const inPlace = here !== undefined && !here.signedIn;
  // FRU-441: with a browser of the account connected, the way on is « Connect another browser », a
  // quiet link, whatever it does. In place (FRU-487) it connects the extension of this browser.
  const connectLabel = connected === undefined ? t('Connect this browser') : t('Connect another browser');
  let connectLink = <LinkButton onClick={connect}>{connectLabel}</LinkButton>;
  if (inPlace) {
    connectLink = (
      <LinkButton disabled={hereBusy} onClick={() => void connectInPlace()}>
        {hereBusy ? t('Connecting…') : connectLabel}
      </LinkButton>
    );
  } else if (BY_SIGN_IN) {
    connectLink = (
      <LinkButton href={CONNECT_PAGE} newTab>
        {connectLabel}
      </LinkButton>
    );
  }
  let card: ReactNode;
  if (here?.signedIn === true && connected === undefined) {
    card = (
      <>
        <p className="mb-1.5 flex items-center gap-2 text-small font-semibold">
          <StatusDot status="done" size={10} />
          {t('Extension connected in this browser')}
        </p>
        <div className="mt-auto">
          <LinkButton href={CONNECT_PAGE} newTab>
            {t('Connect another browser')}
          </LinkButton>
        </div>
      </>
    );
  } else if (inPlace && connected === undefined) {
    card = (
      <>
        <p className="mb-1.5 text-hint">
          {t('Fruitback is installed in this browser. Connect it to your account here: no word to check.')}
        </p>
        <div className="mt-auto">
          <Button tone="outline" size="page" wide disabled={hereBusy} onClick={() => void connectInPlace()}>
            {hereBusy ? t('Connecting…') : t('Connect this browser')}
          </Button>
        </div>
      </>
    );
  } else if (connected === undefined) {
    card = (
      <>
        <p className="mb-1.5 text-hint">
          {t('Add it, then connect this browser: a page opens, and you click the Fruitback icon there.')}
        </p>
        <div className="mt-auto flex flex-col gap-2">
          <Button tone="outline" size="page" wide href={extensionInstallFor(navigator.userAgent)} newTab>
            {t('Install the extension (beta)')}
            <Away />
          </Button>
          <div>{connectLink}</div>
        </div>
      </>
    );
  } else {
    card = (
      <>
        <p className="mb-1.5 flex items-center gap-2 text-small font-semibold">
          <StatusDot status="done" size={10} />
          {t('Extension connected · {browser}', { browser: connected.browser })}
        </p>
        <div className="mt-auto">{connectLink}</div>
      </>
    );
  }

  return (
    <>
      <p className="mt-1 mb-4 text-body text-muted">{t('Use one, or both.')}</p>
      <AutoGrid min={230}>
        <OptionCard title={t('Browser extension')}>
          <p className="text-small text-muted">{t("Nothing to deploy. Right for a client's site you cannot touch.")}</p>
          {card}
          {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
          {hereProblem === undefined ? null : <Problem>{t(hereProblem)}</Problem>}
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
      {/* The guide walks the sign-in of Fruitback Cloud, which a self-hosted console does not use. */}
      {BY_SIGN_IN ? <SetupGuide /> : null}
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
