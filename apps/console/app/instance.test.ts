import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEVELOPMENT_API, apiFrom, instanceOf } from './instance.ts';

describe('the address of the worker of this instance (FRU-222)', () => {
  it('is what the container wrote when it started, before what the build holds', () => {
    assert.equal(apiFrom({ api: 'https://api.acme.dev' }, 'https://api.fruitback.com'), 'https://api.acme.dev');
    assert.equal(apiFrom({ api: ' https://api.acme.dev// ' }, undefined), 'https://api.acme.dev');
  });

  it('is the address of the build when the file sets nothing: a console built for one worker', () => {
    for (const written of [undefined, null, {}, { api: '' }, { api: '   ' }, { api: 7 }, 'https://evil.example']) {
      assert.equal(apiFrom(written, 'https://api.fruitback.com/'), 'https://api.fruitback.com');
    }
  });

  it('is the worker of pnpm dev when neither says one', () => {
    assert.equal(apiFrom(undefined, undefined), DEVELOPMENT_API);
    assert.equal(apiFrom({}, ''), DEVELOPMENT_API);
  });

  it('is read by the transport, from the file the page loads before the bundle', () => {
    const transport = readFileSync(new URL('./transport.ts', import.meta.url), 'utf8');
    const root = readFileSync(new URL('./root.tsx', import.meta.url), 'utf8');
    const written = readFileSync(new URL('../public/config.js', import.meta.url), 'utf8');

    assert.match(transport, /apiFrom\(\s*\(globalThis as \{ __FRUITBACK__\?: unknown \}\)\.__FRUITBACK__,/);
    // In `<head>`, and neither `async` nor `defer`: it must have run when the module of the bundle starts.
    assert.match(root, /<head>[\s\S]*<script src="\/config\.js"><\/script>[\s\S]*<\/head>/);
    // The file of the repository sets nothing: `pnpm dev` and a console built for one worker.
    assert.doesNotMatch(written, /__FRUITBACK__\s*=/);
  });
});

describe('the instance the console names in the frame of an administrator (FRU-262)', () => {
  it('is Fruitback Cloud for the worker of the Cloud only', () => {
    assert.deepEqual(instanceOf('https://api.fruitback.com'), { host: 'api.fruitback.com', cloud: true });
    assert.deepEqual(instanceOf('https://feedback.acme.dev'), { host: 'feedback.acme.dev', cloud: false });
    assert.deepEqual(instanceOf('https://api.fruitback.com.acme.dev'), {
      host: 'api.fruitback.com.acme.dev',
      cloud: false,
    });
    assert.deepEqual(instanceOf(DEVELOPMENT_API), { host: 'localhost:8788', cloud: false });
  });
});
