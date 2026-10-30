import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { underSettings } from './settings-path.ts';

describe('the pages of the settings of a workspace (FRU-544)', () => {
  it('holds the settings and every page under them', () => {
    assert.equal(underSettings('/w/w1/settings', 'w1'), true);
    assert.equal(underSettings('/w/w1/settings/ai', 'w1'), true);
    assert.equal(underSettings('/w/w1/settings/agents', 'w1'), true);
  });

  it('holds no path that only starts with the same letters, and no other workspace', () => {
    assert.equal(underSettings('/w/w1/settingsX', 'w1'), false);
    assert.equal(underSettings('/w/w1/sites', 'w1'), false);
    assert.equal(underSettings('/w/w10/settings', 'w1'), false);
    assert.equal(underSettings('/w/w1/settings', 'w10'), false);
  });
});
