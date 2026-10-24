import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExtensionBrowser } from './api.ts';
import { lastUsed, sameAsThisBrowser } from './extension-connected.ts';

function browser(id: string, label: string, usedAt: string): ExtensionBrowser {
  return { id, browser: label, connectedAt: '2026-10-01T09:00:00Z', usedAt };
}

const MAC = browser('ext_mac', 'Chrome on macOS', '2026-10-23T10:00:00Z');
const MAC_LATER = browser('ext_mac2', 'Chrome on macOS', '2026-10-23T12:00:00Z');
const PC = browser('ext_pc', 'Edge on Windows', '2026-10-23T11:00:00Z');

describe('the browser of the extension that the screens name (FRU-441)', () => {
  it('is the one used last, and none for an empty list', () => {
    assert.equal(lastUsed([]), undefined);
    assert.equal(lastUsed([MAC, PC]), PC);
    assert.equal(lastUsed([MAC_LATER, MAC, PC]), MAC_LATER);
  });

  it('is this browser when a browser of the extension has its label', () => {
    assert.equal(sameAsThisBrowser([MAC, PC], 'Edge on Windows'), PC);
    assert.equal(sameAsThisBrowser([MAC, MAC_LATER, PC], 'Chrome on macOS'), MAC_LATER);
    assert.equal(sameAsThisBrowser([MAC, PC], 'Firefox on Linux'), undefined);
  });

  it('is never this browser when the label of this browser is not known', () => {
    assert.equal(sameAsThisBrowser([MAC], undefined), undefined);
    // « A browser » is what the worker says of a user agent it cannot read: it names no browser.
    assert.equal(sameAsThisBrowser([browser('ext_x', 'A browser', '2026-10-23T10:00:00Z')], 'A browser'), undefined);
  });
});
