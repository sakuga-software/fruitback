import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window as HappyDomWindow } from 'happy-dom';
import { DEMO_FILES, DEMO_FRAMES, DEMO_SECONDS, demoLength } from './demo-video.ts';
import { setLanguage } from './i18n.ts';
import { WELCOME_PATH, opensWelcome } from './welcome-install.ts';
import { type WelcomeSignIn, welcomeScreen } from './welcome.ts';
import { signInStop } from './popup-view.ts';

type WelcomeSign = Extract<WelcomeSignIn, { kind: 'signed-in' }>;

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
      assert.doesNotMatch(screen.textContent ?? '', /Click the Fruitback icon/);
    });

    it('draws the mark of its provider in « Google » and « GitHub », signed out and after a stop (FRU-525)', () => {
      for (const state of [{ kind: 'signed-out' }, { kind: 'signed-out', stop: signInStop('refused') }] as const) {
        const screen = signIn(state);
        const marked = [...screen.querySelectorAll('.method-row button')].map((button) => [
          button.textContent,
          button.querySelector('svg.kit-provider-mark[aria-hidden="true"]')?.getAttribute('data-provider'),
        ]);
        assert.deepEqual(marked, [
          ['Google', 'google'],
          ['GitHub', 'github'],
        ]);
      }
    });

    it('puts the sign-in first, and the pin in a tip under it, with no step to follow (FRU-484)', () => {
      const screen = signIn({ kind: 'signed-out' });
      assert.equal(screen.querySelector('.lead')?.textContent, 'Sign in, then turn on a site your team reviews.');
      assert.equal(screen.querySelectorAll('ol').length, 0);
      const tip = screen.querySelector('.welcome-tip');
      assert.match(tip?.textContent ?? '', /^Tip: Pin Fruitback to find it in the toolbar later: /);
      const order = [...screen.children].map((child) => child.className || child.tagName);
      assert.ok(order.indexOf('welcome-sign-in') < order.indexOf('welcome-tip'), order.join(', '));
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

    describe('the sites to turn on (FRU-483)', () => {
      const signedIn = (sites: WelcomeSign['sites'], extra: Partial<WelcomeSign> = {}) => {
        const asked: string[] = [];
        const screen = welcomeScreen(page(), {
          openPopup: async () => {},
          signIn: {
            state: { kind: 'signed-in', who: 'ana@acme.dev', ...(sites === undefined ? {} : { sites }), ...extra },
            onSignIn: () => {},
            onStartAgain: () => {},
            onTurnOn: (origin) => asked.push(`on ${origin}`),
            onOpen: (origin) => asked.push(`open ${origin}`),
            onAddSite: () => asked.push('add'),
          },
        });

        return { screen, asked, buttons: () => [...screen.querySelectorAll('button')] };
      };

      it('offers one site as the one button of the page, and says what Chrome asks', () => {
        const { screen, asked, buttons } = signedIn([{ origin: 'https://staging.acme.dev', on: false }]);
        assert.deepEqual(
          buttons().map((button) => button.textContent),
          ['Turn on staging.acme.dev'],
        );
        assert.equal(buttons()[0]?.className, 'kit-primary');
        assert.match(screen.textContent ?? '', /Chrome asks for access to this site only\./);
        buttons()[0]?.click();
        assert.deepEqual(asked, ['on https://staging.acme.dev']);
      });

      it('lists several sites, and opens one that is on already', () => {
        const { screen, asked, buttons } = signedIn([
          { origin: 'https://staging.acme.dev', on: true },
          { origin: 'https://acme.dev', on: false },
        ]);
        assert.equal(screen.querySelectorAll('.welcome-sites li').length, 2);
        assert.ok(buttons().every((button) => button.className === 'kit-secondary'));
        assert.deepEqual(
          buttons().map((button) => button.textContent),
          ['Open staging.acme.dev', 'Turn on acme.dev'],
        );
        for (const button of buttons()) button.click();
        assert.deepEqual(asked, ['open https://staging.acme.dev', 'on https://acme.dev']);
      });

      it('leads an account with no site to the console, and says nothing of Chrome', () => {
        const { screen, asked, buttons } = signedIn([]);
        assert.match(screen.textContent ?? '', /No site in your workspaces yet\./);
        assert.doesNotMatch(screen.textContent ?? '', /Chrome asks/);
        buttons()[0]?.click();
        assert.deepEqual(asked, ['add']);
      });

      it('says where to go when Fruitback did not answer, which is not « no site »', () => {
        const { screen, buttons } = signedIn('unavailable');
        assert.match(screen.textContent ?? '', /Open a site of your team, then click the Fruitback icon\./);
        assert.doesNotMatch(screen.textContent ?? '', /No site/);
        assert.equal(buttons().length, 0);
      });

      it('says what stopped a « Turn on », and keeps the button', () => {
        const { screen, buttons } = signedIn([{ origin: 'https://staging.acme.dev', on: false }], {
          problem: 'The browser did not give access to this site.',
        });
        assert.equal(
          screen.querySelector('[role="alert"]')?.textContent,
          'The browser did not give access to this site.',
        );
        assert.equal(buttons()[0]?.textContent, 'Turn on staging.acme.dev');
      });

      it('draws nothing more while the sites are read', () => {
        const { buttons } = signedIn(undefined);
        assert.equal(buttons().length, 0);
      });
    });

    it('says who is signed in, and where to go next', () => {
      const screen = signIn({ kind: 'signed-in', who: 'ana@acme.dev' });
      assert.equal(screen.querySelector('[role="status"]')?.textContent, 'Signed in as ana@acme.dev.');
      assert.equal(screen.querySelectorAll('button').length, 0);
    });
  });

  describe('the demonstration (FRU-531)', () => {
    const noop = () => {};
    const signIn = (state: WelcomeSignIn) => ({
      openPopup: async () => {},
      signIn: { state, onSignIn: noop, onStartAgain: noop, onTurnOn: noop, onOpen: noop, onAddSite: noop },
    });
    /** Every state of the page, as the gallery lists them. */
    const states: [string, Parameters<typeof welcomeScreen>[1]][] = [
      ['signed out', signIn({ kind: 'signed-out' })],
      ['connecting', signIn({ kind: 'connecting', word: 'PLUM 42' })],
      ['signed in, reading', signIn({ kind: 'signed-in', who: 'ana@acme.dev' })],
      [
        'one site',
        signIn({ kind: 'signed-in', who: 'ana@acme.dev', sites: [{ origin: 'https://acme.dev', on: false }] }),
      ],
      ['no site', signIn({ kind: 'signed-in', who: 'ana@acme.dev', sites: [] })],
      ['unavailable', signIn({ kind: 'signed-in', who: 'ana@acme.dev', sites: 'unavailable' })],
      ['a build with no Cloud', { openPopup: async () => {} }],
    ];

    it('shows the video in every state, under what the page asks to do', () => {
      for (const [name, options] of states) {
        const screen = welcomeScreen(page(), options);
        const figures = screen.querySelectorAll('figure.welcome-demo');
        assert.equal(figures.length, 1, name);
        const figure = figures[0] as Element;
        // Under the action: the sign-in, or the button to the popup, is before it, and nothing to press is after it.
        const action = screen.querySelector('.welcome-sign-in') ?? screen.querySelector('button');
        assert.ok(action !== null, name);
        assert.ok(action.compareDocumentPosition(figure) & 4, `${name}: the video is above the action`);
        for (const button of screen.querySelectorAll('button')) {
          assert.ok(
            button.compareDocumentPosition(figure) & 4,
            `${name}: « ${button.textContent} » is under the video`,
          );
        }
        assert.ok(figure.compareDocumentPosition(screen.querySelector('.welcome-invited') as Element) & 4, name);
      }
    });

    it('plays muted, in a loop and inline, from files of the extension, with a poster', () => {
      const video = welcomeScreen(page(), states[0]![1]).querySelector('video') as HTMLVideoElement;
      assert.equal(video.autoplay, true);
      assert.equal(video.muted, true);
      assert.ok(video.hasAttribute('muted'));
      assert.equal(video.loop, true);
      assert.ok(video.hasAttribute('playsinline'));
      assert.equal(video.getAttribute('poster'), DEMO_FILES.poster);
      assert.deepEqual(
        [...video.querySelectorAll('source')].map((source) => [
          source.getAttribute('src'),
          source.getAttribute('type'),
        ]),
        [
          [DEMO_FILES.webm, 'video/webm'],
          [DEMO_FILES.mp4, 'video/mp4'],
        ],
      );
      for (const file of Object.values(DEMO_FILES)) assert.match(file, /^\/demo\//, 'a file of the extension');
    });

    it('stays still when the person asked for less motion', () => {
      const video = welcomeScreen(page(), { ...states[0]![1], reducedMotion: true }).querySelector(
        'video',
      ) as HTMLVideoElement;
      assert.equal(video.autoplay, false);
      assert.equal(video.preload, 'none');
      assert.equal(video.controls, true);
    });

    it('says what it shows, and how long it lasts', () => {
      const caption = welcomeScreen(page(), states[0]![1]).querySelector('figcaption');
      assert.equal(caption?.textContent, `A first note, from the click to the pin · ${demoLength()}`);
      assert.equal(DEMO_SECONDS, 18);
      assert.equal(demoLength(18), '0:18');
      assert.equal(demoLength(75), '1:15');
    });

    it('ships its files, under 1.5 MB together', () => {
      const publicDir = new URL('../public', import.meta.url);
      const sizes = Object.values(DEMO_FILES).map(
        (file) => statSync(fileURLToPath(new URL(`.${file}`, `${publicDir.href}/`))).size,
      );
      const total = sizes.reduce((sum, size) => sum + size, 0);
      assert.ok(total < 1.5 * 1024 * 1024, `the video weighs ${total} bytes`);
      assert.equal(new Set(DEMO_FRAMES.map((frame) => frame.name)).size, DEMO_FRAMES.length);
    });
  });

  it('is in French for a French reviewer', () => {
    setLanguage('fr');
    const screen = welcomeScreen(page(), { openPopup: async () => {} });
    assert.equal(screen.querySelector('h1')?.textContent, 'Fruitback est installé');
    assert.equal(screen.querySelector('button')?.textContent, 'Ouvrir Fruitback');
  });
});
