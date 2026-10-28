import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SAFARI_EXTENSIONS,
  SAFARI_MIN_VERSION,
  browserFamily,
  extensionsPlace,
  opensChromiumShortcuts,
  safariManifest,
} from './browser-family.ts';
import { openPanelForTab } from './panel-request.ts';
import { type PanelApis, openPanelOrPage } from './side-panel.ts';

describe('the family of the build (FRU-380)', () => {
  it('reads the flags wxt sets for each browser', () => {
    assert.equal(browserFamily({}), 'chromium');
    assert.equal(browserFamily({ FIREFOX: false, SAFARI: false }), 'chromium');
    assert.equal(browserFamily({ FIREFOX: true, SAFARI: false }), 'firefox');
    assert.equal(browserFamily({ FIREFOX: false, SAFARI: true }), 'safari');
  });

  it('tells Safari its own minimum, and drops the keys of Firefox', () => {
    const manifest = {
      name: 'Fruitback',
      browser_specific_settings: { gecko: { id: 'fruitback@sakuga-software.com' } },
    };
    safariManifest(manifest);

    assert.deepEqual(manifest, {
      name: 'Fruitback',
      browser_specific_settings: { safari: { strict_min_version: '16.4' } },
    });
    assert.equal(SAFARI_MIN_VERSION, '16.4');
  });

  it('names the place of the extensions of each browser', () => {
    assert.equal(extensionsPlace('chromium'), 'chrome://extensions');
    assert.equal(extensionsPlace('firefox'), 'about:addons');
    assert.equal(extensionsPlace('safari'), SAFARI_EXTENSIONS);
  });

  it('opens the page of the shortcuts of Chromium on Chromium only', () => {
    assert.equal(opensChromiumShortcuts('chromium'), true);
    assert.equal(opensChromiumShortcuts('firefox'), false);
    assert.equal(opensChromiumShortcuts('safari'), false);
  });
});

/**
 * Safari has neither `sidePanel` nor `sidebarAction` (`browser-compat-data`, and the converter of
 * Xcode says so of the manifest). What a person asked for is shown in the page all the same.
 */
describe('Safari, which has no side panel (FRU-380)', () => {
  const safari: PanelApis = {};

  it('shows the list of the page from the popup', async () => {
    let asked = 0;
    const shown = await openPanelOrPage(safari, { tabId: 7 }, async () => {
      asked += 1;

      return true;
    });

    assert.equal(shown, 'page');
    assert.equal(asked, 1);
  });

  it('answers the button of the widget « not opened », so the widget opens its own list', async () => {
    let forgotten: number | undefined;
    const gate = Object.assign(() => true, { forget: (tabId: number) => void (forgotten = tabId) });

    assert.equal(await openPanelForTab(safari, 7, gate), false);
    // The next click may try again at once.
    assert.equal(forgotten, 7);
  });
});
