import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import {
  connecting,
  loading,
  newSite,
  notAWebPage,
  problem,
  shell,
  showPageCounts,
  signInStop,
  signedOut,
  siteInWorkspace,
  siteOn,
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
    ['refused', 'The sign-in did not finish.', 'It was refused in the console.'],
    ['expired', 'The sign-in did not finish.', 'The tab was not approved in time.'],
    ['unavailable', 'Fruitback did not answer.', 'Check the connection, then try again.'],
    ['untrusted', 'The sign-in did not start.', 'Fruitback named a console that is not its own.'],
    ['blocked', 'The sign-in did not start.', 'The browser did not give the extension access to Fruitback.'],
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

  it('says that a page that is not http or https is not one Fruitback runs on, with no button', () => {
    const root = notAWebPage(page(), { onSettings: nothing });

    assert.ok(root.classList.contains('popup-screen-4'));
    assert.equal(root.querySelector('h1')?.textContent, 'Fruitback works on http and https pages.');
    assert.deepEqual(stops(root), ['button: Account and settings']);
  });

  it('says it is loading, once, with nothing to press but the settings', () => {
    const root = loading(page(), { onSettings: nothing });

    assert.equal(root.querySelector('[role="status"]')?.textContent, 'Loading…');
    assert.deepEqual(stops(root), ['button: Account and settings']);
  });
});

describe('a site of a workspace, not on here (06, FRU-254)', () => {
  const COUNTS = { seeded: 3, green: 2, ripening: 4, ripe: 2, composted: 1 };
  const base = {
    origin: ORIGIN,
    workspace: 'Sakuga',
    visibility: 'members' as const,
    browserName: 'Chrome',
    onTurnOn: nothing,
    onSettings: nothing,
  };

  it('names the workspace, who sees the notes, how many wait, and offers one click', () => {
    let turned = 0;
    const root = siteInWorkspace(page(), { ...base, counts: COUNTS, onTurnOn: () => (turned += 1) });

    assert.equal(root.querySelector('h1')?.textContent, 'staging.acme.dev');
    assert.equal(root.querySelector('.subtitle')?.textContent, 'In Sakuga · members see the notes');
    assert.equal(root.querySelector('.site-total')?.textContent, '12 notes wait on this site');
    const bar = root.querySelector('.stage-bar');
    assert.equal(bar?.getAttribute('role'), 'img');
    assert.equal(bar?.getAttribute('aria-label'), '3 new, 2 to do, 4 in progress, 2 done, 1 closed');
    // Each segment as wide as its share: its flex grows by its count.
    assert.deepEqual(
      [...(bar?.children ?? [])].map((segment) => [
        segment.className,
        (segment as HTMLElement).style.flex.split(' ')[0],
      ]),
      [
        ['stage-seeded', '3'],
        ['stage-green', '2'],
        ['stage-ripening', '4'],
        ['stage-ripe', '2'],
        ['stage-composted', '1'],
      ],
    );
    assert.equal(
      root.querySelector('.site-detail')?.textContent,
      '3 new · 2 to do · 4 in progress · 2 done · 1 closed',
    );
    assert.equal(root.querySelector('.note')?.textContent, 'Chrome asks for access to this site only.');
    assert.deepEqual(stops(root), ['button: Account and settings', 'button: Turn on here']);
    (root.querySelector('.action') as HTMLElement).click();
    assert.equal(turned, 1);
  });

  it('says everyone sees the notes of a site open to everyone, and one note in the singular', () => {
    const root = siteInWorkspace(page(), {
      ...base,
      visibility: 'everyone',
      counts: { ...COUNTS, seeded: 1, green: 0, ripening: 0, ripe: 0, composted: 0 },
    });

    assert.equal(root.querySelector('.subtitle')?.textContent, 'In Sakuga · everyone sees the notes');
    assert.equal(root.querySelector('.site-total')?.textContent, '1 note waits on this site');
    // A stage with no note draws no segment of the bar.
    assert.equal(root.querySelector('.stage-bar')?.children.length, 1);
  });

  it('leaves the counts out when Fruitback gave none, and draws no bar for a site with no note', () => {
    assert.equal(siteInWorkspace(page(), base).querySelector('.site-counts'), null);
    const empty = siteInWorkspace(page(), {
      ...base,
      counts: { seeded: 0, green: 0, ripening: 0, ripe: 0, composted: 0 },
    });
    assert.equal(empty.querySelector('.site-total')?.textContent, '0 notes wait on this site');
    assert.equal(empty.querySelector('.stage-bar'), null);
  });
});

describe('a site of a workspace, on here (07, FRU-254)', () => {
  const PAGE = { seeded: 2, green: 1, ripening: 3, ripe: 2, composted: 0 };
  const base = {
    origin: ORIGIN,
    workspace: 'Sakuga',
    on: true,
    onToggle: nothing,
    onLeaveFeedback: nothing,
    onShowEveryNote: nothing,
    onSettings: nothing,
  };

  it('has a named switch, the notes of the page by stage, and the two actions', () => {
    const done: string[] = [];
    const root = siteOn(page(), {
      ...base,
      pageCounts: PAGE,
      onToggle: (on) => done.push(`switch ${on}`),
      onLeaveFeedback: () => done.push('leave'),
      onShowEveryNote: () => done.push('every'),
    });

    assert.equal(root.querySelector('.subtitle')?.textContent, 'On · Sakuga');
    const toggle = root.querySelector('[role="switch"]');
    assert.equal(toggle?.getAttribute('aria-checked'), 'true');
    assert.equal(toggle?.getAttribute('aria-label'), 'Fruitback on staging.acme.dev');
    assert.equal(root.querySelector('.page-notes h2')?.textContent, 'On this page8 notes');
    assert.equal(root.querySelector('.page-notes')?.getAttribute('aria-labelledby'), 'page-notes-title');
    assert.deepEqual(
      [...root.querySelectorAll('.page-notes li')].map((row) => [
        row.querySelector('.stage-word')?.textContent,
        row.querySelector('.count')?.textContent,
        row.querySelector('.count')?.classList.contains('zero'),
      ]),
      [
        ['New', '2', false],
        ['To do', '1', false],
        ['In progress', '3', false],
        ['Done', '2', false],
        ['Closed', '0', true],
      ],
    );
    assert.deepEqual(stops(root), [
      'button: Account and settings',
      'button: Fruitback on staging.acme.dev',
      'button: Leave feedback',
      'button: Show every note of the page',
    ]);
    for (const selector of ['[role="switch"]', '.action', '.kit-secondary'])
      (root.querySelector(selector) as HTMLElement).click();
    assert.deepEqual(done, ['switch false', 'leave', 'every']);
  });

  it('off: says so, turns on with the switch, and has nothing of the page', () => {
    let next: boolean | undefined;
    const root = siteOn(page(), { ...base, on: false, pageCounts: PAGE, onToggle: (on) => (next = on) });

    assert.equal(root.querySelector('.subtitle')?.textContent, 'Off · Sakuga');
    assert.equal(root.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'false');
    assert.equal(root.querySelector('.page-notes'), null);
    assert.equal(root.querySelector('.action'), null);
    (root.querySelector('[role="switch"]') as HTMLElement).click();
    assert.equal(next, true);
  });

  it('leaves the section out when the widget of the tab did not say, rather than drawing zeros', () => {
    const root = siteOn(page(), base);

    assert.equal(root.querySelector('.page-notes'), null);
    assert.ok(root.querySelector('.action'));
  });

  it('speaks French', () => {
    setLanguage('fr');
    const root = siteOn(page(), { ...base, pageCounts: { ...PAGE, seeded: 1, green: 0, ripening: 0, ripe: 0 } });

    assert.equal(root.querySelector('.subtitle')?.textContent, 'Activé · Sakuga');
    assert.equal(root.querySelector('.page-notes h2')?.textContent, 'Sur cette page1 note');
    assert.equal(root.querySelector('.action')?.textContent, 'Laisser une note');
  });
});

describe('the notes of the page, added to a screen 07 already drawn (FRU-254)', () => {
  const base = {
    origin: ORIGIN,
    workspace: 'Sakuga',
    on: true,
    onToggle: nothing,
    onLeaveFeedback: nothing,
    onShowEveryNote: nothing,
    onSettings: nothing,
  };
  const COUNTS = { seeded: 1, green: 0, ripening: 2, ripe: 0, composted: 0 };

  it('goes above the two actions, once', () => {
    const root = siteOn(page(), base);
    assert.equal(root.querySelector('.page-notes'), null);

    showPageCounts(root, COUNTS);
    showPageCounts(root, COUNTS);

    assert.equal(root.querySelectorAll('.page-notes').length, 1);
    assert.equal(root.querySelector('.page-notes')?.nextElementSibling?.className, 'action-block');
    assert.equal(root.querySelector('.page-notes h2')?.textContent, 'On this page3 notes');
  });

  it('is not added to a screen that is off', () => {
    const root = siteOn(page(), { ...base, on: false });

    showPageCounts(root, COUNTS);

    assert.equal(root.querySelector('.page-notes'), null);
  });
});

describe('a site of no workspace (08, FRU-255)', () => {
  const SAKUGA = { id: 'ws_1', name: 'Sakuga' };
  const NORTHWIND = { id: 'ws_2', name: 'Northwind' };
  const base = { origin: 'https://preview.client.fr', browserName: 'Chrome', onAdd: nothing, onSettings: nothing };

  it('with one workspace: no list, its name in the button, and the add goes to it', () => {
    const added: string[] = [];
    const root = newSite(page(), { ...base, workspaces: [SAKUGA], onAdd: (id) => added.push(id) });

    assert.equal(root.querySelector('h1')?.textContent, 'preview.client.fr');
    assert.equal(root.querySelector('.subtitle')?.textContent, 'Not in a workspace yet');
    assert.equal(root.querySelector('select'), null);
    assert.deepEqual(stops(root), ['button: Account and settings', 'button: Add to Sakuga and turn on']);
    (root.querySelector('form') as HTMLFormElement).requestSubmit();
    assert.deepEqual(added, ['ws_1']);
    // Nothing about previews: no proof of the domain, no preview (Q4).
    assert.doesNotMatch(root.textContent ?? '', /preview build/i);
  });

  it('with two: a list named « Workspace », and the button follows the choice', () => {
    const added: string[] = [];
    const root = newSite(page(), { ...base, workspaces: [SAKUGA, NORTHWIND], onAdd: (id) => added.push(id) });
    const select = root.querySelector('select') as HTMLSelectElement;

    assert.equal(root.querySelector('label.field')?.firstChild?.textContent, 'Workspace');
    assert.deepEqual(
      [...select.options].map((option) => [option.value, option.textContent]),
      [
        ['ws_1', 'Sakuga'],
        ['ws_2', 'Northwind'],
      ],
    );
    select.value = 'ws_2';
    select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event('change'));
    assert.equal(root.querySelector('.action')?.textContent, 'Add to Northwind and turn on');
    (root.querySelector('form') as HTMLFormElement).requestSubmit();
    assert.deepEqual(added, ['ws_2']);
  });

  it('with none: says who can add it, and has no button', () => {
    const root = newSite(page(), { ...base, workspaces: [] });

    assert.equal(root.querySelector('.lead')?.textContent, 'Ask an admin of your workspace to add this site.');
    assert.equal(root.querySelector('.action'), null);
    assert.deepEqual(stops(root), ['button: Account and settings']);
  });

  it('speaks French', () => {
    setLanguage('fr');
    const root = newSite(page(), { ...base, workspaces: [SAKUGA] });

    assert.equal(root.querySelector('.subtitle')?.textContent, 'Dans aucun workspace pour l’instant');
    assert.equal(root.querySelector('.action')?.textContent, 'Ajouter à Sakuga et activer');
  });
});
