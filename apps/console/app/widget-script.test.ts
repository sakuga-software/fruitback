import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { place, versionOf, widgetVersion } from '../widget-version.ts';
import { widgetScriptPath } from './widget-script.ts';

const console_ = new URL('..', import.meta.url).pathname;

describe('the versioned address of the widget script (FRU-106)', () => {
  it('holds the version of the package and a hash of the file', () => {
    assert.match(widgetVersion('a script', '0.2.0'), /^0\.2\.0-[0-9a-f]{12}$/);
    assert.equal(widgetVersion('a script', '0.2.0'), widgetVersion('a script', '0.2.0'));
  });

  it('changes when the file changes and the version of the package does not', () => {
    // The control: without the hash, both files would share one address that a browser keeps a year.
    assert.notEqual(widgetVersion('a script', '0.2.0'), widgetVersion('another script', '0.2.0'));
  });

  it('refuses a version of the package that a location of nginx or an address cannot hold', () => {
    for (const release of [undefined, '', '0.2.0/..', '0.2.0 x', '0.2.0;', '-0.2.0', 7]) {
      assert.throws(() => widgetVersion('a script', release), /not one the address can hold/);
    }
    assert.match(widgetVersion('a script', '1.0.0-beta.1'), /^1\.0\.0-beta\.1-[0-9a-f]{12}$/);
  });

  it('is given by the snippet when the build has one, and the address of before when it has none', () => {
    assert.equal(widgetScriptPath('0.2.0-0123456789ab'), '/v/0.2.0-0123456789ab/fruitback.iife.js');
    for (const none of [undefined, '', '  ']) assert.equal(widgetScriptPath(none), '/fruitback.iife.js');
  });
});

describe('placing the script in the build of the console (FRU-106)', () => {
  function build(bundle: (version: string) => string) {
    const root = mkdtempSync(join(tmpdir(), 'fruitback-widget-version-'));
    const script = join(root, 'fruitback.iife.js');
    const manifest = join(root, 'package.json');
    writeFileSync(script, '(()=>{})();');
    writeFileSync(manifest, JSON.stringify({ version: '0.2.0' }));
    const version = versionOf(script, manifest);
    mkdirSync(join(root, 'build', 'client', 'assets'), { recursive: true });
    writeFileSync(join(root, 'build', 'client', 'assets', 'setup.js'), bundle(version));
    writeFileSync(
      join(root, 'build', 'console.conf.template'),
      readFileSync(join(console_, 'nginx.conf.template'), 'utf8'),
    );
    return { root, script, manifest, version, out: join(root, 'build') };
  }

  it('copies the script to its versioned address and writes the version in the server', () => {
    // The bundle of Vite writes the version between backquotes.
    const { root, script, manifest, version, out } = build((v) => `const g = h(\`${v}\`);`);
    try {
      assert.equal(place(script, manifest, out), version);
      assert.equal(
        readFileSync(join(out, 'client', 'v', version, 'fruitback.iife.js'), 'utf8'),
        readFileSync(script, 'utf8'),
      );
      const server = readFileSync(join(out, 'console.conf.template'), 'utf8');
      assert.ok(!server.includes('__WIDGET_VERSION__'));
      assert.ok(server.includes(`location = /v/${version}/fruitback.iife.js {`));
      assert.ok(server.includes(`return 302 /v/${version}/fruitback.iife.js;`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops when the bundle gives no address, or the address of another file', () => {
    for (const bundle of [() => 'const src = "/fruitback.iife.js";', () => 'const version = "0.2.0-000000000000";']) {
      const { root, script, manifest, version, out } = build(bundle);
      try {
        assert.throws(() => place(script, manifest, out), /No file of the console's bundle holds the version/);
        assert.ok(!existsSync(join(out, 'client', 'v', version)));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('what the server sends with the script (FRU-106)', () => {
  const server = readFileSync(join(console_, 'nginx.conf.template'), 'utf8');
  const location = (path: string) => {
    const start = server.indexOf(`location ${path} {`);
    assert.notEqual(start, -1, `no location ${path}`);
    return server.slice(start, server.indexOf('}', start));
  };

  it('keeps the versioned script one year, without asking again', () => {
    const block = location('= /v/__WIDGET_VERSION__/fruitback.iife.js');
    assert.match(block, /Cache-Control "public, max-age=31536000, immutable" always;/);
    assert.match(block, /Access-Control-Allow-Origin \* always;/);
    assert.match(block, /X-Content-Type-Options nosniff always;/);
  });

  it('keeps the address of before, with its cache of five minutes', () => {
    const block = location('= /fruitback.iife.js');
    assert.match(block, /Cache-Control "public, max-age=300" always;/);
    assert.match(block, /Access-Control-Allow-Origin \* always;/);
  });

  it('sends another version to the script of this image, by a path, for five minutes', () => {
    const block = location('~ ^/v/[^/]+/fruitback\\.iife\\.js$');
    assert.match(block, /return 302 \/v\/__WIDGET_VERSION__\/fruitback\.iife\.js;/);
    assert.match(block, /absolute_redirect off;/);
    assert.match(block, /Cache-Control "public, max-age=300" always;/);
    assert.doesNotMatch(block, /immutable/);
  });
});
