import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Every JSON answer of the worker says `Cache-Control: no-store` (FRU-506). Each answer is of one
 * caller: a session, a token, a site, an operator. A shared cache must keep none of them.
 *
 * Nine of the twenty `json()` helpers of the routes did not say it, `POST /session/pair` and
 * `POST /session/refresh` included, which answer tokens. The HTTP tests check the routes of a
 * session; this test checks every helper, so that a new copy cannot drop the header.
 */
describe('the JSON answers of the worker (FRU-506)', () => {
  const dir = new URL('.', import.meta.url);
  const sources = readdirSync(dir).filter((name) => name.endsWith('.ts') && !/\.(test|fixture)\.ts$/.test(name));

  it('all say Cache-Control: no-store', () => {
    const helpers = sources.flatMap((name) => {
      const text = readFileSync(new URL(name, dir), 'utf8');
      const found = [...text.matchAll(/^function json\([^]*?^}/gm)];

      return found.map((match) => ({ name, body: match[0] }));
    });

    // Nineteen when this test was written: fewer means that the pattern no longer finds them.
    assert.ok(helpers.length >= 19, `${helpers.length} json() helpers found: the pattern of this test is out of date`);
    // `NO_STORE` of `oauth.ts` says `no-store` and `Pragma: no-cache`.
    for (const { name, body } of helpers) assert.match(body, /'Cache-Control': 'no-store'|\.\.\.NO_STORE\b/, name);
  });
});
