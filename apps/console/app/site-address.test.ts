import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultScheme, siteAddress, siteLabel } from './site-address.ts';

/** The table `apps/extension/src/site-patterns.test.ts` holds too: both apps read a host alike. */
const SCHEMES: ReadonlyArray<readonly [string, 'http' | 'https']> = [
  ['localhost:5187', 'http'],
  ['LOCALHOST', 'http'],
  ['shop.localhost:3000', 'http'],
  ['127.0.0.1:8080', 'http'],
  ['127.12.0.9', 'http'],
  ['[::1]:5177', 'http'],
  ['10.0.4.2', 'http'],
  ['172.16.0.1', 'http'],
  ['172.31.255.254:8443', 'http'],
  ['192.168.1.20:5173', 'http'],
  ['staging.local', 'http'],
  ['*.acme.local', 'http'],
  ['staging.acme.dev', 'https'],
  ['172.15.0.1', 'https'],
  ['172.32.0.1', 'https'],
  ['192.169.0.1', 'https'],
  ['11.0.0.1', 'https'],
  ['localhost.acme.dev', 'https'],
  ['local.acme.dev', 'https'],
  ['[2001:db8::1]', 'https'],
];

describe('the address of a site, as somebody types it (FRU-167)', () => {
  it('reads a host with no scheme as https, unless it is local (FRU-314)', () => {
    assert.equal(siteAddress('staging.acme.dev'), 'https://staging.acme.dev');
    assert.equal(siteAddress('  staging.acme.dev/fr/produits  '), 'https://staging.acme.dev/fr/produits');
    assert.equal(siteAddress('localhost:5187'), 'http://localhost:5187');
    assert.equal(siteAddress('192.168.1.20:5173/page'), 'http://192.168.1.20:5173/page');
  });

  it('chooses the scheme of a local host by one table (FRU-314)', () => {
    for (const [host, scheme] of SCHEMES) assert.equal(defaultScheme(host), scheme, host);
  });

  it('keeps an address that has its scheme as it was typed', () => {
    assert.equal(siteAddress('http://localhost:5177'), 'http://localhost:5177');
    assert.equal(siteAddress('https://localhost:5177'), 'https://localhost:5177');
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

describe('a site as the console writes it (FRU-314)', () => {
  it('keeps the scheme, so two sites that differ by it alone read as two', () => {
    assert.equal(siteLabel('http://localhost:5187'), 'http://localhost:5187');
    assert.equal(siteLabel('https://localhost:5187'), 'https://localhost:5187');
    assert.notEqual(siteLabel('http://localhost:5187'), siteLabel('https://localhost:5187'));
    assert.equal(siteLabel('https://Staging.Acme.dev:443'), 'https://staging.acme.dev');
  });

  it('writes what is not an origin as it came', () => {
    assert.equal(siteLabel('not an origin'), 'not an origin');
  });
});
