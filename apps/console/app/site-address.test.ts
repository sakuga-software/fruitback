import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { siteAddress } from './site-address.ts';

describe('the address of a site, as somebody types it (FRU-167)', () => {
  it('reads a host with no scheme as https, like the extension', () => {
    assert.equal(siteAddress('staging.acme.dev'), 'https://staging.acme.dev');
    assert.equal(siteAddress('  staging.acme.dev/fr/produits  '), 'https://staging.acme.dev/fr/produits');
    assert.equal(siteAddress('localhost:5177'), 'https://localhost:5177');
  });

  it('keeps an address that has its scheme as it was typed', () => {
    assert.equal(siteAddress('http://localhost:5177'), 'http://localhost:5177');
    assert.equal(siteAddress('https://staging.acme.dev/page?x=1'), 'https://staging.acme.dev/page?x=1');
    assert.equal(siteAddress('HTTPS://Staging.Acme.dev'), 'HTTPS://Staging.Acme.dev');
  });

  it('answers nothing for what is not an address, so the screen says its own sentence', () => {
    assert.equal(siteAddress('pas une adresse'), undefined);
    assert.equal(siteAddress(''), undefined);
    assert.equal(siteAddress('   '), undefined);
    assert.equal(siteAddress('staging'), undefined);
    assert.equal(siteAddress('ftp://exemple.fr'), undefined);
    assert.equal(siteAddress('mailto:ana@acme.dev'), undefined);
    assert.equal(siteAddress('https://'), undefined);
  });
});
