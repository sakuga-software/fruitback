import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIRING_LINK_PROBLEM,
  PAIR_PATH_PROBLEM,
  WILDCARD_TEAM_PROBLEM,
  complaint,
  pairingFragment,
  pairingLinkIn,
  siteFrom,
} from './site-form.ts';
import type { PairLink } from './pair-link.ts';

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

describe('a pairing link where the worker goes (FRU-395)', () => {
  const rule = (endpoint: string) =>
    complaint({ mode: 'private', endpoint, clientId: 'fruitback' }, 'https://app.fruitback.test');

  it('refuses an address that ends in /pair, or that carries a fragment', () => {
    assert.equal(rule('https://api.fruitback.com/pair'), PAIR_PATH_PROBLEM);
    assert.equal(rule('https://api.fruitback.com/pair/'), PAIR_PATH_PROBLEM);
    assert.equal(rule('https://api.fruitback.com/pair#abc'), PAIR_PATH_PROBLEM);
    assert.equal(rule('https://api.fruitback.com/#abc'), PAIR_PATH_PROBLEM);
    assert.equal(
      complaint(
        { mode: 'team', endpoint: 'https://api.fruitback.com/pair', clientId: '' },
        'https://app.fruitback.test',
      ),
      PAIR_PATH_PROBLEM,
    );
  });

  it('offers to pair with a whole link, at the worker before /pair', () => {
    assert.equal(rule('https://example.com/fruitback/pair#ABCD-EFGH-JKLM'), PAIRING_LINK_PROBLEM);
    const link = pairingLinkIn('https://example.com/fruitback/pair#ABCD-EFGH-JKLM') as PairLink;
    assert.deepEqual(link, { endpoint: 'https://example.com/fruitback', code: 'ABCD-EFGH-JKLM' });
    assert.equal(pairingFragment(link), '#workers?worker=https%3A%2F%2Fexample.com%2Ffruitback&code=ABCD-EFGH-JKLM');
  });

  it('accepts a worker behind a path, and a path that only starts like it', () => {
    assert.equal(rule('https://example.com/fruitback'), '');
    assert.equal(rule('https://example.com/pairs'), '');
    assert.equal(rule('https://pair.example.com'), '');
  });
});
