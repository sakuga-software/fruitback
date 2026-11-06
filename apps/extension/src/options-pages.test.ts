import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { DEFAULT_PAGE, PAGES, type PageId, pageOf, pageTitle, showPage } from './options-pages.ts';
import { menu } from './site-page.ts';

/**
 * The pages of the page of the extension (FRU-591), read on happy-dom: the fragment chooses the
 * page, and the sections of the other pages stay in the DOM with what somebody typed. The switch in
 * a browser, Back and Forward, axe and 390 px are `e2e/extension-page.spec.ts`'s.
 */

const LABELS: Record<PageId, string> = {
  sites: 'Sites',
  workers: 'Servers and sessions',
  share: 'Share rules',
  prefs: 'Preferences',
};

function page() {
  const document = new HappyDomWindow({ url: 'chrome-extension://fruitback/options.html' })
    .document as unknown as Document;
  const views = Object.fromEntries(
    PAGES.map((id) => {
      const section = document.createElement('section');
      section.id = id;
      const input = document.createElement('input');
      section.append(input);
      document.body.append(section);

      return [id, section];
    }),
  ) as Record<PageId, HTMLElement>;
  const nav = menu(document, {
    version: '0.7.0',
    current: DEFAULT_PAGE,
    entries: PAGES.map((id) => ({ id, label: LABELS[id] })),
  });
  document.body.prepend(nav);

  return { document, views, nav };
}

describe('the pages of the page of the extension (FRU-591)', () => {
  it('reads the page from the fragment, with « Sites » for no fragment and for a name of no page', () => {
    assert.equal(pageOf(''), 'sites');
    assert.equal(pageOf('#'), 'sites');
    assert.equal(pageOf('#sites'), 'sites');
    assert.equal(pageOf('#workers'), 'workers');
    assert.equal(pageOf('#share'), 'share');
    assert.equal(pageOf('#prefs'), 'prefs');
    assert.equal(pageOf('#nothing'), 'sites');
    assert.equal(pageOf('#PREFS'), 'sites');
    assert.equal(pageOf('#prefsx'), 'sites');
  });

  it('keeps the meaning of the pairing link of the popup: `#workers?worker=…&code=…` is « Servers and sessions »', () => {
    const query = new URLSearchParams({ worker: 'https://feedback.acme.dev', code: 'ABCD-EFGH-JKLM' });
    assert.equal(pageOf(`#workers?${query.toString()}`), 'workers');
    assert.equal(pageOf('#workers?'), 'workers');
  });

  it('names the page in the title of the tab', () => {
    assert.equal(pageTitle('Preferences'), 'Preferences · Fruitback');
    assert.equal(pageTitle('Préférences'), 'Préférences · Fruitback');
  });

  it('shows the section of the page only, and marks its entry in the menu', () => {
    const { document, views, nav } = page();
    for (const shown of PAGES) {
      showPage(document, { page: shown, views, labels: LABELS, menu: nav });
      assert.deepEqual(
        PAGES.map((id) => [id, views[id].hidden]),
        PAGES.map((id) => [id, id !== shown]),
      );
      assert.deepEqual(
        [...nav.querySelectorAll('a.page-entry')].map((entry) => [
          entry.getAttribute('href'),
          entry.getAttribute('aria-current'),
        ]),
        PAGES.map((id) => [`#${id}`, id === shown ? 'page' : null]),
      );
      assert.equal(document.title, `${LABELS[shown]} · Fruitback`);
    }
  });

  it('keeps what somebody typed on a page while another page is shown', () => {
    const { document, views, nav } = page();
    const code = views.workers.querySelector('input') as HTMLInputElement;
    const pattern = views.sites.querySelector('input') as HTMLInputElement;
    showPage(document, { page: 'sites', views, labels: LABELS, menu: nav });
    pattern.value = 'https://*.staging.acme.dev';
    showPage(document, { page: 'workers', views, labels: LABELS, menu: nav });
    code.value = 'ABCD-EFGH-JKLM';
    showPage(document, { page: 'prefs', views, labels: LABELS, menu: nav });
    showPage(document, { page: 'share', views, labels: LABELS, menu: nav });
    showPage(document, { page: 'sites', views, labels: LABELS, menu: nav });

    assert.equal(views.sites.querySelector('input'), pattern);
    assert.equal(pattern.value, 'https://*.staging.acme.dev');
    assert.equal(views.workers.querySelector('input'), code);
    assert.equal(code.value, 'ABCD-EFGH-JKLM');
    assert.equal(document.querySelectorAll('section').length, PAGES.length);
  });

  it('leaves the count of « Servers and sessions » in its entry', () => {
    const { document, views, nav } = page();
    const entry = nav.querySelector('a.page-entry[href="#workers"]') as HTMLElement;
    const count = document.createElement('span');
    count.className = 'page-count';
    count.textContent = '3';
    entry.append(count);
    showPage(document, { page: 'workers', views, labels: LABELS, menu: nav });

    assert.equal(entry.getAttribute('aria-current'), 'page');
    assert.equal(entry.querySelector('.page-count')?.textContent, '3');
    assert.equal(document.title, 'Servers and sessions · Fruitback');
  });
});
