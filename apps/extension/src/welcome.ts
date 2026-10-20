import { t } from './i18n.ts';
import { head, primaryButton } from './kit.ts';
import { element } from './popup-view.ts';

/**
 * The page that opens when the extension is installed (FRU-318).
 *
 * At install Chrome hides the icon in the menu of the extensions, and nothing said what comes next.
 * This page says it: pin Fruitback, then sign in from its popup. The sign-in itself stays in the
 * popup (« Sign in to Fruitback », FRU-251): one way in, not a second one here.
 *
 * It is an extension page that `tabs.create` opens: no permission, and no entry in the manifest.
 */

export type WelcomeOptions = {
  /** Opens the popup of the extension. It rejects where the browser does not let a page open it. */
  openPopup: () => Promise<void>;
};

/** The page: two steps, and the way to the popup. */
export function welcomeScreen(document: Document, options: WelcomeOptions): HTMLElement {
  document.title = t('Welcome to Fruitback');
  const root = element(document, 'main', '', 'welcome');
  const top = head(document);
  top.classList.add('welcome-head');

  const title = element(document, 'h1', t('Fruitback is installed'));
  const lead = element(
    document,
    'p',
    t('Pin Fruitback, then sign in. It then works on every site your team reviews.'),
    'lead',
  );

  const steps = element(document, 'ol', '', 'welcome-steps');
  steps.append(
    step(
      document,
      t('Pin Fruitback'),
      t('Open the puzzle piece at the right of the address bar, then press the pin beside Fruitback.'),
    ),
    step(document, t('Sign in'), t('Click the Fruitback icon, then Sign in with email.')),
  );

  const invited = element(
    document,
    'p',
    t('Invited by a client or a team? Use the email the invitation was sent to.'),
    'welcome-invited',
  );
  const said = element(document, 'p', '', 'welcome-hint');
  said.setAttribute('role', 'status');
  const open = primaryButton(document, t('Open Fruitback'), () => {
    said.textContent = '';
    void options.openPopup().catch(() => {
      said.textContent = t('Your browser did not open it from this page: click the Fruitback icon in the toolbar.');
    });
  });

  root.append(top, title, lead, steps, open, said, invited);

  return root;
}

function step(document: Document, name: string, text: string): HTMLLIElement {
  const item = element(document, 'li', '');
  item.append(element(document, 'strong', name), element(document, 'span', text));

  return item;
}
