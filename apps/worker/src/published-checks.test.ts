import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import { builtArchiveVersion, checkDigest, checkInstalled } from '../../../e2e/published/checks.ts';

/**
 * The checks of `e2e/published/fetch.ts` on what it fetched (FRU-460). It lives here because the root
 * has no `test` target, as `ci-durations.test.ts` does. Each check is shown to pass, then to fail on
 * a planted violation.
 */
describe('the checks of the published code', () => {
  const bytes = new TextEncoder().encode('the archive of a release');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

  it('take an archive whose bytes hash to the digest of GitHub', () => {
    assert.doesNotThrow(() => checkDigest('fruitback-0.4.0-chrome.zip', bytes, digest));
  });

  it('refuse an archive with one byte changed', () => {
    const changed = Uint8Array.from(bytes);
    changed[0] = (changed[0] ?? 0) ^ 1;
    assert.throws(
      () => checkDigest('fruitback-0.4.0-chrome.zip', changed, digest),
      /^Error: fruitback-0\.4\.0-chrome\.zip is sha256:[0-9a-f]{64}, and GitHub says sha256:/,
    );
  });

  it('refuse an asset that GitHub gives no SHA-256 for, and say what to do', () => {
    assert.throws(() => checkDigest('a.zip', bytes, null), /no SHA-256 for a\.zip .*upload the asset/);
    assert.throws(() => checkDigest('a.zip', bytes, 'md5:abc'), /no SHA-256 for a\.zip/);
  });

  it('take packages that all carry the version asked for', () => {
    assert.doesNotThrow(() => checkInstalled('0.4.0', { fruitback: '0.4.0', '@fruitback/widget': '0.4.0' }));
  });

  it('read the version of an archive built here from the name that wxt zip gives it (FRU-612)', () => {
    assert.equal(builtArchiveVersion('apps/extension/.output/fruitback-0.9.0-chrome.zip'), '0.9.0');
    assert.equal(builtArchiveVersion('fruitback-1.0.0-rc.1-chrome.zip'), '1.0.0-rc.1');
  });

  it('refuse an archive built here that is not the one for Chrome, or that names no version', () => {
    for (const file of [
      'apps/extension/.output/fruitback-0.9.0-firefox.zip',
      'apps/extension/.output/fruitback-0.9.0-sources.zip',
      'apps/extension/.output/fruitbackextension-0.9.0-chrome.zip',
      'apps/extension/.output/fruitback-chrome.zip',
    ]) {
      assert.throws(() => builtArchiveVersion(file), /is not an archive for Chrome of wxt zip/, file);
    }
  });

  it('refuse packages of mixed versions', () => {
    assert.throws(
      () => checkInstalled('0.4.0', { fruitback: '0.4.0', '@fruitback/widget': '0.3.0' }),
      /npm 0\.4\.0 was asked for, and installed .*"@fruitback\/widget":"0\.3\.0"/,
    );
  });
});
