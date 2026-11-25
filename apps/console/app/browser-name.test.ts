import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { browserOf } from './browser-name.ts';

describe('the browser of a note, in a word (FRU-687)', () => {
  it('reads Edge before Chrome, and Chrome before Safari', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    assert.equal(browserOf(chrome), 'Chrome');
    assert.equal(browserOf(`${chrome} Edg/131.0.0.0`), 'Edge');
    assert.equal(
      browserOf(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      ),
      'Safari',
    );
    assert.equal(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'), 'Firefox');
  });

  it('says nothing of a browser it does not know, or of none', () => {
    assert.equal(browserOf('curl/8.7.1'), undefined);
    assert.equal(browserOf(undefined), undefined);
  });
});
