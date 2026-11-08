import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { isPublicAddress } from './rest-connector.ts';
import { guardedLookup } from './rest-send.ts';

/**
 * A `fetch` for an address that a workspace gave (FRU-623): a self-managed GitLab, or another tracker
 * on a host of the customer. It refuses the networks of `isPublicAddress`, as a delivery does.
 *
 * WARNING: the global `fetch` resolves the name itself, so a check before it can be passed by a name
 * that answers a public address first and an internal one after. Here the socket connects to the
 * address `guardedLookup` checked. A redirect is never followed: it could lead anywhere. With
 * `redirect: 'manual'` it is answered as it is; otherwise it fails, as `fetch` fails a redirect with
 * `redirect: 'error'` (review of #865).
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

/** The headers of the transfer of an answer, which no longer describe the body once it is read whole. */
const TRANSFER_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

/**
 * The body as the server meant it, for the encodings a proxy can still apply. It stops one byte past
 * `max`: a small body that unpacks into gigabytes is refused before it is in memory.
 */
function decoded(body: Buffer, encoding: string, max: number): Buffer {
  const name = encoding.trim().toLowerCase();
  const bound = { maxOutputLength: max + 1 };
  if (name === '' || name === 'identity') return body;
  if (name === 'gzip' || name === 'x-gzip') return gunzipSync(body, bound);
  if (name === 'deflate') return inflateSync(body, bound);
  if (name === 'br') return brotliDecompressSync(body, bound);
  throw new TypeError(`An answer encoded as ${name}`);
}

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
    // The bytes of an answer are read as they come: none is asked compressed (review of #865).
    headers['accept-encoding'] = 'identity';

    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      const sent = request(url, { method: asked.method, headers, lookup: guardedLookup(lookup, allows) }, (answer) => {
        const redirected =
          (answer.statusCode ?? 0) >= 300 && (answer.statusCode ?? 0) < 400 && answer.statusCode !== 304;
        if (redirected && init.redirect !== 'manual') {
          answer.destroy();
          reject(new TypeError('The answer is a redirect, which the worker does not follow'));

          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        // Set once the answer passed `maxBytes`: what still arrives is not kept, and the answer settles
        // once (review of #865).
        let cut = false;
        answer.on('data', (chunk: Buffer) => {
          if (cut) return;
          size += chunk.length;
          if (size > maxBytes) {
            cut = true;
            chunks.length = 0;
            answer.destroy();
            reject(new TypeError('The answer is too long'));

            return;
          }
          chunks.push(chunk);
        });
        answer.on('error', (error) => {
          if (!cut) reject(error);
        });
        answer.on('end', () => {
          if (cut) return;
          const kept = new Headers();
          for (const [name, value] of Object.entries(answer.headers)) {
            // The body handed on is whole and plain: the headers of its transfer would describe
            // other bytes than the ones `Response` holds.
            if (value === undefined || TRANSFER_HEADERS.has(name)) continue;
            kept.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          const status = answer.statusCode ?? 502;
          let bytes: Buffer;
          try {
            // A proxy can compress whatever was asked: the body is read back as the server meant it.
            bytes = decoded(Buffer.concat(chunks), String(answer.headers['content-encoding'] ?? ''), maxBytes);
          } catch {
            reject(new TypeError('The answer could not be decompressed'));

            return;
          }
          if (bytes.byteLength > maxBytes) {
            reject(new TypeError('The answer is too long'));

            return;
          }
          // A status with no body (`204`) refuses one in `Response`.
          resolve(new Response(status === 204 || status === 304 ? null : bytes, { status, headers: kept }));
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
