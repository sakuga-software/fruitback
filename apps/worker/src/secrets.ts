import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The key of a connector, encrypted at rest (FRU-121).
 *
 * A workspace hands the worker the API key of its tracker. A copy of the accounts file must not be a
 * set of working keys, so the file holds the ciphertext and `FRUITBACK_SECRETS_KEY` stays in the
 * environment. AES-256-GCM: a value somebody changed in the file does not decrypt.
 *
 * WARNING: a digest is not possible here, unlike a pairing code. The worker must send the key itself
 * to the tracker on every call.
 */
const VERSION = 'v1';

function keyOf(secret: string): Buffer {
  return createHash('sha256').update(`fruitback-connector-secrets:${secret}`).digest();
}

export function seal(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

/** The plain value, or `undefined` for a value this key does not open. Never throws. */
export function open(sealed: string, secret: string): string | undefined {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || iv === undefined || tag === undefined || body === undefined) return undefined;

  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
