import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import {
  type PanelApis,
  keepPopupOnActionClick,
  openPanel,
  openPanelOrPage,
  panelPage,
  webHost,
} from './side-panel.ts';

/**
 * The side panel (FRU-296): the gesture that opens it in each browser, the behaviour of the icon,
 * and the frame of its page. The panel opened from a real popup is `e2e/side-panel.spec.ts`'s.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/sidepanel.html' }).document as unknown as Document;
}

const nothing = () => {};

afterEach(() => setLanguage('en'));

describe('opening the panel (FRU-296)', () => {
  it('asks Chrome for the panel of the tab, at once, in the click', () => {
    const calls: unknown[] = [];
    const apis: PanelApis = { sidePanel: { open: async (options) => void calls.push(options) } };
    const opened = openPanel(apis, { tabId: 7 });

    // Synchronous: an `await` before the call would drop the gesture.
    assert.deepEqual(calls, [{ tabId: 7 }]);
    assert.ok(opened instanceof Promise);
  });

  it('asks for the panel of the window when the popup knows no tab', () => {
    const calls: unknown[] = [];
    openPanel({ sidePanel: { open: async (options) => void calls.push(options) } }, { windowId: 3 });

    assert.deepEqual(calls, [{ windowId: 3 }]);
  });

  it('opens the sidebar of Firefox', () => {
    let opened = 0;
    openPanel({ sidebarAction: { open: async () => void (opened += 1) } }, { tabId: 7 });

    assert.equal(opened, 1);
  });

  it('answers nothing on a browser with no panel, so the popup shows the list in the page', () => {
    assert.equal(openPanel({}, { tabId: 7 }), undefined);
  });

  it('passes the refusal of the browser on', async () => {
    const apis: PanelApis = {
      sidePanel: { open: () => Promise.reject(new Error('may only be called in response to a user gesture')) },
    };

    await assert.rejects(openPanel(apis, { tabId: 1 }) as Promise<void>, /user gesture/);
  });

  it('shows the list of the page when the browser has no panel, or refuses to open it', async () => {
    const quiet = mock.method(console, 'error', () => {});
    const page = (answer: boolean) => {
      const asked: string[] = [];

      return { asked, inPage: async () => (asked.push('page'), answer) };
    };
    const refusing: PanelApis = { sidePanel: { open: () => Promise.reject(new Error('no gesture')) } };
    const throwing: PanelApis = {
      sidebarAction: {
        open: () => {
          throw new Error('not in a user action');
        },
      },
    };

    const opened = page(true);
    assert.equal(await openPanelOrPage({ sidePanel: { open: async () => {} } }, { tabId: 1 }, opened.inPage), 'panel');
    assert.deepEqual(opened.asked, [], 'the page was asked although the panel opened');
    for (const apis of [{}, refusing, throwing]) {
      const fallback = page(true);
      assert.equal(await openPanelOrPage(apis, { tabId: 1 }, fallback.inPage), 'page');
      assert.deepEqual(fallback.asked, ['page']);
    }
    assert.equal(await openPanelOrPage(refusing, { tabId: 1 }, page(false).inPage), 'nothing');
    quiet.mock.restore();
  });

  it('keeps the popup on the click of the icon, and asks nothing of Firefox', async () => {
    const behaviours: unknown[] = [];
    await keepPopupOnActionClick({
      sidePanel: { open: async () => {}, setPanelBehavior: async (behaviour) => void behaviours.push(behaviour) },
    });
    await keepPopupOnActionClick({ sidebarAction: { open: async () => {} } });

    assert.deepEqual(behaviours, [{ openPanelOnActionClick: false }]);
  });
});

describe('the page of the panel (FRU-296)', () => {
  it('has the head of the shell, « Notes on this page » and « Close the sidebar »', () => {
    let closed = 0;
    const root = panelPage(page(), { tab: { kind: 'not-on' }, onClose: () => (closed += 1), onShowOnPage: nothing });

    assert.equal(root.querySelector('.kit-head .kit-brand')?.textContent, 'Fruitback');
    assert.equal(root.querySelector('h2')?.textContent, 'Notes on this page');
    const close = root.querySelector<HTMLButtonElement>('button.panel-close');
    assert.equal(close?.getAttribute('aria-label'), 'Close the sidebar');
    close?.click();
    assert.equal(closed, 1);
  });

  it('says why it shows nothing on a page Fruitback is not on', () => {
    const root = panelPage(page(), { tab: { kind: 'not-on' }, onClose: nothing, onShowOnPage: nothing });

    assert.deepEqual(
      [...root.querySelectorAll('.panel-body p')].map((line) => line.textContent),
      ['Fruitback is not on for this page.', 'Turn it on from the Fruitback button in the toolbar.'],
    );
    assert.equal(root.querySelector('.panel-body button'), null);
  });

  it('names the site of the tab, and shows its notes on the page at a click', () => {
    let shown = 0;
    const root = panelPage(page(), {
      tab: { kind: 'on', host: 'staging.acme.dev', tabId: 4 },
      onClose: nothing,
      onShowOnPage: () => (shown += 1),
    });

    assert.equal(root.querySelector('.panel-site')?.textContent, 'staging.acme.dev');
    root.querySelector<HTMLButtonElement>('.panel-body button')?.click();
    assert.equal(shown, 1);
  });

  it('is in French for a French reader', () => {
    setLanguage('fr');
    const root = panelPage(page(), { tab: { kind: 'not-on' }, onClose: nothing, onShowOnPage: nothing });

    assert.equal(root.querySelector('h2')?.textContent, 'Notes de cette page');
    assert.equal(root.querySelector('button.panel-close')?.getAttribute('aria-label'), 'Fermer le panneau');
  });
});

describe('the host the panel shows', () => {
  it('is the host of a web address, and nothing for a page of the browser', () => {
    assert.equal(webHost('https://staging.acme.dev/cart?x=1'), 'staging.acme.dev');
    assert.equal(webHost('http://localhost:5177/'), 'localhost:5177');
    assert.equal(webHost('chrome://extensions/'), undefined);
    assert.equal(webHost('about:blank'), undefined);
    assert.equal(webHost(undefined), undefined);
    assert.equal(webHost('not a url'), undefined);
  });
});
