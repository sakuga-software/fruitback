import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import { connecting, initialOf, loading, notAWebPage, shell, signInProblem, signedOut } from './popup-view.ts';

/**
 * Every screen of a sign-in, built and read on happy-dom (FRU-251): its words, its roles and names,
 * and the order a keyboard meets its controls. The measures are `e2e/popup-layout.spec.ts`'s.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/popup.html' }).document as unknown as Document;
}

/** What a keyboard reaches, in order, by role and name. */
function stops(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('button, a[href], input, select')].map((control) => {
    const name = control.getAttribute('aria-label') ?? control.textContent ?? '';

    return `${control.tagName === 'A' ? 'link' : 'button'}: ${name.trim()}`;
  });
}

const ORIGIN = 'https://staging.acme.dev';
const nothing = () => {};

afterEach(() => setLanguage('en'));

describe('the shell of the popup', () => {
  it('has a head with the logo and the gear, a body, and no foot when nobody is signed in', () => {
    const document = page();
    const root = shell(document, { onSettings: nothing }, document.createTextNode('Body'));

    assert.deepEqual(
      [...root.children].map((child) => child.className),
      ['popup-head', 'popup-body'],
    );
    const logo = root.querySelector('.popup-head svg.logo');
    assert.equal(logo?.getAttribute('role'), 'img');
    assert.equal(logo?.getAttribute('aria-label'), 'Fruitback');
    assert.deepEqual(stops(root), ['button: Settings and every site']);
    // The gear is a drawing the button names: it says nothing of its own.
    assert.equal(root.querySelector('.icon-button svg')?.getAttribute('aria-hidden'), 'true');
  });

  it('says who is signed in, and gives the foot of the account', () => {
    const document = page();
    let settings = 0;
    const root = shell(document, {
      onSettings: () => (settings += 1),
      account: { name: 'Camille Durand', email: 'camille@acme.dev', console: 'https://app.fruitback.test' },
    });

    const avatar = root.querySelector('.avatar');
    assert.equal(avatar?.textContent, 'C');
    assert.equal(avatar?.getAttribute('role'), 'img');
    assert.equal(avatar?.getAttribute('aria-label'), 'Signed in as Camille Durand');
    const foot = root.querySelector('.popup-foot');
    assert.equal(foot?.querySelector('.who')?.textContent, 'camille@acme.dev');
    const consoleLink = foot?.querySelector('a');
    assert.equal(consoleLink?.textContent, 'Open the console');
    assert.equal(consoleLink?.getAttribute('href'), 'https://app.fruitback.test');
    assert.equal(consoleLink?.getAttribute('rel'), 'noreferrer');
    (root.querySelector('.icon-button') as HTMLElement).click();
    assert.equal(settings, 1);
  });

  it('gives no link to a console it does not know, and the name when there is no address', () => {
    const document = page();
    const root = shell(document, { onSettings: nothing, account: { name: 'Camille' } });

    assert.equal(root.querySelector('.popup-foot .who')?.textContent, 'Camille');
    assert.equal(root.querySelector('.popup-foot a'), null);
  });

  it('takes the first letter of a name, whatever is in front of it', () => {
    assert.equal(initialOf('  émile'), 'É');
    assert.equal(initialOf('"Zoë"'), 'Z');
    assert.equal(initialOf('42 rue'), '4');
    assert.equal(initialOf(''), '?');
    assert.equal(initialOf('—'), '?');
  });
});

describe('signed out (05)', () => {
  it('says what to do, offers one action, and points a self-hosted instance to the settings', () => {
    const document = page();
    const done: string[] = [];
    const root = signedOut(document, {
      origin: ORIGIN,
      canSignIn: true,
      onSignIn: () => done.push('sign in'),
      onSettings: () => done.push('settings'),
    });

    assert.equal(root.querySelector('.host')?.textContent, 'staging.acme.dev');
    assert.equal(root.querySelector('h1')?.textContent, 'Sign in to see and leave notes here');
    assert.equal(
      root.querySelector('.lead')?.textContent,
      'One account for the console and this extension. The sign-in opens in a tab, and this popup picks it up by itself.',
    );
    assert.equal(root.querySelector('.popup-foot')?.textContent, 'Running your own Fruitback? Connect it in settings');
    // The order of the mock-up: the settings, the action, the link.
    assert.deepEqual(stops(root), [
      'button: Settings and every site',
      'button: Sign in to Fruitback',
      'button: Connect it in settings',
    ]);
    // Signed out: no avatar, and none of the words the popup no longer says.
    assert.equal(root.querySelector('.avatar'), null);
    assert.doesNotMatch(root.textContent ?? '', /\b(worker|rule|mode|client id|pair)/i);

    (root.querySelector('.action') as HTMLElement).click();
    (root.querySelector('.popup-foot button') as HTMLElement).click();
    assert.deepEqual(done, ['sign in', 'settings']);
  });

  it('has no sign-in in a build that names no Fruitback to sign in to', () => {
    const root = signedOut(page(), { origin: ORIGIN, canSignIn: false, onSignIn: nothing, onSettings: nothing });

    assert.equal(root.querySelector('.action'), null);
    assert.deepEqual(stops(root), ['button: Settings and every site', 'button: Connect it in settings']);
  });

  it('says the session ended when it did, and still offers the one action', () => {
    const root = signedOut(page(), {
      origin: ORIGIN,
      canSignIn: true,
      ended: true,
      onSignIn: nothing,
      onSettings: nothing,
    });

    assert.equal(root.querySelector('h1')?.textContent, 'Your sign-in ended');
    assert.equal(root.querySelector('.lead')?.textContent, 'Sign in again to see and leave notes here.');
    assert.equal(root.querySelector('.action')?.textContent, 'Sign in to Fruitback');
  });

  it('speaks French', () => {
    setLanguage('fr');
    const root = signedOut(page(), { origin: ORIGIN, canSignIn: true, onSignIn: nothing, onSettings: nothing });

    assert.equal(root.querySelector('h1')?.textContent, 'Connectez-vous pour voir et laisser des notes ici');
    assert.equal(root.querySelector('.action')?.textContent, 'Se connecter à Fruitback');
  });
});

describe('a sign-in that waits for the console', () => {
  it('shows the word to check, says it waits once, and can start again', () => {
    const document = page();
    let again = 0;
    const root = connecting(document, {
      origin: ORIGIN,
      word: 'PLUM 47',
      onStartAgain: () => (again += 1),
      onSettings: nothing,
    });

    assert.equal(root.querySelector('h1')?.textContent, 'Check that the tab shows the same word');
    const word = root.querySelector('.word');
    assert.equal(word?.textContent, 'PLUM 47');
    assert.equal(root.querySelector('[role="status"]')?.textContent, 'Waiting for you to connect in the tab…');
    assert.deepEqual(stops(root), ['button: Settings and every site', 'button: Start again']);
    (root.querySelector('.link-button') as HTMLElement).click();
    assert.equal(again, 1);
  });

  it('says when Fruitback did not answer a claim, and keeps the word', () => {
    const root = connecting(page(), {
      origin: ORIGIN,
      word: 'PLUM 47',
      unanswered: true,
      onStartAgain: nothing,
      onSettings: nothing,
    });

    assert.equal(root.querySelector('[role="status"]')?.textContent, 'Fruitback did not answer. The popup asks again.');
    assert.equal(root.querySelector('.word')?.textContent, 'PLUM 47');
  });

  it('writes the word as text, whatever Fruitback sent', () => {
    const root = connecting(page(), {
      origin: ORIGIN,
      word: '<img src=x onerror=alert(1)>',
      onStartAgain: nothing,
      onSettings: nothing,
    });

    assert.equal(root.querySelector('img'), null);
    assert.equal(root.querySelector('.word')?.textContent, '<img src=x onerror=alert(1)>');
  });
});

describe('a sign-in that did not finish', () => {
  for (const [problem, title, sentence, button] of [
    ['refused', 'The sign-in did not finish.', 'It was refused in the console.', 'Sign in to Fruitback'],
    ['expired', 'The sign-in did not finish.', 'The tab was not approved in time.', 'Sign in to Fruitback'],
    ['unavailable', 'Fruitback did not answer.', 'Check the connection, then try again.', 'Try again'],
    [
      'untrusted',
      'The sign-in did not start.',
      'Fruitback named a console that is not its own.',
      'Sign in to Fruitback',
    ],
    [
      'blocked',
      'The sign-in did not start.',
      'The browser did not give the extension access to Fruitback.',
      'Sign in to Fruitback',
    ],
  ] as const) {
    it(`says why when it was ${problem}, and offers to start again`, () => {
      let again = 0;
      const root = signInProblem(page(), {
        origin: ORIGIN,
        problem,
        onSignIn: () => (again += 1),
        onSettings: nothing,
      });

      assert.equal(root.querySelector('h1')?.textContent, title);
      // Said at once: the screen changed under the person, and this is why.
      assert.equal(root.querySelector('[role="alert"]')?.textContent, sentence);
      assert.deepEqual(stops(root), ['button: Settings and every site', `button: ${button}`]);
      (root.querySelector('.action') as HTMLElement).click();
      assert.equal(again, 1);
    });
  }
});

describe('the two screens with nothing to do', () => {
  it('says that a page that is not http or https is not one Fruitback runs on', () => {
    const root = notAWebPage(page(), { onSettings: nothing });

    assert.equal(root.querySelector('h1')?.textContent, 'Fruitback works on http and https pages.');
  });

  it('says it is loading, once, with nothing to press but the settings', () => {
    const root = loading(page(), { onSettings: nothing });

    assert.equal(root.querySelector('[role="status"]')?.textContent, 'Loading…');
    assert.deepEqual(stops(root), ['button: Settings and every site']);
  });
});
