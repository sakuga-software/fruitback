import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress } from './rest-connector.ts';
import { guardedLookup } from './rest-send.ts';

/**
 * A `fetch` for an address that a workspace gave (FRU-623): a self-managed GitLab, or another tracker
 * on a host of the customer. It refuses the networks of `isPublicAddress`, as a delivery does.
 *
 * WARNING: the global `fetch` resolves the name itself, so a check before it can be passed by a name
 * that answers a public address first and an internal one after. Here the socket connects to the
 * address `guardedLookup` checked. A redirect is not followed: it could lead anywhere.
 */
export type GuardedFetchSeams = {
  /** `node:https` in production. */
  request?: typeof httpsRequest;
  lookup?: typeof dnsLookup;
  allows?: (address: string) => boolean;
  /** The most bytes of an answer that are read. A longer one fails. */
  maxBytes?: number;
};

/** An answer of a tracker is a page of JSON. 8 MB holds a page of 100 issues with long descriptions. */
export const GUARDED_ANSWER_MAX_BYTES = 8 * 1024 * 1024;

export function createGuardedFetch({
  request = httpsRequest,
  lookup = dnsLookup,
  allows = isPublicAddress,
  maxBytes = GUARDED_ANSWER_MAX_BYTES,
}: GuardedFetchSeams = {}): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    // `Request` writes a body of any kind as bytes, and the boundary of a form in its type.
    const asked = new Request(url, { ...init, redirect: 'manual' });
    const body = asked.body === null ? undefined : Buffer.from(await asked.arrayBuffer());
    const literal = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) !== 0 && !allows(literal)) {
      throw new TypeError('The address resolves to a network the worker does not call');
    }
    const headers: Record<string, string> = Object.fromEntries(asked.headers);
    if (body !== undefined) headers['content-length'] = String(body.byteLength);

    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      const sent = request(url, { method: asked.method, headers, lookup: guardedLookup(lookup, allows) }, (answer) => {
        const chunks: Buffer[] = [];
        let size = 0;
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            answer.destroy();
            reject(new TypeError('The answer is too long'));

            return;
          }
          chunks.push(chunk);
        });
        answer.on('error', reject);
        answer.on('end', () => {
          const kept = new Headers();
          for (const [name, value] of Object.entries(answer.headers)) {
            if (value !== undefined) kept.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          const status = answer.statusCode ?? 502;
          // A status with no body (`204`) refuses one in `Response`.
          resolve(
            new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: kept }),
          );
        });
      });
      const abort = () => sent.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      sent.on('error', (error) => reject(signal?.aborted ? signal.reason : error));
      sent.on('close', () => signal?.removeEventListener('abort', abort));
      sent.end(body);
    });
  };
}
