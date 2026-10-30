import type { AccountStore } from './accounts.ts';
import { readBoundedBytes } from './bounded-body.ts';

/**
 * The logo of a workspace (FRU-428): the path `/logo` of a workspace, which `handleConsoleApi` sends here.
 *
 * - `POST`, the bytes as the body and their type in `Content-Type`: the owner and the admins
 *   (`manage-workspace`) send it, over the one before. `DELETE` removes it. A suspended workspace
 *   refuses both, as every write (FRU-282).
 * - `GET`: every member reads it, whatever their role. Not a member: `404`, as the workspace.
 * - The worker keeps a PNG, a JPEG or a WebP, of `MAX_LOGO_BYTES` at most. **No SVG**: an SVG is a
 *   document that runs scripts, and the worker has no sanitizer it can trust. No GIF either.
 * - The worker checks the bytes, never the word of the sender: the first bytes say the type, and the
 *   header of the image says its size, `MAX_LOGO_SIDE` pixels at most on each side. Nothing is
 *   decoded and nothing is resized: the console shows it at a fixed size.
 * - The read answers the type that the worker checked, `nosniff`, and a `Content-Security-Policy`
 *   that runs nothing (`sandbox`), so that no browser reads the bytes as anything else.
 *
 * The address that the console reads is `logoPath` of `console-api.ts`, where every path of a
 * workspace is written: its `?v=` changes with each logo, so that a browser that keeps the one before
 * asks for the new one.
 */

export const MAX_LOGO_BYTES = 512 * 1_024;

/** The most pixels of one side. A PNG of 512 KB can say 30000 × 30000: the browser would decode it. */
export const MAX_LOGO_SIDE = 4_096;

/** The types of a logo, in the order the errors list them. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type LogoType = (typeof LOGO_TYPES)[number];

export type CheckedLogo =
  | { ok: true; type: LogoType; width: number; height: number }
  | { ok: false; error: 'unsupported-type' | 'empty-file' | 'type-mismatch' | 'image-too-large' };

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.byteLength >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);

const be16 = (bytes: Uint8Array, at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const be32 = (bytes: Uint8Array, at: number): number => be16(bytes, at) * 0x1_00_00 + be16(bytes, at + 2);
const le16 = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const le24 = (bytes: Uint8Array, at: number): number => le16(bytes, at) | ((bytes[at + 2] ?? 0) << 16);

type Size = { width: number; height: number };

/** The size in the `IHDR` chunk, which the PNG format puts first. */
function pngSize(bytes: Uint8Array): Size | undefined {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return undefined;
  if (!startsWith(bytes, ascii('IHDR'), 12) || bytes.byteLength < 24) return undefined;

  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

/** The size in the first frame header (`SOFn`), after the segments before it. */
function jpegSize(bytes: Uint8Array): Size | undefined {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return undefined;
  let at = 2;
  while (at + 3 < bytes.byteLength) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    // A fill byte, or a marker with no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), which are no frame.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.byteLength) return undefined;

      return { height: be16(bytes, at + 5), width: be16(bytes, at + 7) };
    }
    // The scan starts, or the image ends, with no frame before: not a JPEG the worker reads.
    if (marker === 0xda || marker === 0xd9) return undefined;
    at += 2 + be16(bytes, at + 2);
  }

  return undefined;
}

/** The size in the first chunk of a WebP: `VP8 ` (lossy), `VP8L` (lossless) or `VP8X` (extended). */
function webpSize(bytes: Uint8Array): Size | undefined {
  if (!startsWith(bytes, ascii('RIFF')) || !startsWith(bytes, ascii('WEBP'), 8)) return undefined;
  if (startsWith(bytes, ascii('VP8 '), 12)) {
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23) || bytes.byteLength < 30) return undefined;

    return { width: le16(bytes, 26) & 0x3f_ff, height: le16(bytes, 28) & 0x3f_ff };
  }
  if (startsWith(bytes, ascii('VP8L'), 12)) {
    if (bytes[20] !== 0x2f || bytes.byteLength < 25) return undefined;
    const [b0, b1, b2, b3] = [bytes[21] ?? 0, bytes[22] ?? 0, bytes[23] ?? 0, bytes[24] ?? 0];

    return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) };
  }
  if (startsWith(bytes, ascii('VP8X'), 12)) {
    if (bytes.byteLength < 30) return undefined;

    return { width: 1 + le24(bytes, 24), height: 1 + le24(bytes, 27) };
  }

  return undefined;
}

const SIZE_OF: Readonly<Record<LogoType, (bytes: Uint8Array) => Size | undefined>> = {
  'image/png': pngSize,
  'image/jpeg': jpegSize,
  'image/webp': webpSize,
};

/** The type of `Content-Type` with no parameter, in lower case, when it is the type of a logo. */
export function logoTypeOf(declared: string | null): LogoType | undefined {
  const bare = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  return (LOGO_TYPES as readonly string[]).includes(bare) ? (bare as LogoType) : undefined;
}

/**
 * What the worker keeps of a logo, from its bytes and the type the sender declared:
 *
 * - `unsupported-type`: the type is none of `LOGO_TYPES`, an SVG and a GIF among them.
 * - `empty-file`: no byte.
 * - `type-mismatch`: the bytes do not start as the type says, or their header says no size.
 * - `image-too-large`: a side is over `MAX_LOGO_SIDE` pixels.
 */
export function checkLogo(declared: string | null, bytes: Uint8Array): CheckedLogo {
  const type = logoTypeOf(declared);
  if (type === undefined) return { ok: false, error: 'unsupported-type' };
  if (bytes.byteLength === 0) return { ok: false, error: 'empty-file' };
  const size = SIZE_OF[type](bytes);
  if (size === undefined || size.width < 1 || size.height < 1) return { ok: false, error: 'type-mismatch' };
  if (size.width > MAX_LOGO_SIDE || size.height > MAX_LOGO_SIDE) return { ok: false, error: 'image-too-large' };

  return { ok: true, type, ...size };
}

/** What the route of the logo needs of `handleConsoleApi`, for one request. */
export type LogoSeams = {
  accounts: Pick<AccountStore, 'logo' | 'setLogo' | 'removeLogo'>;
  workspace: string;
  /** Whether the person of the request may change the logo: `manage-workspace`. */
  manages: boolean;
  forbidden: () => Response;
  /** The address of the logo sent at `updatedAt`: `logoPath` of `console-api.ts`. */
  addressAt: (updatedAt: number) => string;
  headers: Record<string, string>;
  now: number;
};

/** The path `/logo` of a workspace, for a member of it: see the top of this file. */
export async function handleLogo(request: Request, seams: LogoSeams): Promise<Response> {
  const { accounts, workspace, headers } = seams;

  if (request.method === 'GET') {
    const logo = await accounts.logo(workspace);
    if (logo === undefined) return json(404, { error: 'not-found' }, headers);

    return new Response(logo.content, {
      status: 200,
      headers: {
        ...headers,
        // The type the worker checked when it kept the bytes, never another.
        'Content-Type': logo.type,
        'Content-Length': String(logo.content.byteLength),
        'X-Content-Type-Options': 'nosniff',
        // Nothing runs in it, should a browser open it as a document.
        'Content-Security-Policy': "default-src 'none'; sandbox",
        // The console reads it with `<img>`, from its own site, with the cookie of its session.
        'Cross-Origin-Resource-Policy': 'same-site',
        // A member's own browser keeps it: the address changes with each logo (`?v=`).
        'Cache-Control': 'private, max-age=86400',
      },
    });
  }

  if (request.method !== 'POST' && request.method !== 'DELETE')
    return json(405, { error: 'method-not-allowed' }, headers);
  if (!seams.manages) return seams.forbidden();

  if (request.method === 'DELETE') {
    await accounts.removeLogo(workspace);

    return json(200, { logo: null }, headers);
  }

  // The type before the bytes: a type that is no logo costs no read. `callerOf` already refused a
  // write with no `Origin` of the console, and a type that is no form's asks a browser for a preflight.
  if (logoTypeOf(request.headers.get('Content-Type')) === undefined)
    return json(415, { error: 'unsupported-type', types: LOGO_TYPES }, headers);
  const body = await readBoundedBytes(request, MAX_LOGO_BYTES);
  if (body === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_LOGO_BYTES }, headers);
  const checked = checkLogo(request.headers.get('Content-Type'), body);
  if (!checked.ok) {
    return json(
      checked.error === 'unsupported-type' ? 415 : 400,
      checked.error === 'image-too-large' ? { error: checked.error, maxSide: MAX_LOGO_SIDE } : { error: checked.error },
      headers,
    );
  }
  await accounts.setLogo(workspace, { type: checked.type, content: body, updatedAt: seams.now });

  return json(200, { logo: seams.addressAt(seams.now) }, headers);
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
