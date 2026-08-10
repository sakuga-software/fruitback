import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DEFAULT_PLAYGROUND_PORT, createPlaygroundServer, readPlaygroundPort } from './server.ts';

/**
 * These run in CI for one reason above the others: bundling `client.ts` is a real esbuild build, so
 * a broken import or a symbol the widget stopped exporting fails here — in a two-second unit test —
 * rather than as a blank page in front of whoever opened the playground.
 */

let origin = '';
const server = createPlaygroundServer({ workerOrigin: 'http://worker.test:9999' });

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('the playground server', () => {
  it('serves the page with the worker origin injected', async () => {
    const response = await fetch(`${origin}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.ok(html.includes("workerOrigin: 'http://worker.test:9999'"), 'the worker origin was not injected');
    assert.ok(!html.includes('%WORKER_ORIGIN%'), 'the placeholder was left in the page');
  });

  it('keeps the hostile markup the anchors are meant to survive', async () => {
    const html = await (await fetch(`${origin}/`)).text();

    for (const trap of ['data-testid="card-latte"', 'id=":r7:"', 'css-1x9f7ab', 'button_3f2a1b']) {
      assert.ok(html.includes(trap), `the page lost ${trap}, and with it the case it was there to cover`);
    }
  });

  it('bundles the client, widget and all', async () => {
    const response = await fetch(`${origin}/client.js`);
    const source = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type') ?? '', /javascript/);
    // Proof the bundle really pulled the widget in rather than shipping an empty IIFE.
    assert.ok(source.includes('fruitback.seed'), 'the seed contract is missing from the bundle');
    assert.ok(source.includes('fb-toolbar'), 'the harness UI is missing from the bundle');
  });

  it('404s anything else', async () => {
    assert.equal((await fetch(`${origin}/nope`)).status, 404);
  });
});

describe('readPlaygroundPort', () => {
  it('takes a port when given one', () => {
    assert.equal(readPlaygroundPort('4321'), 4321);
  });

  it('falls back rather than handing `listen` a NaN and dying on boot', () => {
    for (const value of [undefined, '', 'eighty-eighty', '0', '-1', '12.5']) {
      assert.equal(readPlaygroundPort(value), DEFAULT_PLAYGROUND_PORT, `${String(value)} should fall back`);
    }
  });
});
