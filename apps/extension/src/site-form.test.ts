import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { complaint, siteFrom } from './site-form.ts';

describe('complaint', () => {
  it('accepts a complete entry in each mode', () => {
    assert.equal(complaint({ mode: 'private', endpoint: 'http://staging.acme.dev', clientId: 'acme' }), '');
    assert.equal(complaint({ mode: 'team', endpoint: 'https://feedback.acme.dev', clientId: '' }), '');
    assert.equal(complaint({ mode: 'team', endpoint: 'http://localhost:8788', clientId: '' }), '');
  });

  it('names the first field that is wrong', () => {
    assert.equal(complaint({ mode: 'private', endpoint: '', clientId: 'acme' }), 'The worker endpoint is required.');
    assert.equal(
      complaint({ mode: 'private', endpoint: 'javascript:alert(1)', clientId: 'acme' }),
      'The endpoint must be a full http:// or https:// URL.',
    );
    assert.equal(
      complaint({ mode: 'private', endpoint: 'https://w.test', clientId: '' }),
      'The client id is required.',
    );
    assert.equal(
      complaint({ mode: 'team', endpoint: 'http://feedback.acme.dev', clientId: '' }),
      'A team-mode worker must be on https (localhost excepted).',
    );
  });

  /**
   * An id made of spaces is an absent id (SKG-612). The worker normalizes it to empty and answers
   * `client-required`, so a file could store a rule that is On and refused on every read.
   */
  it('treats a client id made of spaces as absent', () => {
    assert.equal(
      complaint({ mode: 'private', endpoint: 'https://w.test', clientId: '   ' }),
      'The client id is required.',
    );
    assert.equal(complaint({ mode: 'private', endpoint: 'https://w.test', clientId: ' acme ' }), '');
  });
});

describe('siteFrom', () => {
  it('stores the endpoint as the widget will call it, and no client id in team mode', () => {
    assert.deepEqual(siteFrom({ mode: 'private', endpoint: 'https://w.test/fruitback/?x=1', clientId: 'acme' }, true), {
      mode: 'private',
      endpoint: 'https://w.test/fruitback',
      clientId: 'acme',
      enabled: true,
    });
    assert.deepEqual(siteFrom({ mode: 'private', endpoint: 'https://w.test', clientId: ' acme ' }, true), {
      mode: 'private',
      endpoint: 'https://w.test',
      clientId: 'acme',
      enabled: true,
    });
    assert.deepEqual(siteFrom({ mode: 'team', endpoint: 'https://w.test/', clientId: 'acme' }, false), {
      mode: 'team',
      endpoint: 'https://w.test',
      enabled: false,
    });
  });
});
