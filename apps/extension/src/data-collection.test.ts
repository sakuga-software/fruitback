import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import config from '../wxt.config.ts';
import { DATA_COLLECTION_PERMISSIONS, FIREFOX_MIN_VERSION } from './data-collection.ts';

/** What the manifest declares to Firefox (FRU-333), which AMO checks at each upload. */

type Gecko = {
  strict_min_version?: string;
  data_collection_permissions?: { required?: string[]; optional?: string[] };
};

describe('the data that the extension declares to Firefox (FRU-333)', () => {
  const gecko = (config.manifest as { browser_specific_settings?: { gecko?: Gecko } }).browser_specific_settings?.gecko;

  it('is in the manifest, and is the five categories of what a note sends, each one required', () => {
    assert.deepEqual(gecko?.data_collection_permissions, DATA_COLLECTION_PERMISSIONS);
    // Written out, so a category added or removed is a change of this test too, and of docs/privacy.md.
    assert.deepEqual(DATA_COLLECTION_PERMISSIONS.required.toSorted(), [
      'authenticationInfo',
      'browsingActivity',
      'personalCommunications',
      'personallyIdentifyingInfo',
      'websiteContent',
    ]);
    assert.ok(!DATA_COLLECTION_PERMISSIONS.required.includes('none'));
  });

  it('asks for a Firefox that shows the declaration itself, 140 or later', () => {
    assert.equal(gecko?.strict_min_version, FIREFOX_MIN_VERSION);
    assert.ok(Number.parseInt(FIREFOX_MIN_VERSION, 10) >= 140, FIREFOX_MIN_VERSION);
  });
});
