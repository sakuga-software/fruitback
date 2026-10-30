import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * nginx compresses what the console serves (FRU-492). With no `gzip` line it sends each file as it
 * is: 1.34 MB of script and style for the first screen, measured on app.fruitback.com.
 */
const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');

/** The types that `conf` compresses: none when `gzip` is not `on`. nginx compresses text/html always. */
function compressed(text: string): Set<string> {
  const lines = text.split('\n').map((line) => line.replace(/#.*$/, '').trim());
  if (!lines.includes('gzip on;')) return new Set();
  const types = lines.find((line) => line.startsWith('gzip_types '));

  return new Set(['text/html', ...(types?.replace(/^gzip_types\s+|;$/g, '').split(/\s+/) ?? [])]);
}

describe('the compression of the console (FRU-492)', () => {
  it('compresses the script, the style, the page and the icons of the build', () => {
    // The types `/etc/nginx/mime.types` of nginx 1.29 gives to `.js`, `.css`, `.html` and `.svg`.
    for (const type of ['application/javascript', 'text/css', 'text/html', 'image/svg+xml']) {
      assert.ok(compressed(conf).has(type), `nginx.conf does not compress ${type}`);
    }
  });

  it('says to a shared cache that the answer depends on Accept-Encoding', () => {
    assert.match(conf, /^\s*gzip_vary on;/m);
  });

  it('finds nothing compressed in a configuration with gzip off (the control)', () => {
    assert.equal(compressed(conf.replace('gzip on;', 'gzip off;')).size, 0);
    assert.equal(compressed(conf.replace(/^\s*gzip on;.*$/m, '')).size, 0);
  });
});
