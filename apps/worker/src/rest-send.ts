import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { type LookupFunction, isIP } from 'node:net';
import { type Send, isPublicAddress } from './rest-connector.ts';

/**
 * The request of a delivery, on `node:https` (FRU-122).
 *
 * WARNING: the name is checked when the socket resolves it, not before. A check before the request
 * can be passed with a name that answers a public address first and an internal one after. Here
 * the address the socket connects to is the address that was checked.
 */
export type SenderSeams = {
  /** `node:https` in production. A test gives `node:http` to reach a server it started. */
  request?: typeof httpsRequest;
  lookup?: typeof dnsLookup;
  /** Which addresses may be called. A test allows the loopback of its own server. */
  allows?: (address: string) => boolean;
  timeoutMs?: number;
};

export const DELIVERY_TIMEOUT_MS = 10_000;
/** The answer is read to its end so the socket is free, up to this many bytes. Its content is not used. */
export const ANSWER_MAX_BYTES = 64 * 1_024;

export function guardedLookup(lookup: typeof dnsLookup, allows: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, '', 0);
      const found = addresses as unknown as { address: string; family: number }[];
      const refused = found.find((each) => !allows(each.address));
      if (found.length === 0 || refused !== undefined) {
        return callback(new Error('The address resolves to a network the worker does not call'), '', 0);
      }

      // The socket takes the list when it asked for one, and one address otherwise.
      if ((options as { all?: boolean }).all === true) {
        return (callback as unknown as (error: null, addresses: typeof found) => void)(null, found);
      }

      return callback(null, (found[0] as (typeof found)[number]).address, (found[0] as (typeof found)[number]).family);
    });
  };
}

export function createSender({
  request = httpsRequest,
  lookup = dnsLookup,
  allows = isPublicAddress,
  timeoutMs = DELIVERY_TIMEOUT_MS,
}: SenderSeams = {}): Send {
  return (url, headers, body) =>
    new Promise((resolve, reject) => {
      // WARNING: a socket does not resolve an IP address, so the lookup below never sees one. An
      // address written in the URL is checked here. The console refuses one when a connector is
      // made; this is for a row that did not come through the console.
      const literal = new URL(url).hostname.replace(/^\[|\]$/g, '');
      if (isIP(literal) !== 0 && !allows(literal)) {
        reject(new Error('The address resolves to a network the worker does not call'));

        return;
      }

      const sent = request(
        url,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
          lookup: guardedLookup(lookup, allows),
          timeout: timeoutMs,
        },
        (answer) => {
          // A redirect is an answer like another: it is not followed, so it cannot lead inside.
          let read = 0;
          answer.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > ANSWER_MAX_BYTES) answer.destroy();
          });
          answer.on('close', () => resolve({ status: answer.statusCode ?? 0 }));
        },
      );
      sent.on('timeout', () => sent.destroy(new Error('The receiver did not answer in time')));
      sent.on('error', reject);
      sent.end(body);
    });
}
