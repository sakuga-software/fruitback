/**
 * The body of a request, read under a cap. It was in `app.ts`, for the feedback and the session
 * routes; the routes of the organization plugin read their body with it too (FRU-149).
 */

/** A note with long words and a DOM path is a few KB. 64 is generous; unbounded is an invitation. */
export const MAX_BODY_BYTES = 64 * 1_024;

/**
 * Read the body, refusing anything over the cap.
 *
 * Streamed rather than `request.text()`: a client that omits or forges `Content-Length` would
 * otherwise get the whole payload buffered in memory before being told it was too large, which
 * defeats the point of having a cap.
 */
export async function readBoundedText(request: Request): Promise<string | null> {
  const body = await readBoundedBytes(request, MAX_BODY_BYTES);

  return body === null ? null : new TextDecoder().decode(body);
}

/**
 * A body over the cap, thrown by `readJsonObject` (FRU-506). `handleConsole` of `console-routes.ts`
 * answers it `413 payload-too-large`, with `maxBytes`, as every route that reads its body here.
 */
export class BodyTooLarge extends Error {
  readonly maxBytes = MAX_BODY_BYTES;

  constructor() {
    super(`the body is over ${MAX_BODY_BYTES} bytes`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * The body as a JSON object, or `undefined` for a body that is not one: no JSON, an array, a number.
 * Read under the cap of `readBoundedText`. Over it, this throws `BodyTooLarge`: the routes of the
 * console read their body in many places, and one `catch` answers all of them.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await readBoundedText(request);
  if (text === null) throw new BodyTooLarge();

  return parseJsonObject(text);
}

/** A JSON object, or `undefined`. An array is not an object here, whatever `typeof` says. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The bytes of the body, or `null` over `maxBytes`. The cap of a picture is not the cap of a note (FRU-44). */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    size += value.byteLength;
    if (size > maxBytes) {
      // Stop pulling instead of draining the rest of the upload.
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  return concat(chunks, size);
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}
