import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import {
  connecting,
  initialOf,
  loading,
  newSite,
  notAWebPage,
  shell,
  showPageCounts,
  signInProblem,
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
    assert.deepEqual(stops(root), ['button: Settings and every site', 'button: Turn on here']);
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
      'button: Settings and every site',
      'button: Fruitback on staging.acme.dev',
      'button: Leave feedback',
      'button: Show every note of the page',
    ]);
    for (const selector of ['[role="switch"]', '.action', '.secondary-action'])
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
    assert.deepEqual(stops(root), ['button: Settings and every site', 'button: Add to Sakuga and turn on']);
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
    assert.deepEqual(stops(root), ['button: Settings and every site']);
  });

  it('speaks French', () => {
    setLanguage('fr');
    const root = newSite(page(), { ...base, workspaces: [SAKUGA] });

    assert.equal(root.querySelector('.subtitle')?.textContent, 'Dans aucun workspace pour l’instant');
    assert.equal(root.querySelector('.action')?.textContent, 'Ajouter à Sakuga et activer');
  });
});
