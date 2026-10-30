import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { json } from './http.ts';

/**
 * Every JSON answer of the worker says `Cache-Control: no-store` (FRU-506). Each answer is of one
 * caller: a session, a token, a site, an operator. A shared cache must keep none of them.
 *
 * Nine of the twenty copies of `json()` in the modules of routes did not say it, `POST /session/pair`
 * and `POST /session/refresh` included, which answer tokens. Now `json()` of `http.ts` makes every
 * JSON answer. The HTTP tests check the routes of a session; this file checks the helper, and that
 * no source makes a JSON answer another way, whatever the name or the form of its function.
 */
describe('the JSON answers of the worker (FRU-506)', () => {
  it('say Cache-Control: no-store, and the headers of the caller', async () => {
    const answer = json(201, { id: 'one' }, { 'Access-Control-Allow-Origin': 'https://console.test' });

    assert.equal(answer.status, 201);
    assert.equal(answer.headers.get('Content-Type'), 'application/json');
    assert.equal(answer.headers.get('Cache-Control'), 'no-store');
    assert.equal(answer.headers.get('Access-Control-Allow-Origin'), 'https://console.test');
    assert.deepEqual(await answer.json(), { id: 'one' });
  });

  it('are made by http.ts, and by no other source of the worker', () => {
    const dir = new URL('.', import.meta.url);
    // Every source under `src/`, in a subdirectory too. `linear-stub.ts` fakes the answers of Linear
    // for the unit tests: it answers no request of the worker.
    const sources = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts') && !/\.(test|fixture)\.ts$/.test(name))
      .filter((name) => name !== 'http.ts' && name !== 'linear-stub.ts');
    // A body of JSON in a `Response`, or a function of its own named `json`, in any form.
    const own = [/new Response\(\s*JSON\.stringify\(/, /\bfunction json\s*\(/, /\b(const|let|var) json\s*=/];
    // The control: the patterns find the helper of `http.ts`, and the copy that each module had.
    const helper = readFileSync(new URL('http.ts', dir), 'utf8');
    assert.ok(own[0]?.test(helper) && own[1]?.test(helper), 'the patterns of this guard find nothing');
    assert.ok(own[2]?.test('const json = (status: number) => status;'), 'the pattern of an arrow finds nothing');
    assert.ok(sources.length > 50, `${sources.length} sources: the list of this guard is out of date`);

    // `redeemLink` of `auth-routes.ts` answers several `Set-Cookie`, which the record of headers of
    // `json()` cannot hold. Its `Headers` say `no-store` by hand, and this checks that they do.
    const byHand: Record<string, RegExp> = {
      'auth-routes.ts':
        /new Headers\(\{ 'Content-Type': 'application\/json', 'Cache-Control': 'no-store', \.\.\.headers \}\)/,
    };
    const found = sources.filter((name) => {
      const text = readFileSync(new URL(name, dir), 'utf8');
      if (byHand[name] !== undefined) return !byHand[name].test(text);

      return own.some((pattern) => pattern.test(text));
    });
    assert.deepEqual(found, []);
  });
});
