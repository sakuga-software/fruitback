import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coversOrigin, defaultScheme, lendsSession, parseSitePattern, resolveSite } from './site-patterns.ts';
import { parseSite, type SiteConfig } from './sites.ts';

const on = (clientId: string): SiteConfig => ({
  mode: 'private',
  endpoint: 'https://worker.test',
  clientId,
  enabled: true,
});

describe('parseSitePattern', () => {
  it('keeps an exact origin as the origin', () => {
    assert.equal(parseSitePattern('https://acme.dev'), 'https://acme.dev');
    assert.equal(parseSitePattern('  HTTPS://Acme.Dev/  '), 'https://acme.dev');
    assert.equal(parseSitePattern('http://localhost:5177'), 'http://localhost:5177');
    assert.equal(parseSitePattern('https://acme.dev:443/*'), 'https://acme.dev');
  });

  it('reads a public host with no scheme as https', () => {
    assert.equal(parseSitePattern('acme.dev'), 'https://acme.dev');
    assert.equal(parseSitePattern('*.staging.acme.dev'), 'https://*.staging.acme.dev');
  });

  it('keeps a wildcard on the first label, lowercased', () => {
    assert.equal(parseSitePattern('https://*.Staging.Acme.dev'), 'https://*.staging.acme.dev');
    assert.equal(parseSitePattern('http://*.acme.test'), 'http://*.acme.test');
  });

  /** One refused match pattern would stop the scripts on every site, so these never reach the background. */
  it('refuses a wildcard on a single label or an IP address', () => {
    for (const input of [
      'http://*.localhost',
      'https://*.dev',
      'http://*.localhost.',
      'https://*.dev.',
      'http://*.127.0.0.1',
      'http://*.[::1]',
    ]) {
      assert.equal(parseSitePattern(input), undefined, input);
    }
  });

  it('refuses what a match pattern could not say, or should not', () => {
    for (const input of [
      '',
      '*',
      'https://*',
      '*.',
      'https://a.*.acme.dev',
      'https://*acme.dev',
      'https://*.acme.dev:8443',
      'https://acme.dev/review',
      'https://acme.dev?x=1',
      'https://user@acme.dev',
      'ftp://acme.dev',
      'javascript://acme.dev',
      'chrome-extension://abc',
      'https://acme dev',
    ]) {
      assert.equal(parseSitePattern(input), undefined, input);
    }
  });

  /** Every key a browser holds from before FRU-43 is an origin, and it must read back as itself. */
  it('reads every origin the popup has ever stored as itself', () => {
    for (const origin of ['https://acme.dev', 'http://localhost:5177', 'http://127.0.0.1:8080', 'http://[::1]:3000']) {
      assert.equal(parseSitePattern(origin), origin);
      assert.equal(parseSitePattern(new URL(origin).origin), origin);
    }
  });
});

/** The table `apps/console/app/site-address.test.ts` holds too: both apps read a host alike. */
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

describe('a pattern typed with no scheme (FRU-314)', () => {
  it('chooses http for a local host and https for every other, by the table of the console', () => {
    for (const [host, scheme] of SCHEMES) assert.equal(defaultScheme(host), scheme, host);
  });

  it('stores a local host the way the browser opens it', () => {
    assert.equal(parseSitePattern('localhost:5187'), 'http://localhost:5187');
    assert.equal(parseSitePattern('192.168.1.20:5173'), 'http://192.168.1.20:5173');
    assert.equal(parseSitePattern('[::1]:3000'), 'http://[::1]:3000');
    assert.equal(parseSitePattern('*.acme.local'), 'http://*.acme.local');
    assert.equal(parseSitePattern('https://localhost:5187'), 'https://localhost:5187');
  });
});

describe('coversOrigin', () => {
  it('covers the base host and every subdomain under a wildcard', () => {
    assert.equal(coversOrigin('https://*.staging.acme.dev', 'https://staging.acme.dev'), true);
    assert.equal(coversOrigin('https://*.staging.acme.dev', 'https://pr-12.staging.acme.dev'), true);
    assert.equal(coversOrigin('https://*.staging.acme.dev', 'https://a.b.staging.acme.dev'), true);
  });

  it('does not cover a host that only ends with the same letters', () => {
    assert.equal(coversOrigin('https://*.acme.dev', 'https://evilacme.dev'), false);
    assert.equal(coversOrigin('https://*.acme.dev', 'https://acme.dev.evil.test'), false);
  });

  it('does not cover another scheme or a port', () => {
    assert.equal(coversOrigin('https://*.acme.dev', 'http://staging.acme.dev'), false);
    assert.equal(coversOrigin('https://*.acme.dev', 'https://staging.acme.dev:8443'), false);
  });

  it('covers an exact origin and nothing else', () => {
    assert.equal(coversOrigin('https://acme.dev', 'https://acme.dev'), true);
    assert.equal(coversOrigin('https://acme.dev', 'https://www.acme.dev'), false);
    assert.equal(coversOrigin('http://localhost:5177', 'http://localhost:5178'), false);
  });
});

describe('resolveSite', () => {
  const sites = {
    'https://*.acme.dev': on('acme'),
    'https://*.staging.acme.dev': on('acme-staging'),
    'https://pr-7.staging.acme.dev': { ...on('acme-staging'), enabled: false },
  };

  it('answers with the exact origin before any wildcard', () => {
    assert.deepEqual(resolveSite(sites, 'https://pr-7.staging.acme.dev'), {
      pattern: 'https://pr-7.staging.acme.dev',
      site: sites['https://pr-7.staging.acme.dev'],
    });
  });

  it('answers with the longest wildcard that covers the origin', () => {
    assert.equal(resolveSite(sites, 'https://pr-8.staging.acme.dev')?.pattern, 'https://*.staging.acme.dev');
    assert.equal(resolveSite(sites, 'https://www.acme.dev')?.pattern, 'https://*.acme.dev');
  });

  /** FRU-15 on the worker, and the ticket: a site with no rule mounts nothing, and borrows no client. */
  it('answers nothing for an origin no entry covers', () => {
    assert.equal(resolveSite(sites, 'https://globex.dev'), undefined);
    assert.equal(resolveSite(sites, 'http://www.acme.dev'), undefined);
    assert.equal(resolveSite({}, 'https://acme.dev'), undefined);
  });

  it('ignores a key that is not a pattern, whatever it holds', () => {
    const stored = { 'https://*': on('everyone'), '*.acme.dev': on('unnormalized'), 'HTTPS://ACME.DEV': on('upper') };

    assert.equal(resolveSite(stored, 'https://acme.dev'), undefined);
    assert.equal(resolveSite(stored, 'https://www.acme.dev'), undefined);
  });

  /** The shape a release cannot re-run: an entry from before FRU-43, keyed by its origin. */
  /**
   * `https://*.vercel.app` is a valid pattern, and in team mode the relay answers for every page a
   * rule covers with the session of the reviewer (FRU-75).
   */
  it('answers nothing for an origin that only a team-mode wildcard covers', () => {
    const team = { mode: 'team', endpoint: 'https://worker.test', enabled: true } as const;

    assert.equal(resolveSite({ 'https://*.vercel.app': team }, 'https://somebody.vercel.app'), undefined);
    assert.ok(lendsSession('https://*.vercel.app', team));
  });

  it('still answers with a team rule that names the origin, and with a private wildcard under a team one', () => {
    const team = { mode: 'team', endpoint: 'https://worker.test', enabled: true } as const;
    const sites = {
      'https://*.staging.acme.dev': team,
      'https://*.acme.dev': on('acme'),
      'https://app.acme.dev': team,
    };

    assert.equal(resolveSite(sites, 'https://app.acme.dev')?.site.mode, 'team');
    assert.deepEqual(resolveSite(sites, 'https://pr-7.staging.acme.dev'), {
      pattern: 'https://*.acme.dev',
      site: sites['https://*.acme.dev'],
    });
    assert.equal(lendsSession('https://*.acme.dev', on('acme')), false);
    assert.equal(lendsSession('https://app.acme.dev', team), false);
  });

  it('still resolves an entry written before the patterns existed', () => {
    const legacy = parseSite({ endpoint: 'https://worker.test', clientId: 'acme', enabled: true });
    assert.ok(legacy !== undefined);

    assert.equal(resolveSite({ 'http://localhost:5177': legacy }, 'http://localhost:5177')?.site, legacy);
  });
});
