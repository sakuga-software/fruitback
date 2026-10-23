import { useState } from 'react';
import { API, type Site, type Workspace, call, pairingLink } from './api';
import { msg, t } from './i18n';
import { connectsBySignIn } from './instance';
import { copyText, problemOf } from './problems';
import { Button, Problem, Snippet } from './ui';
import { useLocale } from './use-locale';
import { WIDGET_SCRIPT_PATH } from './widget-script';

/**
 * The two ways to put Fruitback on a site, as the Sites screen shows them for a site: the script
 * tag, and the browser of the person. The setup has its own drawing of them since FRU-239.
 */

/** The script tag a site embeds, pointing at this console's copy of the widget, at its versioned address (FRU-106). */
export function snippetFor(site: Site): string {
  return [
    '<script',
    `  src="${window.location.origin}${WIDGET_SCRIPT_PATH}"`,
    `  data-fruitback-endpoint="${API}"`,
    `  data-fruitback-client="${site.id}"`,
    '  defer',
    '></script>',
  ].join('\n');
}

// Every role connects a browser, so no code of the worker has a sentence of its own here.
const CONNECT_PROBLEMS: Readonly<Record<string, string>> = {};
const BROWSER_NOT_CONNECTED = msg('This browser was not connected. Try again.');

/**
 * Where the extension is explained: the page that walks somebody who is no developer through the
 * archive of the release. The rail sends Chrome and Edge to the store instead (`extension-store.ts`).
 */
export { EXTENSION_GUIDE } from './extension-store';

/** A text put in the clipboard: whether the browser took it. « refused »: it stays on screen to select. */
export function useCopy(text: string): { copied: 'no' | 'yes' | 'refused'; copy: () => void } {
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no');

  return { copied, copy: () => void copyText(text).then((taken) => setCopied(taken ? 'yes' : 'refused')) };
}

/**
 * Where « Connect this browser » leads on Fruitback Cloud (FRU-313): a page of the console that says
 * to sign in from the popup. It mints nothing, and the session is the one of the account.
 */
export const CONNECT_PAGE = '/connect';

/** Whether this console connects a browser by the sign-in of the popup, or by a pairing link. */
export const BY_SIGN_IN = connectsBySignIn(API);

/**
 * Connects the browser of the person on a self-hosted instance: a code is made, and the pairing page of the worker opens with
 * it in another tab. `link` is that page, for a browser that blocked the tab.
 */
export function useConnect(workspace: Workspace): {
  link: string | undefined;
  problem: string | undefined;
  connect: () => void;
} {
  const [link, setLink] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  async function connect() {
    // Open the tab in the click, before the await: a browser blocks a window opened after one.
    // The tab loses its `opener` before it loads the pairing page.
    const tab = window.open('', '_blank');
    setProblem(undefined);
    const minted = await call<{ code: string }>('POST', `/console/workspaces/${workspace.id}/connect`, {});
    if (!minted.ok) {
      // The tab that just opened closes: the reason is said under the button (FRU-164).
      tab?.close();

      return setProblem(problemOf(minted, CONNECT_PROBLEMS, BROWSER_NOT_CONNECTED));
    }
    const target = pairingLink(minted.data.code);
    setLink(target);
    if (tab !== null) {
      tab.opener = null;
      tab.location.href = target;
    }
  }

  return { link, problem, connect: () => void connect() };
}

export function InstallOptions({ workspace, site }: { workspace: Workspace; site: Site }) {
  useLocale();
  const snippet = snippetFor(site);
  const { copied, copy } = useCopy(snippet);
  const { link, problem, connect } = useConnect(workspace);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold">{t('Script')}</h2>
        <p className="mb-2 text-xs text-muted">{t('Paste it before the closing body tag of the site.')}</p>
        {/* The box of the script takes focus, so a keyboard scrolls its long lines (axe, FRU-239). */}
        <Snippet label={t('Script')}>{snippet}</Snippet>
        <Button tone="outline" className="mt-2" onClick={copy}>
          {copied === 'yes' ? t('Copied') : t('Copy the script')}
        </Button>
        {copied === 'refused' ? (
          <p role="alert" className="mt-2 text-xs text-muted">
            {t('The browser refused the copy. Select the script above and copy it by hand.')}
          </p>
        ) : null}
      </div>
      <div>
        <h2 className="text-sm font-semibold">{t('Extension')}</h2>
        <p className="mb-2 text-xs text-muted">
          {t(
            'Nothing to change on the site. Connect this browser, then click the Fruitback icon on the page that opens.',
          )}
        </p>
        {BY_SIGN_IN ? (
          <Button tone="outline" href={CONNECT_PAGE} newTab>
            {t('Connect this browser')}
          </Button>
        ) : (
          <Button tone="outline" onClick={connect}>
            {t('Connect this browser')}
          </Button>
        )}
        {problem === undefined ? null : (
          <div className="mt-2">
            <Problem>{t(problem)}</Problem>
          </div>
        )}
        {link === undefined ? null : (
          <p className="mt-2 text-xs text-muted">
            {t('A page opened in a new tab. If it did not, open')}{' '}
            <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
              {t('this link')}
            </a>
            {t(': it works once, for fifteen minutes.')}
          </p>
        )}
      </div>
    </div>
  );
}
