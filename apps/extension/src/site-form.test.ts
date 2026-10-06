import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WILDCARD_TEAM_PROBLEM, complaint, siteFrom } from './site-form.ts';

const ORIGIN = 'https://acme.dev';

describe('complaint', () => {
  it('accepts a complete entry in each mode', () => {
    assert.equal(complaint({ mode: 'private', endpoint: 'http://staging.acme.dev', clientId: 'acme' }, ORIGIN), '');
    assert.equal(complaint({ mode: 'team', endpoint: 'https://feedback.acme.dev', clientId: '' }, ORIGIN), '');
    assert.equal(complaint({ mode: 'team', endpoint: 'http://localhost:8788', clientId: '' }, ORIGIN), '');
  });

  it('names the first field that is wrong', () => {
    assert.equal(
      complaint({ mode: 'private', endpoint: '', clientId: 'acme' }, ORIGIN),
      'The worker endpoint is required.',
    );
    assert.equal(
      complaint({ mode: 'private', endpoint: 'javascript:alert(1)', clientId: 'acme' }, ORIGIN),
      'The endpoint must be a full http:// or https:// URL.',
    );
    assert.equal(
      complaint({ mode: 'private', endpoint: 'https://w.test', clientId: '' }, ORIGIN),
      'The client id is required.',
    );
    assert.equal(
      complaint({ mode: 'team', endpoint: 'http://feedback.acme.dev', clientId: '' }, ORIGIN),
      'A team-mode worker must be on https (localhost excepted).',
    );
  });

  /**
   * An id made of spaces is an absent id (FRU-73). The worker normalizes it to empty and answers
   * `client-required`, so a file could store a rule that is On and refused on every read.
   */
  it('treats a client id made of spaces as absent', () => {
    assert.equal(
      complaint({ mode: 'private', endpoint: 'https://w.test', clientId: '   ' }, ORIGIN),
      'The client id is required.',
    );
    assert.equal(complaint({ mode: 'private', endpoint: 'https://w.test', clientId: ' acme ' }, ORIGIN), '');
  });
});

describe('a wildcard in team mode (FRU-75)', () => {
  const team = { mode: 'team', endpoint: 'https://feedback.acme.dev', clientId: '' } as const;

  it('is refused, because it lends the session to every site it covers', () => {
    assert.equal(complaint(team, 'https://*.vercel.app'), WILDCARD_TEAM_PROBLEM);
    assert.equal(complaint(team, 'https://*.staging.acme.dev'), WILDCARD_TEAM_PROBLEM);
  });

  it('is still accepted in private mode, which carries no credential', () => {
    assert.equal(
      complaint({ mode: 'private', endpoint: 'https://w.test', clientId: 'acme' }, 'https://*.staging.acme.dev'),
      '',
    );
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
