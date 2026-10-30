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

describe('1, after a sign-in that did not finish', () => {
  for (const [stopped, title, sentence] of [
    ['refused', 'The sign-in did not finish.', 'Someone declined it in the console. Sign in again to retry.'],
    ['expired', 'The sign-in did not finish.', 'The console did not approve it within 15 minutes. Sign in again.'],
    ['unavailable', 'Fruitback could not be reached.', 'Check the connection, then try again.'],
    [
      'untrusted',
      'The sign-in did not start.',
      'Fruitback named a console that is not its own. Tell the person who runs your Fruitback.',
    ],
    [
      'blocked',
      'The sign-in did not start.',
      'The browser did not give the extension access to Fruitback. Sign in again, and allow it when the browser asks.',
    ],
  ] as const) {
    it(`says why in an alert when it was ${stopped}, above the ways to sign in again`, () => {
      let again = 0;
      const root = signedOut(page(), {
        canSignIn: true,
        stop: signInStop(stopped),
        onSignIn: () => (again += 1),
        onSettings: nothing,
      });

      // Said at once: the screen changed under the person, and this is why.
      const alert = root.querySelector('[role="alert"]');
      assert.equal(alert?.querySelector('.kit-alert-title')?.textContent, title);
      assert.equal(alert?.querySelector('.kit-alert-body')?.textContent, sentence);
      // Above the ways in, as the ticket draws it.
      assert.equal(alert?.nextElementSibling?.className, 'methods');
      (root.querySelector('.kit-primary') as HTMLElement).click();
      assert.equal(again, 1);
    });
  }
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

  it('asks the question of the mock-up, says where the notes go and who sees them, and turns on in one click', () => {
    const calls: string[] = [];
    const screen = offer({}, calls);

    assert.ok(screen.classList.contains('popup-screen-2'));
    assert.equal(screen.querySelector('.kit-site-host')?.textContent, 'preview.northwind.io');
    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'In Northwind · not on in this browser');
    assert.equal(screen.querySelector('.kit-tile')?.getAttribute('data-on'), 'false');
    assert.equal(screen.querySelector('h1')?.textContent, 'Turn Fruitback on for this site?');
    assert.deepEqual(
      [...screen.querySelectorAll('.kit-dl-entry')].map((entry) => [
        entry.querySelector('dt')?.textContent,
        entry.querySelector('dd')?.textContent,
        entry.querySelector('button')?.textContent,
      ]),
      [
        ['Notes go to', 'Linear · Northwind', 'Change'],
        ['Who sees the notes', 'Your team and invited guests', 'Change'],
      ],
    );
    assert.equal(
      screen.querySelector('.action-block .note')?.textContent,
      'Your browser will ask to allow this site once.',
    );
    assert.deepEqual(stops(screen), [
      'button: Account and settings',
      'button: Change',
      'button: Change',
      'button: Turn on',
    ]);

    screen.querySelector<HTMLButtonElement>('.action-block button')?.click();
    screen.querySelector<HTMLButtonElement>('.kit-dl button')?.click();
    assert.deepEqual(calls, ['turn-on:', 'change']);
  });

  it('leaves « Notes go to » out when the worker did not say, « Change » out with no console, and says everyone', () => {
    const screen = offer({ visibility: 'everyone' });
    const bare = turnOnScreen(page(), {
      origin: 'https://preview.northwind.io',
      workspace: 'Northwind',
      visibility: 'everyone',
      onTurnOn: nothing,
      onSettings: nothing,
    });

    assert.equal(
      screen.querySelectorAll('.kit-dl-entry')[1]?.querySelector('dd')?.textContent,
      'Everyone who visits the site',
    );
    assert.deepEqual(
      [...bare.querySelectorAll('.kit-dl-entry dt')].map((term) => term.textContent),
      ['Who sees the notes'],
    );
    assert.equal(bare.querySelector('.kit-dl button'), null);
  });

  it('speaks French', () => {
    setLanguage('fr');
    const screen = offer();

    assert.equal(screen.querySelector('h1')?.textContent, 'Activer Fruitback sur ce site\u202F?');
    assert.equal(screen.querySelector('.action-block button')?.textContent, 'Activer');
    assert.equal(screen.querySelector('dt')?.textContent, 'Les notes vont vers');
  });
});

describe('2 · a site of no workspace (FRU-298, FRU-255)', () => {
  const fresh = (workspaces: { id: string; name: string }[], calls: string[] = []) =>
    turnOnScreen(page(), {
      origin: 'https://preview.northwind.io',
      visibility: 'members',
      workspaces,
      onTurnOn: (workspace) => calls.push(`turn-on:${workspace ?? ''}`),
      onSettings: nothing,
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
    select.value = 'w2';
    select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
    screen.querySelector<HTMLButtonElement>('.action-block button')?.click();
    assert.deepEqual(calls, ['turn-on:w2']);
  });

  it('with none: says who can add it, and leads to the guide that says who can (FRU-528)', () => {
    const screen = fresh([]);

    assert.equal(screen.querySelector('.lead')?.textContent, 'Ask an admin of your workspace to add this site.');
    assert.deepEqual(stops(screen), ['button: Account and settings', 'link: Who can add a site to a workspace?']);
    assert.equal(
      screen.querySelector<HTMLAnchorElement>('.kit-help a')?.href,
      'https://fruitback.com/reviewing.html#who-can-add-a-site-to-a-workspace',
    );
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

  it('shows the lists in place of « Change », in the order a keyboard meets them', async () => {
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
    await settle();

    assert.deepEqual(
      [...screen.querySelectorAll('select')]
        .filter((each) => !(each.closest('.kit-dl-entry') as HTMLElement).hidden)
        .map((each) => each.getAttribute('aria-label')),
      ['Notes go to', 'Team', 'Who sees the notes'],
    );
    assert.equal(screen.querySelector('.kit-dl-action'), null, 'no « Change »');
    const visibility = screen.querySelector<HTMLSelectElement>('select[name="visibility"]');
    if (visibility === null) throw new Error('no list');
    assert.deepEqual(
      [...visibility.options].map((option) => [option.value, option.textContent, option.selected]),
      [
        ['members', 'Your team and invited guests', true],
        ['everyone', 'Everyone who visits the site', false],
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
    const workspace = screen.querySelector<HTMLSelectElement>('select[name="workspace"]');
    const provider = screen.querySelector<HTMLSelectElement>('select[name="provider"]');
    if (workspace === null || provider === null) throw new Error('no lists');

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

describe('3 · a site on (FRU-298)', () => {
  const on = (extra: Partial<Parameters<typeof siteOn>[1]> = {}, calls: string[] = []) =>
    siteOn(page(), {
      origin: ORIGIN,
      workspace: 'Acme',
      on: true,
      shortcut: ['Alt', 'Shift', 'F'],
      onToggle: (value) => calls.push(`toggle:${value}`),
      onLeaveFeedback: () => calls.push('leave'),
      onOpenPanel: () => calls.push('panel'),
      onSettings: nothing,
      ...extra,
    });

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

  // FRU-444: the widget hidden on this page, its rule still on.
  it('has « Show Fruitback on this page », and offers nothing of the page while it is hidden', () => {
    const calls: string[] = [];
    const shown = on({ visibility: { shown: true, onChange: (value) => calls.push(`shown:${value}`) } }, calls);
    const named = shown.querySelectorAll('[role="switch"]')[1];

    assert.equal(named?.getAttribute('aria-label'), 'Show Fruitback on this page');
    assert.equal(named?.getAttribute('aria-checked'), 'true');
    assert.equal(shown.querySelector('.visibility-words')?.textContent, 'Show Fruitback on this page');
    assert.ok(stops(shown).includes('button: Leave feedback'));
    (named as HTMLElement).click();
    assert.deepEqual(calls, ['shown:false']);

    const hidden = on({ visibility: { shown: false, onChange: nothing } });
    assert.equal(hidden.querySelectorAll('[role="switch"]')[1]?.getAttribute('aria-checked'), 'false');
    assert.equal(stops(hidden).includes('button: Leave feedback'), false);
    assert.equal(
      stops(hidden).some((stop) => stop.includes('sidebar')),
      false,
    );

    // Off: the rule is off, so there is no page to show it on.
    assert.equal(
      on({ on: false, visibility: { shown: true, onChange: nothing } }).querySelector('.visibility-row'),
      null,
    );

    setLanguage('fr');
    assert.equal(
      on({ visibility: { shown: true, onChange: nothing } }).querySelector('.visibility-words')?.textContent,
      'Afficher Fruitback sur cette page',
    );
  });

  it('has the site and its named switch, « Leave feedback » with its keys, and the side panel', () => {
    const calls: string[] = [];
    const screen = on({}, calls);

    assert.ok(screen.classList.contains('popup-screen-3'));
    // The host is the title of the screen (axe `page-has-heading-one`).
    assert.equal(screen.querySelector('h1')?.textContent, 'staging.acme.dev');
    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'On · Acme');
    assert.equal(screen.querySelector('[role="switch"]')?.getAttribute('aria-label'), 'Fruitback on staging.acme.dev');
    assert.equal(screen.querySelector('.kit-switch-word')?.textContent, 'On');
    assert.equal(screen.querySelector('.kit-primary')?.getAttribute('data-size'), 'tall');
    assert.equal(screen.querySelector('.shortcut-line')?.textContent, 'or press Alt Shift F on the page');
    assert.deepEqual(
      [...screen.querySelectorAll('.shortcut-line kbd')].map((key) => key.textContent),
      ['Alt', 'Shift', 'F'],
    );
    // No line of what waits before the worker said.
    assert.equal(screen.querySelectorAll('.kit-row').length, 0);
    assert.deepEqual(stops(screen), [
      'button: Account and settings',
      'button: Fruitback on staging.acme.dev',
      'button: Leave feedback',
      'button: Show all notes in a sidebar',
    ]);

    screen.querySelector<HTMLButtonElement>('.kit-primary')?.click();
    screen.querySelector<HTMLButtonElement>('.leave-row .panel-button')?.click();
    screen.querySelector<HTMLButtonElement>('[role="switch"]')?.click();
    assert.deepEqual(calls, ['leave', 'panel', 'toggle:false']);
  });

  it('puts « Leave feedback » at the bottom, the side panel beside it as an icon, the keys under both (FRU-529)', () => {
    const screen = on({ visibility: { shown: true, onChange: nothing } });
    showSiteFacts(screen, { workspace: 'Acme', on: true, onOpenPanel: nothing }, { toCheck: 2, open: 3 });
    const body = screen.querySelector('.popup-body') as HTMLElement;

    // The site, then what waits under it, then the block of « Leave feedback », last of the body.
    assert.deepEqual(
      [...body.children].map((child) => child.className),
      ['site-row', 'kit-dl site-destination', 'visibility-row', 'site-lines', 'leave-block'],
    );
    const leave = body.querySelector('.leave-block') as HTMLElement;
    assert.deepEqual(
      [...leave.children].map((child) => child.className),
      ['leave-row', 'shortcut-line'],
    );
    const [feedback, panel] = [...leave.querySelectorAll('.leave-row > button')];
    assert.equal(feedback?.textContent, 'Leave feedback');
    // The side panel: one icon, no word; its name in aria-label and in the tooltip.
    assert.equal(panel?.textContent, '');
    assert.equal(panel?.getAttribute('aria-label'), 'Show all notes in a sidebar');
    assert.equal(panel?.getAttribute('title'), 'Show all notes in a sidebar');
    assert.equal(panel?.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
    assert.equal(screen.querySelector('.action-block'), null);
  });

  it('keeps the layout with the foot of a paired session, and draws no button when hidden (FRU-529)', () => {
    const foot = page().createElement('div');
    foot.className = 'popup-foot';
    const paired = on({ foot });
    assert.ok(paired.querySelector('.leave-row .panel-button') !== null);
    assert.equal(paired.lastElementChild?.className, 'popup-foot');

    const hidden = on({ visibility: { shown: false, onChange: nothing } });
    assert.equal(hidden.querySelector('.leave-block'), null);
    assert.equal(hidden.querySelector('.panel-button'), null);
  });

  it('has no line of keys when the browser has no shortcut', () => {
    const screen = on({ shortcut: [] });

    assert.equal(screen.querySelector('.shortcut-line'), null);
  });

  it('off: says so, and has nothing else but the switch', () => {
    const screen = on({ on: false });

    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'Off · Acme');
    assert.equal(screen.querySelector('.kit-primary'), null);
    assert.equal(screen.querySelector('.kit-secondary'), null);
  });

  it('adds what the worker says when it answers: the tracker, the fixes to check and the open notes, which open the panel', () => {
    const calls: string[] = [];
    const screen = on({}, calls);
    showSiteFacts(
      screen,
      { workspace: 'Acme', on: true, onOpenPanel: () => calls.push('panel') },
      { destination: 'Linear · Acme', toCheck: 2, open: 3 },
    );

    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'On · Acme');
    assert.deepEqual(
      [...screen.querySelectorAll('.kit-row')].map((row) => [
        row.querySelector('.kit-row-title')?.textContent,
        row.querySelector('.kit-row-subtitle')?.textContent,
        row.querySelector('.kit-drop')?.getAttribute('data-stage'),
      ]),
      [
        ['2 fixes to check', 'Marked done by the team', 'done'],
        ['3 open notes', 'New, to do or in progress', 'progress'],
      ],
    );
    for (const row of screen.querySelectorAll<HTMLButtonElement>('.kit-row')) row.click();
    assert.deepEqual(calls, ['panel', 'panel']);
  });

  it('hides « fixes to check » at zero, says « No open note », and the singular of one', () => {
    const screen = on();
    showSiteFacts(screen, { workspace: 'Acme', on: true, onOpenPanel: nothing }, { toCheck: 0, open: 0 });
    assert.deepEqual(
      [...screen.querySelectorAll('.kit-row-title')].map((title) => title.textContent),
      ['No open note'],
    );
    showSiteFacts(screen, { workspace: 'Acme', on: true, onOpenPanel: nothing }, { toCheck: 1, open: 1 });
    assert.deepEqual(
      [...screen.querySelectorAll('.kit-row-title')].map((title) => title.textContent),
      ['1 fix to check', '1 open note'],
    );
  });

  it('speaks French, with the plural rules of French', () => {
    setLanguage('fr');
    const screen = on();
    showSiteFacts(screen, { workspace: 'Acme', on: true, onOpenPanel: nothing }, { toCheck: 2, open: 1 });

    assert.equal(screen.querySelector('.kit-primary')?.textContent, 'Laisser une note');
    assert.equal(screen.querySelector('.shortcut-line')?.textContent, 'ou appuyez sur Alt Shift F sur la page');
    assert.deepEqual(
      [...screen.querySelectorAll('.kit-row-title')].map((title) => title.textContent),
      ['2 corrections à vérifier', '1 note ouverte'],
    );
    const panel = screen.querySelector('.leave-row .panel-button');
    assert.equal(panel?.getAttribute('aria-label'), 'Voir toutes les notes dans un panneau');
    assert.equal(panel?.getAttribute('title'), 'Voir toutes les notes dans un panneau');
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

  it('says « On · workspace » under the site, and where the notes go on a line of their own, with the mark', () => {
    const screen = on();
    // Before the worker answers: no line yet.
    assert.equal(screen.querySelector('.destination-entry'), null);
    showSiteFacts(screen, facts, { destination: 'Linear · Northwind', open: 0 });

    assert.equal(screen.querySelector('.kit-site-state')?.textContent, 'On · Acme');
    const line = screen.querySelector('.site-destination .destination-entry') as HTMLElement;
    assert.equal(line.querySelector('dt')?.textContent, 'Notes go to');
    assert.equal(line.querySelector('.destination-place')?.textContent, 'Northwind');
    assert.equal(line.querySelector('svg.source-mark')?.getAttribute('data-kind'), 'linear');
    assert.equal(line.querySelector('svg.source-mark')?.getAttribute('aria-hidden'), 'true');
    // The provider in words, for a screen reader.
    assert.equal(line.querySelector('dd.destination-value')?.textContent, 'Linear · Northwind');
    // A role that may not change it: no « Change ».
    assert.equal(line.querySelector('button'), null);
    // It sits right under the site.
    assert.equal(screen.querySelector('.site-row')?.nextElementSibling?.classList.contains('site-destination'), true);
  });

  it('says « Not known » with « Change » when the worker names no place to a role that may set one', () => {
    const screen = on();
    showSiteFacts(screen, facts, {
      change: { sources: [LINEAR], loadOffer: async () => undefined, onPlace: async () => true },
    });
    const line = screen.querySelector('.site-destination .destination-entry');
    assert.equal(line?.querySelector('.destination-place')?.textContent, 'Not known');
    assert.equal(line?.querySelector('svg'), null);
    assert.equal(line?.querySelector('button')?.textContent, 'Change');
    // Nothing named and nothing to change: no line.
    const reader = on();
    showSiteFacts(reader, facts, { open: 1 });
    assert.equal(reader.querySelector('.destination-entry'), null);
  });

  it('draws the drop of Fruitback for a site that keeps its notes', () => {
    const screen = on();
    showSiteFacts(screen, facts, { destination: 'Fruitback' });
    assert.equal(screen.querySelector('.destination-entry svg')?.getAttribute('data-kind'), 'fruitback');
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
    const change = screen.querySelector<HTMLButtonElement>('.destination-entry button');
    assert.equal(change?.textContent, 'Change');
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
    screen.querySelector<HTMLButtonElement>('.destination-entry button')?.click();
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
