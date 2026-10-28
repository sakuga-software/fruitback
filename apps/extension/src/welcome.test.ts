import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { WELCOME_PATH, opensWelcome } from './welcome-install.ts';
import { type WelcomeSignIn, welcomeScreen } from './welcome.ts';

function page(): Document {
  return new HappyDomWindow({ url: `chrome-extension://fruitback${WELCOME_PATH}` }).document as unknown as Document;
}

/** Lets the rejection of `openPopup` reach its handler. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the page that opens at install (FRU-318)', () => {
  afterEach(() => setLanguage('en'));

  it('opens at a first install only, not at an update or a browser update', () => {
    assert.equal(opensWelcome({ reason: 'install' }), true);
    for (const reason of ['update', 'chrome_update', 'browser_update', 'shared_module_update']) {
      assert.equal(opensWelcome({ reason }), false, reason);
    }
  });

  it('says to pin Fruitback, then to sign in from its icon', () => {
    const screen = welcomeScreen(page(), { openPopup: async () => {} });
    assert.equal(screen.querySelector('h1')?.textContent, 'Fruitback is installed');
    const steps = [...screen.querySelectorAll('ol > li > strong')].map((name) => name.textContent);
    assert.deepEqual(steps, ['Pin Fruitback', 'Sign in']);
    assert.match(screen.textContent ?? '', /Sign in with email/);
    assert.deepEqual(
      [...screen.querySelectorAll('button')].map((button) => button.textContent),
      ['Open Fruitback'],
    );
  });

  it('opens the popup, and says where the icon is when the browser refuses', async () => {
    let asked = 0;
    const refused = welcomeScreen(page(), {
      openPopup: async () => {
        asked += 1;
        throw new Error('not allowed');
      },
    });
    refused.querySelector('button')?.click();
    await settled();
    assert.equal(asked, 1);
    assert.equal(
      refused.querySelector('[role="status"]')?.textContent,
      'Your browser did not open it from this page: click the Fruitback icon in the toolbar.',
    );

    const opened = welcomeScreen(page(), { openPopup: async () => {} });
    opened.querySelector('button')?.click();
    await settled();
    assert.equal(opened.querySelector('[role="status"]')?.textContent, '');
  });

  describe('the sign-in on the page (FRU-482)', () => {
    const signIn = (state: WelcomeSignIn, onSignIn = () => {}, onStartAgain = () => {}) =>
      welcomeScreen(page(), { openPopup: async () => {}, signIn: { state, onSignIn, onStartAgain } });

    it('offers the three ways of the popup, each starting the sign-in, and no way to the popup', () => {
      let asked = 0;
      const screen = signIn({ kind: 'signed-out' }, () => (asked += 1));
      const buttons = [...screen.querySelectorAll('button')];
      assert.deepEqual(
        buttons.map((button) => button.textContent),
        ['Sign in with email', 'Google', 'GitHub'],
      );
      for (const button of buttons) button.click();
      assert.equal(asked, 3);
      assert.match(screen.textContent ?? '', /Here, with the email of your work\./);
      assert.doesNotMatch(screen.textContent ?? '', /Click the Fruitback icon/);
    });

    it('says what stopped a sign-in above the ways to sign in again', () => {
      const screen = signIn({
        kind: 'signed-out',
        stop: { title: 'The sign-in did not finish.', text: 'It was refused.' },
      });
      assert.match(screen.textContent ?? '', /The sign-in did not finish\.It was refused\./);
      assert.equal(screen.querySelector('button')?.textContent, 'Sign in with email');
    });

    it('shows the word to check while the console has not answered, and starts again', () => {
      let again = 0;
      const screen = signIn({ kind: 'connecting', word: 'PLUM 47' }, undefined, () => (again += 1));
      assert.equal(screen.querySelector('.word')?.textContent, 'PLUM 47');
      assert.equal(screen.querySelector('[role="status"]')?.textContent, 'Waiting for you to connect in the tab…');
      screen.querySelector('button')?.click();
      assert.equal(again, 1);
    });

    it('says who is signed in, and where to go next', () => {
      const screen = signIn({ kind: 'signed-in', who: 'ana@acme.dev' });
      assert.equal(screen.querySelector('[role="status"]')?.textContent, 'Signed in as ana@acme.dev.');
      assert.equal(screen.querySelectorAll('button').length, 0);
    });
  });

  it('is in French for a French reviewer', () => {
    setLanguage('fr');
    const screen = welcomeScreen(page(), { openPopup: async () => {} });
    assert.equal(screen.querySelector('h1')?.textContent, 'Fruitback est installé');
    assert.equal(screen.querySelector('button')?.textContent, 'Ouvrir Fruitback');
  });
});
