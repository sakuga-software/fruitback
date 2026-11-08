import { type Site, type Workspace, call } from '../api';
import { agoInSentence } from '../ago';
import { t } from '../i18n';
import { extensionInstallFor } from '../extension-store';
import { useConnectedExtension } from '../extension-connected';
import { EXTENSION_IDS, hereProblemOf, useExtensionHere } from '../extension-here';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { BY_SIGN_IN, CONNECT_PAGE, snippetFor, useConnect, useCopy } from '../install-options';
import { Button, LinkButton, OptionCard, Problem, Snippet, SuccessMark } from '../ui';
import { useLocale } from '../use-locale';
import { siteLabel } from '../site-address';
import { SetupGuide } from '../setup-guide';
import {
  type FirstNote,
  type Way,
  excerptShown,
  firstNoteLink,
  firstNoteOf,
  firstNotePath,
  recommendedWay,
} from '../setup-stage';

/** Step 3 of the setup, « Put it on the site » (FRU-242). */

/**
 * Step 3: the two ways to put Fruitback on the site, each in its card, then what to do on the site.
 *
 * One way is recommended, after who sees the notes of the site (FRU-610, board P6 of FRU-598): the
 * extension for a site of members, since only they need it and nothing is deployed; the script tag
 * for a site that every visitor sees, since a visitor has no extension. The other card is folded
 * under « Show ».
 *
 * On Fruitback Cloud the card of the extension has no « Connect this browser » beside « Install the
 * extension »: the welcome page that opens at the install signs in and turns the site on (FRU-482,
 * FRU-483), and a second way there sent people to a tab that waits for a popup. A self-hosted console
 * keeps it: there it opens the pairing link of its worker, the only way that extension connects
 * (FRU-238).
 *
 * With a browser of the extension already connected to the account, the card says so and names it,
 * and « Connect another browser » is the only way on (FRU-441): nothing asks to install it again.
 *
 * On the console of the Cloud, the extension of this browser answers the page (FRU-487,
 * `extension-here.ts`): installed and signed out, « Connect this browser » connects it in place, with
 * no tab and no word. Installed and signed in, the card says so. Elsewhere, nothing changes.
 *
 * The step waits for the first note (`setup.tsx` reads the site again), and « Open the console »
 * stays, for a person who does not send one now. On Fruitback Cloud, the guide of the extension is
 * folded under the cards (FRU-486).
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
  const recommended = recommendedWay(site);
  // The card that is not recommended opens folded; « Show » opens it, and it stays open.
  const [shown, setShown] = useState(false);
  const fold = (way: Way) =>
    way === recommended ? undefined : { open: shown, onToggle: setShown, show: t('Show'), hide: t('Hide') };
  const badge = (way: Way) => {
    if (way !== recommended) return undefined;

    return way === 'extension' ? t('Recommended for a members site') : t('Recommended for a public site');
  };
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
          <SuccessMark size="inline" />
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
          {BY_SIGN_IN
            ? t('Add it to your browser. The page that opens signs you in and turns on {site}.', { site: host })
            : t('Add it, then connect this browser: a page opens, and you click the Fruitback icon there.')}
        </p>
        <div className="mt-auto flex flex-col gap-2">
          <Button
            tone={recommended === 'extension' ? 'primary' : 'outline'}
            size="page"
            wide
            href={extensionInstallFor(navigator.userAgent)}
            newTab
          >
            {t('Install the extension')}
            <Away />
          </Button>
          {/* The Cloud: the welcome page of the extension connects it. Self-hosted: the pairing link. */}
          {BY_SIGN_IN ? null : <div>{connectLink}</div>}
        </div>
      </>
    );
  } else {
    card = (
      <>
        <p className="mb-1.5 flex items-center gap-2 text-small font-semibold">
          <SuccessMark size="inline" />
          {t('Extension connected · {browser}', { browser: connected.browser })}
        </p>
        <div className="mt-auto">{connectLink}</div>
      </>
    );
  }
  const cards: Record<Way, ReactNode> = {
    extension: (
      <OptionCard key="extension" title={t('Browser extension')} badge={badge('extension')} fold={fold('extension')}>
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
    ),
    script: (
      <OptionCard key="script" title={t('Script tag')} badge={badge('script')} fold={fold('script')}>
        <p className="text-small text-muted">
          {site.visibility === 'members'
            ? t('Before the closing body tag. Members see their pins on every visit.')
            : t('Before the closing body tag. Every visitor sees the pins.')}
        </p>
        <Snippet label={t('Script tag')} className="mb-1.5">
          {snippet}
        </Snippet>
        <div className="mt-auto">
          <Button tone={recommended === 'script' ? 'primary' : 'outline'} size="page" wide onClick={copy}>
            {copied === 'yes' ? t('Copied') : t('Copy script')}
          </Button>
        </div>
        {copied === 'refused' ? (
          <p role="alert" className="text-hint text-muted">
            {t('The browser refused the copy. Select the script above and copy it by hand.')}
          </p>
        ) : null}
      </OptionCard>
    ),
  };

  return (
    <>
      <p className="mt-1 mb-4 text-body text-muted">{t('Use one, or both.')}</p>
      {/* The recommended way first: the eye and the keyboard reach it before the other. */}
      <div className="flex flex-col gap-3">
        {cards[recommended]}
        {cards[recommended === 'extension' ? 'script' : 'extension']}
      </div>
      {/* The guide walks the sign-in of Fruitback Cloud, which a self-hosted console does not use. */}
      {BY_SIGN_IN ? <SetupGuide /> : null}
      {/* The drop beats while the page reads the site again. It hangs in the gutter: the words stay on the column. */}
      <p role="status" className="mt-4.5 -ml-4.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 text-small">
        <span aria-hidden="true" className="setup-waiting" />
        <span>
          <strong className="font-semibold">{t('Waiting for your first note.')}</strong>{' '}
          <span className="text-muted">{t('Open the site, click Leave a note, then any part of the page.')}</span>{' '}
          <span className="mt-1 block wrap-anywhere">
            <LinkButton space="inline" href={site.origin} newTab>
              {t('Open {site}', { site: host })}
            </LinkButton>
          </span>
        </span>
      </p>
      <div className="mt-6">
        <Button tone="outline" to={`/w/${workspace.id}/sites`}>
          {t('Open the console')}
        </Button>
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

  return t('First note received {when}', { when: agoInSentence(at) });
}

/**
 * The end of the setup (FRU-610, board P6 of FRU-598): the note that came, then the two ways on,
 * « Connect Linear or GitHub » and « Open the console ».
 *
 * The note is what the index of the notes keeps of it (FRU-237): the first 64 characters of its text,
 * its page, and its selector and its component (FRU-613). Never its whole text: the console reads no
 * store of the notes. The page opens on the note, where the widget shows all of it. A worker with no
 * index answers no note: the end is said without it.
 *
 * Said once it appears, with no move of the focus: the person may be on the site, in another tab.
 */
export function FirstNoteIn({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const [first, setFirst] = useState<FirstNote | undefined>();
  useEffect(() => {
    let live = true;
    void call<unknown>('GET', firstNotePath(workspace, site), undefined, { quiet: true }).then((answer) => {
      if (live) setFirst(firstNoteOf(answer));
    });

    return () => {
      live = false;
    };
  }, [workspace, site]);
  const link = first === undefined ? undefined : firstNoteLink(first, site);

  return (
    <div role="status" className="mt-9 flex flex-col gap-2.5 border-t border-line pt-7">
      <h2 className="text-conclusion font-bold tracking-[-0.01em]">{t('Your first note is in')}</h2>
      {first === undefined ? null : (
        <figure className="flex flex-col gap-1.5 rounded-[12px] border border-line px-4 py-3.5">
          <blockquote className="text-body font-semibold wrap-anywhere">{excerptShown(first.excerpt)}</blockquote>
          <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-small text-muted">
            <span className="wrap-anywhere">
              {t('On {page}', { page: `${first.page.host}${first.page.path}` })}
              {[
                { key: 'selector', part: first.selector },
                { key: 'component', part: first.component === undefined ? undefined : `<${first.component}>` },
              ].map(({ key, part }) =>
                part === undefined ? null : (
                  <Fragment key={key}>
                    <span aria-hidden="true">{' · '}</span>
                    <code className="font-mono">{part}</code>
                  </Fragment>
                ),
              )}
            </span>
            {link === undefined ? null : (
              <LinkButton space="inline" href={link} newTab>
                {t('Show on the page')}
              </LinkButton>
            )}
          </figcaption>
        </figure>
      )}
      <p className="text-body leading-[1.55] text-muted">
        {t('It waits in the {workspace} workspace. Send your notes to a tracker or your own API whenever you like.', {
          workspace: workspace.name,
        })}
      </p>
      <div className="mt-2 flex flex-wrap gap-2.5">
        <Button inset={22} to={`/w/${workspace.id}/connectors`}>
          {t('Connect Linear or GitHub')}
        </Button>
        <Button tone="outline" size="page" inset={18} to={`/w/${workspace.id}/sites`}>
          {t('Open the console')}
        </Button>
      </div>
    </div>
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
