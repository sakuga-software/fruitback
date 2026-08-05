import { describe, expect, it } from 'vitest';
import { resolveClientIp } from './rate-limit';

/**
 * The rate limit is only as good as this function. Behind Traefik, `X-Forwarded-For` is appended to
 * by each proxy, so the entries on the left came from the caller and are forgeable — reading the
 * leftmost one would let anybody mint a fresh bucket per request.
 */
describe('resolveClientIp', () => {
  const SOCKET = '10.0.0.5';

  it('takes the entry the trusted proxy appended, not the one the caller sent', () => {
    const forged = '1.2.3.4';
    const real = '203.0.113.9';

    expect(resolveClientIp(`${forged}, ${real}`, SOCKET, 1)).toBe(real);
  });

  it('cannot be moved by adding entries to the chain', () => {
    const real = '203.0.113.9';

    const keys = [
      resolveClientIp(real, SOCKET, 1),
      resolveClientIp(`9.9.9.9, ${real}`, SOCKET, 1),
      resolveClientIp(`1.1.1.1, 2.2.2.2, 3.3.3.3, ${real}`, SOCKET, 1),
    ];

    expect(new Set(keys).size).toBe(1);
  });

  it('counts from the right when several proxies are trusted', () => {
    expect(resolveClientIp('1.2.3.4, 203.0.113.9, 172.16.0.1', SOCKET, 2)).toBe('203.0.113.9');
  });

  it('trims whitespace around entries', () => {
    expect(resolveClientIp('1.2.3.4 ,   203.0.113.9   ', SOCKET, 1)).toBe('203.0.113.9');
  });

  it('ignores the header entirely when no proxy is trusted', () => {
    expect(resolveClientIp('1.2.3.4', SOCKET, 0)).toBe(SOCKET);
  });

  it('falls back to the socket when the header is absent or empty', () => {
    expect(resolveClientIp(null, SOCKET, 1)).toBe(SOCKET);
    expect(resolveClientIp('', SOCKET, 1)).toBe(SOCKET);
    expect(resolveClientIp('  ,  ', SOCKET, 1)).toBe(SOCKET);
  });

  it('falls back to the socket when the chain is shorter than the trusted hops', () => {
    // The request did not arrive through the expected path, so no entry in it can be trusted.
    expect(resolveClientIp('203.0.113.9', SOCKET, 2)).toBe(SOCKET);
  });

  it('degrades to a single shared bucket rather than crashing when nothing identifies the caller', () => {
    expect(resolveClientIp(null, undefined, 1)).toBe('unknown');
  });
});
