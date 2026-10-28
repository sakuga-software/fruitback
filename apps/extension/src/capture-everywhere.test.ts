import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../wxt.config.ts';
import { BROWSER_WARNING, CAPTURE_EVERYWHERE, browserWarning, setCaptureEverywhere } from './capture-everywhere.ts';

/** « Allow captures on every site » (FRU-425). */
describe('the permission of the captures on every site (FRU-425)', () => {
  const manifest = config.manifest as {
    permissions?: string[];
    optional_host_permissions?: string[];
    host_permissions?: string[];
  };

  it('is optional: nothing is asked at install', () => {
    assert.ok(manifest.optional_host_permissions?.includes('<all_urls>'));
    assert.equal(manifest.host_permissions, undefined);
    assert.ok(!(manifest.permissions ?? []).includes('<all_urls>'));
    assert.deepEqual(CAPTURE_EVERYWHERE, { origins: ['<all_urls>'] });
  });

  it('asks for <all_urls> to turn it on, and gives it back to turn it off', async () => {
    const calls: string[] = [];
    const permissions = {
      request: async (wanted: typeof CAPTURE_EVERYWHERE) => {
        calls.push(`request ${wanted.origins.join()}`);

        return true;
      },
      remove: async (given: typeof CAPTURE_EVERYWHERE) => {
        calls.push(`remove ${given.origins.join()}`);

        return true;
      },
    };
    assert.equal(await setCaptureEverywhere(true, permissions), true);
    assert.equal(await setCaptureEverywhere(false, permissions), false);
    assert.deepEqual(calls, ['request <all_urls>', 'remove <all_urls>']);
  });

  it('says it is still held when the browser refused to give it back, and not held when the prompt was refused', async () => {
    const refusing = { request: async () => false, remove: async () => false };
    assert.equal(await setCaptureEverywhere(true, refusing), false);
    assert.equal(await setCaptureEverywhere(false, refusing), true);
  });

  it('quotes the prompt of each browser', () => {
    assert.equal(browserWarning('chromium'), BROWSER_WARNING.chrome);
    assert.equal(browserWarning('firefox'), BROWSER_WARNING.firefox);
    // FRU-380: Safari's words were not read, so nothing is quoted for it.
    assert.equal(browserWarning('safari'), undefined);
    assert.equal(BROWSER_WARNING.chrome, 'Read and change all your data on all websites');
  });

  // The page cannot run under `node --test`: its source is read. The request is the first call of
  // the click, with no `await` before it, or the browser refuses it for want of the gesture.
  it('is asked from the click of the switch, with nothing awaited before it', () => {
    const page = readFileSync(new URL('../entrypoints/options/main.ts', import.meta.url), 'utf8');
    assert.match(
      page,
      /onCapturesEverywhere: \(on\) =>\s*setCaptureEverywhere\(on, \{\s*request: \(wanted\) => browser\.permissions\.request\(/,
    );
    const row = readFileSync(new URL('./workers-page.ts', import.meta.url), 'utf8');
    assert.match(row, /onChange: \(on\) => \{\s*problem\.textContent = '';\s*void options\.onCapturesEverywhere\(on\)/);
  });
});
