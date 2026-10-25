import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API, logoSource } from './api.ts';
import { LOGO_PROBLEMS, logoRefusal } from './workspace-logo.ts';

describe('the logo of a workspace (FRU-428)', () => {
  it('is refused before it is sent when its type is not PNG, JPEG or WebP, or it is over 512 KB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp'])
      assert.equal(logoRefusal({ type, size: 1_000 }), undefined);
    for (const type of ['image/svg+xml', 'image/gif', 'text/html', ''])
      assert.equal(logoRefusal({ type, size: 1_000 }), 'Choose a PNG, JPEG or WebP image. SVG is not accepted.', type);
    assert.equal(logoRefusal({ type: 'image/png', size: 512 * 1_024 }), undefined);
    assert.equal(
      logoRefusal({ type: 'image/png', size: 512 * 1_024 + 1 }),
      'The image is over 512 KB. Choose a smaller one.',
    );
  });

  it('says each refusal of the worker in its own words', () => {
    assert.deepEqual(Object.keys(LOGO_PROBLEMS).sort(), [
      'empty-file',
      'forbidden',
      'image-too-large',
      'payload-too-large',
      'type-mismatch',
      'unsupported-type',
    ]);
  });

  it('is read from the address of the worker, and from nothing else', () => {
    assert.equal(logoSource({ logo: '/console/workspaces/w1/logo?v=1' }), `${API}/console/workspaces/w1/logo?v=1`);
    for (const logo of [null, undefined, 'https://evil.example/x.png', '//evil.example/x.png', 'javascript:alert(1)'])
      assert.equal(logoSource({ logo }), undefined, String(logo));
  });
});
