import { createHash } from 'node:crypto';

/**
 * The two checks of `fetch.ts` on what it fetched (FRU-460). Apart from the script, which downloads
 * when it is loaded, so that `published-checks.test.ts` of the worker can plant a violation.
 */

/**
 * Throws unless `bytes` hash to `digest`, the SHA-256 that GitHub computed when the asset was
 * uploaded (`sha256:<hex>`). An asset with no digest is refused: all the releases up to v0.4.0 have
 * one (measured on 2026-10-28), and GitHub computes it at each upload.
 */
export function checkDigest(name: string, bytes: Uint8Array, digest: string | null): void {
  if (digest === null || !digest.startsWith('sha256:')) {
    throw new Error(`GitHub gives no SHA-256 for ${name} (${digest}): upload the asset to its release again`);
  }
  const found = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (found !== digest) throw new Error(`${name} is ${found}, and GitHub says ${digest}`);
}

/** Throws unless every installed package carries the version asked for. */
export function checkInstalled(asked: string, installed: Record<string, string>): void {
  const mixed = Object.entries(installed).filter(([, version]) => version !== asked);
  if (mixed.length > 0) throw new Error(`npm ${asked} was asked for, and installed ${JSON.stringify(installed)}`);
}
