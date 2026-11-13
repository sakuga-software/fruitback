import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import {
  connecting,
  loading,
  keysOfShortcut,
  notAWebPage,
  problem,
  readDestination,
  shell,
  showSiteFacts,
  signInStop,
  signedOut,
  siteOn,
  turnOnScreen,
} from './popup-view.ts';

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

describe('the shell of the popup (FRU-297)', () => {
  it('has the head of the kit with the button of the account, a body, and no foot when nobody is signed in', () => {
    const document = page();
    let settings = 0;
    const root = shell(document, { onSettings: () => (settings += 1) }, document.createTextNode('Body'));

    assert.deepEqual(
      [...root.children].map((child) => child.className),
      ['kit-head popup-head', 'popup-body'],
    );
    assert.equal(root.querySelector('.kit-brand')?.textContent, 'Fruitback');
    // Nobody signed in: the button shows the gear, and its name says what it opens.
    assert.deepEqual(stops(root), ['button: Account and settings']);
    assert.ok(root.querySelector('.kit-avatar svg.kit-gear') !== null);
    (root.querySelector('.kit-avatar') as HTMLElement).click();
    assert.equal(settings, 1);
  });

  it('shows the initial of who is signed in, and gives the foot of the account', () => {
    const document = page();
    const root = shell(document, {
      onSettings: nothing,
      account: { name: 'Camille Durand', email: 'camille@acme.dev', console: 'https://app.fruitback.test' },
    });

    assert.equal(root.querySelector('.kit-avatar')?.textContent, 'C');
    assert.equal(root.querySelector('.kit-avatar')?.getAttribute('aria-label'), 'Account and settings');
    const foot = root.querySelector('.popup-foot');
    assert.equal(foot?.querySelector('.who')?.textContent, 'camille@acme.dev');
    const consoleLink = foot?.querySelector('a');
    assert.equal(consoleLink?.textContent, 'Open the console');
    assert.equal(consoleLink?.getAttribute('href'), 'https://app.fruitback.test');
    assert.equal(consoleLink?.getAttribute('rel'), 'noreferrer');
  });

  it('gives no link to a console it does not know, and the name when there is no address', () => {
    const document = page();
    const root = shell(document, { onSettings: nothing, account: { name: 'Camille' } });

    assert.equal(root.querySelector('.popup-foot .who')?.textContent, 'Camille');
    assert.equal(root.querySelector('.popup-foot a'), null);
  });

  it('can leave out the button of the account, and says which screen of the mock-up it holds', () => {
    const root = shell(page(), { onSettings: nothing, accountButton: false, screen: 1 });

    assert.equal(root.querySelector('button'), null);
    assert.ok(root.classList.contains('popup-screen-1'));
  });
});

describe('1 · signed out (FRU-297)', () => {
  it('says what Fruitback is for, offers e-mail, Google and GitHub, and leads a server of its own to the page', () => {
    const document = page();
    const done: string[] = [];
    const root = signedOut(document, {
      canSignIn: true,
      onSignIn: () => done.push('sign in'),
      onSettings: () => done.push('settings'),
    });

    assert.equal(root.querySelector('h1')?.textContent, 'Comment on any website, right on the page');
    assert.equal(
      root.querySelector('.lead')?.textContent,
      'Sign in once. Fruitback then works on every site your team reviews.',
    );
    assert.deepEqual(
      [...root.querySelectorAll('.invited span')].map((line) => line.textContent),
      ['Invited by a client or a team?', 'Use the email the invitation was sent to.'],
    );
    // The order of the mock-up: no button of the account, the three ways in, then the foot.
    assert.deepEqual(stops(root), [
      'button: Sign in with email',
      'button: Google',
      'button: GitHub',
      'button: Use your own Fruitback server',
    ]);
    assert.ok(root.classList.contains('popup-screen-1'));
    // No word of the mechanics of before.
    assert.doesNotMatch(root.textContent ?? '', /\b(worker|rule|mode|client id|pair)/i);

    // The three ways in all start the sign-in of the console: it offers its own methods.
    for (const button of root.querySelectorAll<HTMLElement>('.methods button')) button.click();
    (root.querySelector('.popup-foot button') as HTMLElement).click();
    assert.deepEqual(done, ['sign in', 'sign in', 'sign in', 'settings']);
  });

  it('draws the mark of its provider in « Google » and « GitHub », in every state of the sign-in (FRU-525)', () => {
    const states = [
      {},
      { ended: true },
      ...(['refused', 'expired', 'unavailable', 'untrusted', 'blocked'] as const).map((stop) => ({
        stop: signInStop(stop),
      })),
    ];
    for (const state of states) {
      const root = signedOut(page(), { canSignIn: true, onSignIn: nothing, onSettings: nothing, ...state });
      const marked = [...root.querySelectorAll('.method-row button')].map((button) => [
        button.textContent,
        button.querySelector('svg.kit-provider-mark[aria-hidden="true"]')?.getAttribute('data-provider'),
      ]);
      assert.deepEqual(
        marked,
        [
          ['Google', 'google'],
          ['GitHub', 'github'],
        ],
        JSON.stringify(state),
      );
    }
  });

  it('leads to the page of the extension alone in a build that names no Fruitback to sign in to', () => {
    const root = signedOut(page(), { canSignIn: false, onSignIn: nothing, onSettings: nothing });

    assert.deepEqual(stops(root), ['button: Use your own Fruitback server']);
    assert.ok(root.querySelector('.kit-primary') !== null);
    assert.equal(root.querySelector('.popup-foot'), null);
  });

  it('says the session ended when it did, and still offers the ways in', () => {
    const root = signedOut(page(), { canSignIn: true, ended: true, onSignIn: nothing, onSettings: nothing });

    assert.equal(root.querySelector('h1')?.textContent, 'Your sign-in ended');
    assert.equal(root.querySelector('.lead')?.textContent, 'Sign in again to see and leave notes here.');
    assert.equal(root.querySelector('.kit-primary')?.textContent, 'Sign in with email');
  });

  it('speaks French', () => {
    setLanguage('fr');
    const root = signedOut(page(), { canSignIn: true, onSignIn: nothing, onSettings: nothing });

    assert.equal(root.querySelector('h1')?.textContent, 'Commentez n’importe quel site, directement sur la page');
    assert.equal(root.querySelector('.kit-primary')?.textContent, 'Se connecter par e-mail');
    assert.equal(root.querySelector('.popup-foot')?.textContent, 'Utiliser votre propre serveur Fruitback');
  });
});

describe('1, while the sign-in waits for the console', () => {
  it('shows the word to check, says it waits once, and can start again', () => {
    const document = page();
    let again = 0;
    const root = connecting(document, { word: 'PLUM 47', onStartAgain: () => (again += 1), onSettings: nothing });

    assert.equal(root.querySelector('h1')?.textContent, 'Check that the tab shows the same word');
    const word = root.querySelector('.word');
    assert.equal(word?.textContent, 'PLUM 47');
    assert.equal(root.querySelector('[role="status"]')?.textContent, 'Waiting for you to connect in the tab…');
    assert.deepEqual(stops(root), ['button: Start again']);
    (root.querySelector('.link-button') as HTMLElement).click();
    assert.equal(again, 1);
  });

  it('says when Fruitback did not answer a claim, and keeps the word', () => {
    const root = connecting(page(), { word: 'PLUM 47', unanswered: true, onStartAgain: nothing, onSettings: nothing });

    assert.equal(root.querySelector('[role="status"]')?.textContent, 'Fruitback did not answer. The popup asks again.');
    assert.equal(root.querySelector('.word')?.textContent, 'PLUM 47');
  });

  it('writes the word as text, whatever Fruitback sent', () => {
    const root = connecting(page(), {
      word: '<img src=x onerror=alert(1)>',
      onStartAgain: nothing,
      onSettings: nothing,
    });

    assert.equal(root.querySelector('img'), null);
    assert.equal(root.querySelector('.word')?.textContent, '<img src=x onerror=alert(1)>');
  });
});

describe('1, after a sign-in that did not finish (P2 of FRU-598)', () => {
  for (const [stopped, title, sentence] of [
    [
      'refused',
      'The sign-in did not finish',
      'Someone pressed “Not now” in the console. Nothing changed in your sites.',
    ],
    ['expired', 'The sign-in did not finish', 'The console did not approve it within 15 minutes.'],
    ['unavailable', 'Fruitback could not be reached', 'Check the connection, then try again.'],
    [
      'untrusted',
      'The sign-in did not start',
      'Fruitback named a console that is not its own. Tell the person who runs your Fruitback.',
    ],
    [
      'blocked',
      'The sign-in did not start',
      'The browser did not give the extension access to Fruitback. Allow it when the browser asks.',
    ],
  ] as const) {
    it(`makes the problem the title when it was ${stopped}, then « Sign in again », Google and GitHub`, () => {
      let again = 0;
      const root = signedOut(page(), {
        canSignIn: true,
        stop: signInStop(stopped),
        onSignIn: () => (again += 1),
        onSettings: nothing,
      });

      // Said at once: the screen changed under the person, and this is why.
      const said = root.querySelector('[role="alert"]');
      assert.equal(said?.querySelector('h1')?.textContent, title);
      assert.equal(said?.querySelector('.lead')?.textContent, sentence);
      assert.equal(root.querySelectorAll('h1').length, 1);
      assert.equal(root.querySelector('.kit-alert'), null, 'no second alert under the title');
      assert.doesNotMatch(root.textContent ?? '', /Comment on any website|Invited by/);
      assert.equal(said?.nextElementSibling?.className, 'methods');
      assert.deepEqual(stops(root), [
        'button: Sign in again',
        'button: Google',
        'button: GitHub',
        'button: Use your own Fruitback server',
      ]);
      (root.querySelector('.kit-primary') as HTMLElement).click();
      assert.equal(again, 1);
    });
  }

  it('speaks French', () => {
    setLanguage('fr');
    const root = signedOut(page(), {
      canSignIn: true,
      stop: signInStop('refused'),
      onSignIn: nothing,
      onSettings: nothing,
    });

    assert.equal(root.querySelector('h1')?.textContent, 'La connexion n’a pas abouti');
    assert.equal(
      root.querySelector('.lead')?.textContent,
      'Quelqu’un a appuyé sur «\u202FPas maintenant\u202F» dans la console. Rien n’a changé dans vos sites.',
    );
    assert.equal(root.querySelector('.kit-primary')?.textContent, 'Se reconnecter');
  });
});

describe('4 · a problem, with its fix (FRU-297)', () => {
  it('says the access to a site was removed, and offers to give it back or to turn the site off', () => {
    const done: string[] = [];
    const root = problem(page(), {
      site: ORIGIN,
      title: "Fruitback can't open this page",
      text: 'Access to staging.acme.dev was removed in your browser settings. Your notes are safe.',
      primary: { label: 'Allow access again', onClick: () => done.push('allow') },
      secondary: { label: 'Turn off for this site', onClick: () => done.push('off') },
      account: { name: 'Mathieu' },
      onSettings: nothing,
    });

    assert.ok(root.classList.contains('popup-screen-4'));
    assert.equal(root.querySelector('.kit-site-host')?.textContent, 'staging.acme.dev');
    const state = root.querySelector('.kit-site-state') as HTMLElement;
    assert.equal(state.textContent, 'Paused');
    assert.equal(state.dataset.paused, 'true');
    assert.equal(root.querySelector('[role="alert"] .kit-alert-title')?.textContent, "Fruitback can't open this page");
    assert.deepEqual(stops(root), [
      'button: Account and settings',
      'button: Allow access again',
      'button: Turn off for this site',
    ]);
    (root.querySelector('.kit-primary') as HTMLElement).click();
    (root.querySelector('.kit-secondary') as HTMLElement).click();
    assert.deepEqual(done, ['allow', 'off']);
  });

  it('has no tile and no button when the problem is about no site and has no fix', () => {
    const root = problem(page(), { title: "Fruitback can't reach api.fruitback.com", onSettings: nothing });

    assert.equal(root.querySelector('.kit-tile'), null);
    assert.deepEqual(stops(root), ['button: Account and settings']);
  });

  it('leads to the guide under its actions when it is given one (FRU-528)', () => {
    const root = problem(page(), {
      onSettings: nothing,
      title: "Fruitback can't reach api.fruitback.com",
      primary: { label: 'Try again', onClick: nothing },
      help: { label: 'What to check when Fruitback does not answer', href: 'https://fruitback.com/reviewing.html#a' },
    });
    assert.deepEqual(stops(root), [
      'button: Account and settings',
      'button: Try again',
      'link: What to check when Fruitback does not answer',
    ]);
    assert.equal(root.querySelector('.popup-body > .kit-help a')?.getAttribute('target'), '_blank');
    assert.equal(problem(page(), { onSettings: nothing, title: 'x' }).querySelector('.kit-help'), null);
  });

  it('says why nothing runs on a page of the browser, and what to do, and leads to the guide (FRU-526)', () => {
    const root = notAWebPage(page(), { onSettings: nothing });

    assert.ok(root.classList.contains('popup-screen-4'));
    assert.equal(root.querySelector('h1')?.textContent, "Fruitback can't run on this page");
    assert.equal(
      root.querySelector('.lead')?.textContent,
      'This is a page of the browser, like a new tab, the settings, the extension store or a PDF. No extension can draw on it.',
    );
    assert.deepEqual(
      [...root.querySelectorAll('.not-web-steps li')].map((step) => step.textContent),
      [
        'Open a site your team reviews.',
        'There, click the Fruitback icon.',
        'Nothing changed for your sites and your notes.',
      ],
    );
    assert.deepEqual(stops(root), ['button: Account and settings', 'link: How Fruitback works']);
  });

  it('names the keys the person set, each in its kbd, and no key written in the code (FRU-526)', () => {
    const root = notAWebPage(page(), { onSettings: nothing, shortcut: ['Ctrl', 'Shift', 'Y'] });
    const step = root.querySelectorAll('.not-web-steps li')[1];

    assert.equal(step?.textContent, 'There, click the Fruitback icon, or press Ctrl Shift Y.');
    assert.deepEqual(
      [...(step?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent),
      ['Ctrl', 'Shift', 'Y'],
    );
    assert.doesNotMatch(root.textContent ?? '', /⌥|⇧|Alt/);
  });

  it('says it in French for a French reviewer (FRU-526)', () => {
    setLanguage('fr');
    const root = notAWebPage(page(), { onSettings: nothing, shortcut: ['⌥', '⇧', 'F'] });

    assert.equal(root.querySelector('h1')?.textContent, 'Fruitback ne peut pas fonctionner sur cette page');
    assert.equal(
      root.querySelectorAll('.not-web-steps li')[1]?.textContent,
      'Là, cliquez sur l’icône de Fruitback, ou appuyez sur ⌥ ⇧ F.',
    );
  });

  it('says it is loading, once, with nothing to press but the settings', () => {
    const root = loading(page(), { onSettings: nothing });

    assert.equal(root.querySelector('[role="status"]')?.textContent, 'Loading…');
    assert.deepEqual(stops(root), ['button: Account and settings']);
  });
});

describe('2 · a site of a workspace, not on here (FRU-298)', () => {
  const offer = (extra: Partial<Parameters<typeof turnOnScreen>[1]> = {}, calls: string[] = []) =>
    turnOnScreen(page(), {
      origin: 'https://preview.northwind.io',
      workspace: 'Northwind',
      destination: 'Linear · Northwind',
      visibility: 'members',
      onChange: () => calls.push('change'),
      onTurnOn: (workspace) => calls.push(`turn-on:${workspace ?? ''}`),
      onSettings: nothing,
      ...extra,
    });

  it('asks the question of P2, sums up where the notes go and who sees them, and turns on in one click', () => {
    const calls: string[] = [];
    const screen = offer({}, calls);

    assert.ok(screen.classList.contains('popup-screen-2'));
    assert.equal(screen.querySelector('.kit-site-host')?.textContent, 'preview.northwind.io');
    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'In Northwind · not on in this browser');
    assert.equal(screen.querySelector('.kit-tile')?.getAttribute('data-on'), 'false');
    assert.equal(screen.querySelector('h1')?.textContent, 'Leave notes on this site?');
    // The summary, in the words of the console: no list, and one way to change it.
    assert.deepEqual(
      [...screen.querySelectorAll('.turn-on-summary .kit-dl-entry')].map((entry) => [
        entry.querySelector('dt')?.textContent,
        entry.querySelector('dd')?.textContent,
      ]),
      [
        ['Notes go to', 'Linear · Northwind'],
        ['Seen by', 'Members of Northwind'],
      ],
    );
    assert.equal(screen.querySelector('select'), null);
    assert.equal(
      screen.querySelector('.action-block .note')?.textContent,
      'Your browser asks once for access to this site.',
    );
    assert.deepEqual(stops(screen), [
      'button: Account and settings',
      'button: Change before turning on',
      'button: Turn on',
    ]);

    screen.querySelector<HTMLButtonElement>('.action-block button')?.click();
    screen.querySelector<HTMLButtonElement>('.turn-on-summary .kit-text')?.click();
    assert.deepEqual(calls, ['turn-on:', 'change']);
  });

  it('leaves « Notes go to » out when the worker did not say, the link out with no console, and says everyone', () => {
    const screen = offer({ visibility: 'everyone' });
    const bare = turnOnScreen(page(), {
      origin: 'https://preview.northwind.io',
      workspace: 'Northwind',
      visibility: 'everyone',
      onTurnOn: nothing,
      onSettings: nothing,
    });

    assert.equal(
      screen.querySelectorAll('.turn-on-summary .kit-dl-entry')[1]?.querySelector('dd')?.textContent,
      'Everyone who visits',
    );
    assert.deepEqual(
      [...bare.querySelectorAll('.kit-dl-entry dt')].map((term) => term.textContent),
      ['Seen by'],
    );
    assert.equal(bare.querySelector('.turn-on-summary button'), null);
  });

  it('speaks French', () => {
    setLanguage('fr');
    const screen = offer();

    assert.equal(screen.querySelector('h1')?.textContent, 'Laisser des notes sur ce site\u202F?');
    assert.equal(screen.querySelector('.action-block button')?.textContent, 'Activer');
    assert.equal(screen.querySelector('dt')?.textContent, 'Les notes vont vers');
    assert.equal(screen.querySelectorAll('dd')[1]?.textContent, 'Les membres de Northwind');
    assert.equal(screen.querySelector('.turn-on-summary .kit-text')?.textContent, 'Modifier avant d’activer');
  });
});

describe('2 · a site of no workspace (FRU-298, FRU-255)', () => {
  const fresh = (
    workspaces: { id: string; name: string }[],
    calls: string[] = [],
    extra: Partial<Parameters<typeof turnOnScreen>[1]> = {},
  ) =>
    turnOnScreen(page(), {
      origin: 'https://preview.northwind.io',
      visibility: 'members',
      workspaces,
      onTurnOn: (workspace) => calls.push(`turn-on:${workspace ?? ''}`),
      onSettings: nothing,
      ...extra,
    });

  it('with one workspace: no list, and « Turn on » adds the site to it', () => {
    const calls: string[] = [];
    const screen = fresh([{ id: 'w1', name: 'Northwind' }], calls);

    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'Not in your sites yet');
    assert.equal(screen.querySelector('select'), null);
    screen.querySelector<HTMLButtonElement>('.action-block button')?.click();
    assert.deepEqual(calls, ['turn-on:w1']);
  });

  it('with two: a line « Workspace » with its list, and « Turn on » follows the choice', () => {
    const calls: string[] = [];
    const screen = fresh(
      [
        { id: 'w1', name: 'Northwind' },
        { id: 'w2', name: 'Acme' },
      ],
      calls,
    );
    const select = screen.querySelector('select');
    if (select === null) throw new Error('no list');

    assert.equal(screen.querySelector('.kit-dl-entry dt')?.textContent, 'Workspace');
    assert.equal(select.getAttribute('aria-label'), 'Workspace');
    const seen = () => screen.querySelectorAll('.turn-on-summary dd')[0]?.textContent;
    assert.equal(seen(), 'Members of Northwind');
    select.value = 'w2';
    select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
    // The summary names the workspace chosen.
    assert.equal(seen(), 'Members of Acme');
    screen.querySelector<HTMLButtonElement>('.action-block button')?.click();
    assert.deepEqual(calls, ['turn-on:w2']);
  });

  it('with none: a message for an admin of the one workspace, to copy, and the guide that says who can (FRU-528)', async () => {
    const copied: string[] = [];
    let answer = true;
    const screen = fresh([], [], {
      origin: 'https://staging.acme.dev',
      adminOf: 'Acme',
      copy: async (text) => {
        copied.push(text);

        return answer;
      },
    });
    // Attached, so that it can take the focus.
    screen.ownerDocument.body.append(screen);
    const message =
      'Could you add https://staging.acme.dev to the Acme workspace of Fruitback? I would like to leave notes on it.';

    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'Not in your sites yet');
    assert.equal(screen.querySelector('h1')?.textContent, 'An admin of Acme adds sites');
    const text = screen.querySelector('textarea');
    assert.ok(text?.readOnly);
    assert.equal(text?.value, message);
    // Its name is the label around it (axe `label`).
    assert.equal(text?.closest('label')?.firstChild?.textContent, 'Message to send them');
    assert.deepEqual(stops(screen), [
      'button: Account and settings',
      'button: Copy the message',
      'link: Who can add a site to a workspace?',
    ]);
    assert.equal(
      screen.querySelector<HTMLAnchorElement>('.kit-help a')?.href,
      'https://fruitback.com/reviewing.html#who-can-add-a-site-to-a-workspace',
    );

    const said = screen.querySelector('[role="status"]');
    screen.querySelector<HTMLButtonElement>('.action')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(copied, [message]);
    assert.equal(said?.textContent, 'Copied');

    // The browser refuses: no « Copied », and the text is chosen for the keys of the person.
    answer = false;
    screen.querySelector<HTMLButtonElement>('.action')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(said?.textContent, '');
    assert.ok(screen.ownerDocument.activeElement === text);
  });

  it('with none, and an account in several workspaces or none: names no workspace', () => {
    const screen = fresh([], [], { origin: 'https://staging.acme.dev', copy: async () => true });

    assert.equal(screen.querySelector('h1')?.textContent, 'An admin of your workspace adds sites');
    assert.equal(
      screen.querySelector('textarea')?.value,
      'Could you add https://staging.acme.dev to our workspace of Fruitback? I would like to leave notes on it.',
    );
  });

  it('with none, speaks French', () => {
    setLanguage('fr');
    const screen = fresh([], [], { origin: 'https://staging.acme.dev', adminOf: 'Acme', copy: async () => true });

    assert.equal(screen.querySelector('h1')?.textContent, 'Un admin de Acme ajoute les sites');
    assert.equal(screen.querySelector('.action')?.textContent, 'Copier le message');
  });
});

describe('2 · a site on http, which the popup does not add (FRU-537)', () => {
  it('says to add it from the console, and has nothing to press but the account', () => {
    const screen = turnOnScreen(page(), {
      origin: 'http://staging.acme.dev',
      visibility: 'members',
      workspaces: [],
      unaddable: 'This site is on http. Add it to a workspace from the console, then turn it on here.',
      onTurnOn: nothing,
      onSettings: nothing,
    });

    assert.equal(screen.querySelector('h1')?.textContent, 'staging.acme.dev');
    assert.equal(
      screen.querySelector('.lead')?.textContent,
      'This site is on http. Add it to a workspace from the console, then turn it on here.',
    );
    assert.doesNotMatch(screen.textContent ?? '', /admin/);
    assert.deepEqual(stops(screen), ['button: Account and settings']);
  });
});

describe('2 · who sees the notes and where they go, chosen at the turn on (FRU-453)', () => {
  const LINEAR = { id: 'lin', kind: 'linear' as const, label: 'Linear · Acme' };
  const HOOK = { id: 'hook', kind: 'rest' as const, label: 'REST API · Hook' };
  const change = (select: HTMLSelectElement, value: string): void => {
    select.value = value;
    select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** « Change before turning on »: the summary gives its place to the lists. */
  const openLists = (screen: HTMLElement): void => {
    const link = screen.querySelector<HTMLButtonElement>('.turn-on-summary .kit-text');
    if (link === null) throw new Error('no « Change before turning on »');
    link.click();
  };

  it('shows the lists in place of the summary on « Change before turning on », in the order a keyboard meets them', async () => {
    const calls: string[] = [];
    const screen = turnOnScreen(page(), {
      origin: 'https://preview.northwind.io',
      workspace: 'Northwind',
      destination: 'Linear · Acme · Design',
      visibility: 'members',
      onChange: () => calls.push('change'),
      choices: {
        sources: { w1: [LINEAR, HOOK] },
        workspace: 'w1',
        place: { connector: 'lin', teamId: 'design' },
        loadOffer: async () => ({
          kind: 'linear',
          teams: [{ id: 'design', name: 'Design', key: 'DES', projects: [] }],
        }),
        onVisibility: async (visibility) => {
          calls.push(`visibility:${visibility}`);

          return true;
        },
        onPlace: async (place) => {
          calls.push(`place:${JSON.stringify(place)}`);

          return true;
        },
      },
      onTurnOn: () => calls.push('turn-on'),
      onSettings: nothing,
    });
    screen.ownerDocument.body.append(screen);
    await settle();
    assert.equal(screen.querySelector('select'), null, 'the lists wait for the link');
    openLists(screen);
    assert.equal(screen.querySelector('.turn-on-summary'), null);
    // The focus goes to the first list: the link it was on is gone.
    assert.ok(screen.ownerDocument.activeElement === screen.querySelector('select'));

    assert.deepEqual(
      [...screen.querySelectorAll('select')]
        .filter((each) => !(each.closest('.kit-dl-entry') as HTMLElement).hidden)
        .map((each) => each.getAttribute('aria-label')),
      ['Notes go to', 'Team', 'Who sees the notes'],
    );
    assert.equal(screen.querySelector('.kit-dl-action'), null, 'no « Change »');
    assert.deepEqual(calls, [], 'a role that may change it stays in the popup');
    const visibility = screen.querySelector<HTMLSelectElement>('select[name="visibility"]');
    if (visibility === null) throw new Error('no list');
    assert.deepEqual(
      [...visibility.options].map((option) => [option.value, option.textContent, option.selected]),
      [
        ['members', 'Members of Northwind', true],
        ['everyone', 'Everyone who visits', false],
      ],
    );
    change(visibility, 'everyone');
    await settle();
    change(screen.querySelector('select[name="provider"]') as HTMLSelectElement, 'hook');
    await settle();
    assert.deepEqual(calls, ['visibility:everyone', 'place:{"connector":"hook"}']);
  });

  it('puts the visibility back when the worker refuses the change', async () => {
    const screen = turnOnScreen(page(), {
      origin: 'https://preview.northwind.io',
      workspace: 'Northwind',
      visibility: 'members',
      choices: {
        sources: { w1: [] },
        workspace: 'w1',
        place: null,
        loadOffer: async () => undefined,
        onVisibility: async () => false,
        onPlace: async () => false,
      },
      onTurnOn: nothing,
      onSettings: nothing,
    });
    openLists(screen);
    const visibility = screen.querySelector<HTMLSelectElement>('select[name="visibility"]');
    if (visibility === null) throw new Error('no list');

    change(visibility, 'everyone');
    assert.equal(visibility.disabled, true);
    await settle();
    assert.equal(visibility.value, 'members');
    assert.equal(visibility.disabled, false);
  });

  it('for a site of no workspace: the sources follow the workspace chosen, back to « Fruitback »', async () => {
    const calls: string[] = [];
    const screen = turnOnScreen(page(), {
      origin: 'https://preview.northwind.io',
      visibility: 'members',
      workspaces: [
        { id: 'w1', name: 'Northwind' },
        { id: 'w2', name: 'Acme' },
      ],
      choices: {
        sources: { w1: [HOOK], w2: [LINEAR] },
        place: null,
        loadOffer: async (workspace, connector) => {
          calls.push(`load:${workspace}:${connector}`);

          return { kind: 'linear', teams: [{ id: 'design', name: 'Design', key: 'DES', projects: [] }] };
        },
        onVisibility: async () => true,
        onPlace: async (place) => {
          calls.push(`place:${JSON.stringify(place)}`);

          return true;
        },
      },
      onTurnOn: (workspace) => calls.push(`turn-on:${workspace ?? ''}`),
      onSettings: nothing,
    });
    openLists(screen);
    const workspace = screen.querySelector<HTMLSelectElement>('select[name="workspace"]');
    const provider = screen.querySelector<HTMLSelectElement>('select[name="provider"]');
    const members = () =>
      screen.querySelector<HTMLSelectElement>('select[name="visibility"] option[value="members"]')?.textContent;
    if (workspace === null || provider === null) throw new Error('no lists');
    assert.equal(members(), 'Members of Northwind');

    assert.deepEqual(
      [...provider.options].map((option) => option.textContent),
      ['Fruitback (no tracker)', 'REST API · Hook'],
    );
    change(provider, 'hook');
    await settle();
    change(workspace, 'w2');
    assert.deepEqual(
      [...provider.options].map((option) => option.textContent),
      ['Fruitback (no tracker)', 'Linear · Acme'],
    );
    assert.equal(provider.value, '');
    assert.equal(members(), 'Members of Acme');
    await settle();
    change(provider, 'lin');
    await settle();
    change(screen.querySelector('select[name="team"]') as HTMLSelectElement, 'design');
    await settle();
    screen.querySelector<HTMLButtonElement>('.action-block button')?.click();
    assert.deepEqual(calls, [
      'place:{"connector":"hook"}',
      'place:null',
      'load:w2:lin',
      'place:{"connector":"lin","teamId":"design"}',
      'turn-on:w2',
    ]);
  });
});

describe('3 · a site on (FRU-298, FRU-599)', () => {
  const on = (extra: Partial<Parameters<typeof siteOn>[1]> = {}, calls: string[] = []) =>
    siteOn(page(), {
      origin: ORIGIN,
      workspace: 'Acme',
      on: true,
      shortcut: ['Alt', 'Shift', 'F'],
      onToggle: (value) => calls.push(`toggle:${value}`),
      onLeaveFeedback: () => calls.push('leave'),
      onOpenPanel: () => calls.push('panel'),
      onSettings: () => calls.push('settings'),
      ...extra,
    });
  const menuEntries = (screen: HTMLElement): string[] =>
    [...screen.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .filter((entry) => !entry.hidden)
      .map((entry) => entry.querySelector('.kit-menu-label')?.textContent ?? '');
  const press = (target: Element, key: string): void => {
    const view = target.ownerDocument.defaultView as unknown as typeof globalThis;
    target.dispatchEvent(new view.KeyboardEvent('keydown', { key, bubbles: true }));
  };

  it('takes the foot it is given in place of the one of an account (FRU-319)', () => {
    const document = page();
    const foot = document.createElement('div');
    foot.className = 'popup-foot';
    foot.textContent = 'Paired as Camille Durand';
    const screen = on({ account: { name: 'Camille Durand', email: 'camille@acme.dev' }, foot });

    assert.deepEqual(
      [...screen.querySelectorAll('.popup-foot')].map((each) => each.textContent),
      ['Paired as Camille Durand'],
    );
    // The control: with no foot given, the foot of the account.
    assert.equal(
      on({ account: { name: 'Camille Durand', email: 'camille@acme.dev' } }).querySelector('.popup-foot .who')
        ?.textContent,
      'camille@acme.dev',
    );
  });

  it('is a launcher: the site, its state and « ⋯ », where the notes go, « Leave a note », then the side panel', () => {
    const calls: string[] = [];
    const screen = on({ visibility: { shown: true, onChange: nothing } }, calls);
    showSiteFacts(
      screen,
      { workspace: 'Acme', on: true, onOpenPanel: nothing },
      { destination: 'Linear · Acme web', toCheck: 2, open: 7 },
    );
    const body = screen.querySelector('.popup-body') as HTMLElement;

    assert.ok(screen.classList.contains('popup-screen-3'));
    assert.equal(screen.querySelector('h1')?.textContent, 'staging.acme.dev');
    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'On · Acme');
    // One state, no switch: the mark says the site is on.
    assert.equal(screen.querySelectorAll('[role="switch"]').length, 0);
    assert.equal(screen.querySelector('.site-on-mark')?.getAttribute('aria-label'), 'Fruitback is on for this site');
    assert.deepEqual(
      [...body.children].map((child) => child.className),
      ['site-row', 'site-destination', 'leave-block', 'panel-row'],
    );
    assert.equal(screen.querySelector('.kit-primary')?.getAttribute('data-size'), 'tall');
    assert.equal(screen.querySelector('.shortcut-line')?.textContent, 'or press Alt Shift F on the page');
    assert.equal(screen.querySelector('.panel-row-title')?.textContent, 'Show all notes in a sidebar');
    assert.equal(screen.querySelector('.panel-counts')?.textContent, '7 open notes · 2 to check');
    // The entries of the menu are no stops of Tab: the arrows walk them once it is open.
    assert.deepEqual(
      stops(screen).filter(
        (_, index) =>
          screen.querySelectorAll('button, a[href], input, select')[index]?.getAttribute('role') !== 'menuitem',
      ),
      [
        'button: Account and settings',
        'button: More for this site',
        'button: Leave a note',
        'button: Show all notes in a sidebar7 open notes · 2 to check',
      ],
    );

    screen.querySelector<HTMLButtonElement>('.kit-primary')?.click();
    screen.querySelector<HTMLButtonElement>('.panel-row')?.click();
    assert.deepEqual(calls, ['leave', 'panel']);
  });

  it('has a menu « ⋯ » that the keyboard opens, walks and closes, and that says what each entry keeps', () => {
    const calls: string[] = [];
    const screen = on({ visibility: { shown: true, onChange: (shown) => calls.push(`shown:${shown}`) } }, calls);
    screen.ownerDocument.body.append(screen);
    const trigger = screen.querySelector<HTMLButtonElement>('.kit-menu-trigger') as HTMLButtonElement;
    const list = screen.querySelector<HTMLElement>('[role="menu"]') as HTMLElement;

    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(list.hidden, true);
    // « Change where notes go » waits for the worker.
    assert.deepEqual(menuEntries(screen), [
      'Hide the widget on this site',
      'Stop reviewing this site',
      'All settings for this site',
    ]);

    trigger.click();
    assert.equal(list.hidden, false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const doc = screen.ownerDocument;
    assert.ok(doc.activeElement === list.querySelector('[data-menu-item="visibility"]'));
    press(list, 'ArrowDown');
    assert.ok(doc.activeElement === list.querySelector('[data-menu-item="stop"]'));
    press(list, 'End');
    assert.ok(doc.activeElement === list.querySelector('[data-menu-item="settings"]'));
    press(list, 'ArrowDown');
    assert.ok(doc.activeElement === list.querySelector('[data-menu-item="visibility"]'));
    press(list, 'Escape');
    assert.equal(list.hidden, true);
    assert.ok(doc.activeElement === trigger);

    trigger.click();
    list.querySelector<HTMLButtonElement>('[data-menu-item="visibility"]')?.click();
    assert.equal(list.hidden, true);
    trigger.click();
    list.querySelector<HTMLButtonElement>('[data-menu-item="stop"]')?.click();
    trigger.click();
    list.querySelector<HTMLButtonElement>('[data-menu-item="settings"]')?.click();
    assert.deepEqual(calls, ['shown:false', 'toggle:false', 'settings']);
    // An entry chosen gives the focus back to « ⋯ » (review of #828).
    assert.ok(doc.activeElement === trigger);
  });

  it('hidden: says so, turns « Leave a note » and the side panel off, and the menu shows the widget again', () => {
    const calls: string[] = [];
    const screen = on({ visibility: { shown: false, onChange: (shown) => calls.push(`shown:${shown}`) } });
    assert.equal(screen.querySelector('.hidden-line')?.textContent, 'Fruitback is hidden on this page.');
    assert.equal(screen.querySelector<HTMLButtonElement>('.kit-primary')?.disabled, true);
    assert.equal(screen.querySelector<HTMLButtonElement>('.panel-row')?.disabled, true);
    assert.equal(screen.querySelector('.shortcut-line'), null);
    assert.equal(screen.querySelectorAll('.visibility-button').length, 0);
    const entry = screen.querySelector<HTMLButtonElement>('[data-menu-item="visibility"]');
    assert.equal(entry?.querySelector('.kit-menu-label')?.textContent, 'Show the widget on this site');
    entry?.click();
    assert.deepEqual(calls, ['shown:true']);
  });

  it('has no line of keys when the browser has no shortcut', () => {
    const screen = on({ shortcut: [] });

    assert.equal(screen.querySelector('.shortcut-line'), null);
  });

  it('off: says so, and « Turn on » in place of the rest', () => {
    const calls: string[] = [];
    const screen = on({ on: false }, calls);

    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'Off · Acme');
    assert.equal(screen.querySelector('.site-on-mark'), null);
    assert.equal(screen.querySelector('.panel-row'), null);
    assert.equal(screen.querySelector('.site-destination'), null);
    assert.deepEqual(menuEntries(screen), ['All settings for this site']);
    const turnOn = screen.querySelector<HTMLButtonElement>('.kit-primary');
    assert.equal(turnOn?.textContent, 'Turn on');
    turnOn?.click();
    assert.deepEqual(calls, ['toggle:true']);
  });

  it('says the open notes and the fixes to check under the side panel: none at zero, one in the singular, 99+ above 99', () => {
    const counts = (facts: { toCheck?: number; open?: number }): string | null | undefined => {
      const screen = on();
      showSiteFacts(screen, { workspace: 'Acme', on: true, onOpenPanel: nothing }, facts);

      return screen.querySelector('.panel-counts')?.textContent;
    };
    assert.equal(counts({ toCheck: 0, open: 0 }), 'No open note');
    assert.equal(counts({ toCheck: 1, open: 1 }), '1 open note · 1 to check');
    assert.equal(counts({ open: 140, toCheck: 3 }), '99+ open notes · 3 to check');
    // Before the worker says: nothing, rather than zeros.
    assert.equal(counts({}), '');
  });

  it('speaks French, with the plural rules of French', () => {
    setLanguage('fr');
    const screen = on({ visibility: { shown: true, onChange: nothing } });
    showSiteFacts(screen, { workspace: 'Acme', on: true, onOpenPanel: nothing }, { toCheck: 2, open: 1 });

    assert.equal(screen.querySelector('.kit-primary')?.textContent, 'Laisser une note');
    assert.equal(screen.querySelector('.shortcut-line')?.textContent, 'ou appuyez sur Alt Shift F sur la page');
    assert.equal(screen.querySelector('.panel-row-title')?.textContent, 'Voir toutes les notes dans un panneau');
    assert.equal(screen.querySelector('.panel-counts')?.textContent, '1 note ouverte · 2 à vérifier');
    assert.deepEqual(menuEntries(screen), [
      'Masquer le widget sur ce site',
      'Arrêter la revue de ce site',
      'Tous les réglages de ce site',
    ]);
  });
});

describe('the keys of a shortcut (FRU-298)', () => {
  it('splits « Alt+Shift+F », and the signs of Chrome on macOS one by one', () => {
    assert.deepEqual(keysOfShortcut('Alt+Shift+F'), ['Alt', 'Shift', 'F']);
    assert.deepEqual(keysOfShortcut('⌥⇧F'), ['⌥', '⇧', 'F']);
  });
});

describe('where the notes of a site that is on go (FRU-530)', () => {
  const SITE = 'https://staging.acme.dev';
  const LINEAR = { id: 'lin', kind: 'linear' as const, label: 'Linear · Acme' };
  const HOOK = { id: 'hook', kind: 'rest' as const, label: 'REST API · Hook' };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  const pick = (select: HTMLSelectElement, value: string): void => {
    select.value = value;
    select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
  };
  const on = () =>
    siteOn(page(), {
      origin: SITE,
      workspace: 'Acme',
      on: true,
      visibility: { shown: true, onChange: nothing },
      onToggle: nothing,
      onLeaveFeedback: nothing,
      onOpenPanel: nothing,
      onSettings: nothing,
    });
  const facts = { workspace: 'Acme', on: true, onOpenPanel: nothing };

  it('reads the provider and the place of the label the worker writes', () => {
    assert.deepEqual(readDestination('Linear · Northwind'), { kind: 'linear', provider: 'Linear', place: 'Northwind' });
    assert.deepEqual(readDestination('GitHub · acme/web'), { kind: 'github', provider: 'GitHub', place: 'acme/web' });
    assert.deepEqual(readDestination('REST API · Hook'), { kind: 'rest', provider: 'REST API', place: 'Hook' });
    assert.deepEqual(readDestination('Fruitback'), { kind: 'fruitback', place: 'Fruitback' });
    // A label of no known provider is said as it is, with no mark: a guess would be a wrong mark.
    assert.deepEqual(readDestination('Jira · Web'), { place: 'Jira · Web' });
  });

  // FRU-554: the kind the worker names decides the mark, whatever the label says.
  it('takes the provider from the kind the worker names, and the place from the label', () => {
    // A label in another form: the mark stays.
    assert.deepEqual(readDestination('Northwind', 'linear'), {
      kind: 'linear',
      provider: 'Linear',
      place: 'Northwind',
    });
    assert.deepEqual(readDestination('Linear · Northwind', 'linear'), {
      kind: 'linear',
      provider: 'Linear',
      place: 'Northwind',
    });
    // A REST connector whose place reads « Linear · … » is a REST API, not a Linear.
    assert.deepEqual(readDestination('Linear · Northwind', 'rest'), {
      kind: 'rest',
      provider: 'REST API',
      place: 'Linear · Northwind',
    });
    assert.deepEqual(readDestination('Store', 'fruitback'), { kind: 'fruitback', place: 'Store' });
  });

  // FRU-633: the tracker refuses the connection. An owner or an admin opens the connector in the console.
  it('says that the notes do not reach a tracker that refuses the connection, and who reconnects it', () => {
    const screen = on();
    let opened = 0;
    showSiteFacts(screen, facts, {
      destination: 'Acme web',
      destinationKind: 'linear',
      refused: { reconnect: () => (opened += 1) },
    });
    const line = screen.querySelector('.site-refused');
    assert.equal(
      line?.querySelector('.site-refused-words')?.textContent,
      'Linear refuses the connection of this workspace, and the notes of this site do not reach it.',
    );
    const reconnect = line?.querySelector<HTMLButtonElement>('button');
    assert.equal(reconnect?.textContent, 'Reconnect in the console');
    reconnect?.click();
    assert.equal(opened, 1);

    // A Linear is reconnected at Linear itself (FRU-633): the button names it.
    showSiteFacts(screen, facts, {
      destination: 'Acme web',
      destinationKind: 'linear',
      refused: { reconnect: () => (opened += 1), direct: true },
    });
    assert.equal(screen.querySelector('.site-refused button')?.textContent, 'Reconnect Linear');

    // A role that may not reconnect it reads who can, and gets no button.
    showSiteFacts(screen, facts, { destination: 'Acme web', destinationKind: 'linear', refused: {} });
    assert.equal(screen.querySelectorAll('.site-refused').length, 1);
    assert.equal(screen.querySelector('.site-refused button'), null);
    assert.equal(
      screen.querySelector('.site-refused-who')?.textContent,
      'An owner or an admin of the workspace can reconnect it in the console.',
    );

    // Facts read again with a connection that works: the line goes.
    showSiteFacts(screen, facts, { destination: 'Acme web', destinationKind: 'linear' });
    assert.equal(screen.querySelector('.site-refused'), null);
  });

  it('draws the mark of the kind the worker names, on a site that is on and on « Turn on »', () => {
    const screen = on();
    showSiteFacts(screen, facts, { destination: 'acme/web', destinationKind: 'github' });
    const line = screen.querySelector('.site-destination');
    assert.equal(line?.querySelector('svg.source-mark')?.getAttribute('data-kind'), 'github');
    assert.equal(line?.querySelector('.destination-place')?.textContent, 'GitHub / acme/web');

    const turnOn = turnOnScreen(page(), {
      origin: SITE,
      workspace: 'Acme',
      destination: 'Hook',
      destinationKind: 'rest',
      visibility: 'members',
      onTurnOn: nothing,
      onSettings: nothing,
    });
    assert.equal(turnOn.querySelector('.destination-entry svg')?.getAttribute('data-kind'), 'rest');
  });

  it('says « On · workspace » under the site, and « Sent to » on a line of its own above « Leave a note » (FRU-599)', () => {
    const screen = on();
    // Before the worker answers: no line yet.
    assert.equal(screen.querySelector('.site-destination')?.childElementCount, 0);
    showSiteFacts(screen, facts, { destination: 'Linear · Northwind', open: 0 });

    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'On · Acme');
    const line = screen.querySelector('.site-destination') as HTMLElement;
    assert.equal(line.querySelector('.destination-label')?.textContent, 'Sent to');
    // The provider in words, then its place: what a screen reader reads too.
    assert.equal(line.querySelector('.destination-place')?.textContent, 'Linear / Northwind');
    assert.equal(line.querySelector('svg.source-mark')?.getAttribute('data-kind'), 'linear');
    assert.equal(line.querySelector('svg.source-mark')?.getAttribute('aria-hidden'), 'true');
    // A role that may not change it: no pencil, and no entry in the menu.
    assert.equal(line.querySelector('button'), null);
    assert.equal(screen.querySelector<HTMLButtonElement>('[data-menu-item="destination"]')?.hidden, true);
    // It sits between the site and « Leave a note ».
    assert.equal(screen.querySelector('.site-row')?.nextElementSibling?.classList.contains('site-destination'), true);
    assert.equal(line.nextElementSibling?.classList.contains('leave-block'), true);
  });

  it('says « Not known » with « Change » when the worker names no place to a role that may set one', () => {
    const screen = on();
    showSiteFacts(screen, facts, {
      change: { sources: [LINEAR], loadOffer: async () => undefined, onPlace: async () => true },
    });
    const line = screen.querySelector('.site-destination');
    assert.equal(line?.querySelector('.destination-place')?.textContent, 'Not known');
    assert.equal(line?.querySelector('svg.source-mark'), null);
    assert.equal(line?.querySelector('button')?.getAttribute('aria-label'), 'Change where notes go');
    // Nothing named and nothing to change: no line.
    const reader = on();
    showSiteFacts(reader, facts, { open: 1 });
    assert.equal(reader.querySelector('.site-destination')?.childElementCount, 0);
  });

  it('draws the drop of Fruitback for a site that keeps its notes', () => {
    const screen = on();
    showSiteFacts(screen, facts, { destination: 'Fruitback' });
    assert.equal(screen.querySelector('.site-destination svg.source-mark')?.getAttribute('data-kind'), 'fruitback');
  });

  it('opens the lists of « Turn on » on « Change », and writes a new place at once', async () => {
    const asked: unknown[] = [];
    const screen = on();
    showSiteFacts(screen, facts, {
      destination: 'Linear · Northwind',
      change: {
        sources: [LINEAR, HOOK],
        place: { connector: 'lin', teamId: 't1' },
        loadOffer: async () => ({ kind: 'linear', teams: [{ id: 't1', name: 'Northwind', key: 'NOR', projects: [] }] }),
        onPlace: async (place) => {
          asked.push(place);

          return true;
        },
      },
    });
    const change = screen.querySelector<HTMLButtonElement>('.site-destination button');
    assert.equal(change?.getAttribute('aria-label'), 'Change where notes go');
    change?.click();
    await settled();

    const provider = screen.querySelector<HTMLSelectElement>('.site-destination select[name="provider"]');
    assert.equal(provider?.value, 'lin');
    assert.equal(screen.querySelector<HTMLSelectElement>('.site-destination select[name="team"]')?.value, 't1');
    // The marks of the providers in the list, as on « Turn on ».
    assert.deepEqual(
      [...(provider?.querySelectorAll('option') ?? [])].map((each) =>
        each.querySelector('svg')?.getAttribute('data-kind'),
      ),
      ['fruitback', 'linear', 'rest'],
    );
    pick(provider as HTMLSelectElement, 'hook');
    await settled();
    assert.deepEqual(asked, [{ connector: 'hook' }]);
  });

  it('opens the lists once from the menu, however many times the worker answered (review of #828)', async () => {
    let loads = 0;
    const screen = on();
    const change = {
      sources: [LINEAR],
      place: { connector: 'lin', teamId: 't1' },
      loadOffer: async () => {
        loads += 1;

        return { kind: 'linear' as const, teams: [{ id: 't1', name: 'Northwind', key: 'NOR', projects: [] }] };
      },
      onPlace: async () => true,
    };
    showSiteFacts(screen, facts, { destination: 'Linear · Northwind', change });
    showSiteFacts(screen, facts, { destination: 'Linear · Northwind', change });
    const entry = screen.querySelector<HTMLButtonElement>('[data-menu-item="destination"]');
    assert.equal(entry?.hidden, false);
    assert.equal(entry?.querySelectorAll('.kit-menu-detail').length, 1);
    entry?.click();
    await settled();
    assert.equal(loads, 1);
    assert.ok(screen.querySelector('.site-destination select[name="provider"]') !== null);
  });

  it('hides « Change where notes go » again when facts read again give no right (review of #828)', async () => {
    let loads = 0;
    const screen = on();
    const change = {
      sources: [LINEAR],
      place: { connector: 'lin', teamId: 't1' },
      loadOffer: async () => {
        loads += 1;

        return undefined;
      },
      onPlace: async () => true,
    };
    showSiteFacts(screen, facts, { destination: 'Linear · Northwind', change });
    showSiteFacts(screen, facts, { destination: 'Linear · Northwind' });
    const entry = screen.querySelector<HTMLButtonElement>('[data-menu-item="destination"]');
    assert.equal(entry?.hidden, true);
    assert.equal(screen.querySelector('.site-destination button'), null);
    screen
      .querySelector('.site-row')
      ?.dispatchEvent(
        new (screen.ownerDocument.defaultView as unknown as typeof globalThis).Event('fruitback-change-destination'),
      );
    await settled();
    assert.equal(loads, 0);
  });

  it('opens « Where notes go » from the pencil and from the menu, and locked for a role that may not (FRU-600)', () => {
    const calls: string[] = [];
    const screen = on();
    showSiteFacts(screen, facts, {
      destination: 'Linear · Northwind',
      change: {
        sources: [LINEAR],
        loadOffer: async () => undefined,
        onPlace: async () => true,
        open: () => calls.push('open'),
      },
    });
    screen.querySelector<HTMLButtonElement>('.site-destination button')?.click();
    screen.querySelector<HTMLButtonElement>('[data-menu-item="destination"]')?.click();
    assert.deepEqual(calls, ['open', 'open']);
    // No lists in place of the line: the screen of its own holds them.
    assert.equal(screen.querySelector('.site-destination select'), null);

    const reader = on();
    showSiteFacts(reader, facts, { destination: 'Linear · Northwind', locked: () => calls.push('locked') });
    const entry = reader.querySelector<HTMLButtonElement>('[data-menu-item="destination"]');
    assert.equal(entry?.hidden, false);
    assert.equal(entry?.querySelector('.kit-menu-label')?.textContent, 'Where notes go');
    assert.equal(reader.querySelector('.site-destination button'), null);
    entry?.click();
    assert.deepEqual(calls, ['open', 'open', 'locked']);
  });

  it('puts the lists back as they were when the worker refuses the change', async () => {
    const screen = on();
    showSiteFacts(screen, facts, {
      destination: 'REST API · Hook',
      change: {
        sources: [LINEAR, HOOK],
        place: { connector: 'hook' },
        loadOffer: async () => undefined,
        onPlace: async () => false,
      },
    });
    screen.querySelector<HTMLButtonElement>('.site-destination button')?.click();
    await settled();
    const provider = screen.querySelector<HTMLSelectElement>(
      '.site-destination select[name="provider"]',
    ) as HTMLSelectElement;
    pick(provider, '');
    await settled();
    await settled();
    assert.equal(screen.querySelector<HTMLSelectElement>('.site-destination select[name="provider"]')?.value, 'hook');
  });

  it('draws the same line, with its mark, on « Turn on » for a role that only reads it', () => {
    const screen = turnOnScreen(page(), {
      origin: SITE,
      workspace: 'Acme',
      destination: 'GitHub · acme/web',
      visibility: 'members',
      onTurnOn: nothing,
      onSettings: nothing,
    });
    const line = screen.querySelector('.destination-entry');
    assert.equal(line?.querySelector('svg')?.getAttribute('data-kind'), 'github');
    assert.equal(line?.querySelector('.destination-place')?.textContent, 'acme/web');
    assert.equal(screen.querySelector('.kit-dl')?.firstElementChild, line);
  });
});
