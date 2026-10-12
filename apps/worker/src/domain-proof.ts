import { createHash } from 'node:crypto';
import type { AccountStore } from './accounts.ts';

/**
 * The proof that a workspace owns a domain (FRU-103), by a `TXT` record of its DNS.
 *
 * A wildcard in team mode lends the session of a reviewer to every page it covers (FRU-75), and
 * nothing in a pattern tells `*.preview.acme.dev` from `*.vercel.app`. The one who can tell is the
 * DNS: only who holds the zone of a domain writes a record under it. So a workspace covers the
 * subdomains of a domain only while the record below is there.
 *
 * - **The record is `_fruitback.<domain>`, and its value names the workspace and the domain.** It is
 *   no secret: it is public in the DNS, and reading it gives nothing. Writing it is the proof.
 * - **The value is computed, not kept.** The same workspace and the same domain give the same value,
 *   so a proof that was removed from the worker is made again with the record that is still there.
 * - **A proof is of one workspace.** Another workspace gets another value for the same domain, and
 *   the record of the first proves nothing for it.
 * - **A host that is shared proves nothing for its tenants**: a tenant of `vercel.app` writes no
 *   record under `vercel.app`. A tenant that does hold the zone of its own name proves that name, and
 *   covers what is under it, which is its own.
 *
 * This file asks the DNS through the resolver it is given, and reads no clock: the caller gives `now`.
 */

/** The label of the record, under the domain: `_fruitback.acme.dev`. */
export const PROOF_LABEL = '_fruitback';

/** What the value of the record starts with, so a person who reads the zone knows what it is for. */
export const PROOF_PREFIX = 'fruitback-domain-verification=';

/** How often a proof is asked again. */
export const RECHECK_MS = 6 * 60 * 60_000;

/**
 * How long a proof holds with no answer of the DNS that confirms it. A resolver that is down must
 * not cut every team at once, and a proof that nobody can confirm must not hold for ever.
 */
export const PROOF_GRACE_MS = 72 * 60 * 60_000;

/** How long the worker waits for the DNS. */
export const RESOLVE_TIMEOUT_MS = 5_000;

/** A label of a host name: letters, digits and hyphens, as the DNS writes an international name too. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The domain a person typed, as the worker keeps it, or `undefined` when it is not one.
 *
 * A person pastes `https://*.Preview.Acme.dev/` as often as `preview.acme.dev`: the scheme, the
 * wildcard, the path and the case go. An address made of numbers, a name of one label and a name
 * that ends with a number are refused: none has a zone that somebody holds.
 */
export function readDomain(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  const typed = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/s, '')
    .replace(/^\*\./, '');
  // A port, a user, a space or a second wildcard: not the name of a zone.
  if (typed === '' || /[\s@:\\[\]*]/.test(typed)) return undefined;

  let host: string;
  try {
    // The parser of addresses writes an international name as the DNS holds it.
    host = new URL(`https://${typed}`).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/\.$/, '');
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  // `10.0.0.1` reads as four labels: no name of the DNS ends with a number.
  if (/^[0-9]+$/.test(labels.at(-1) as string)) return undefined;
  if (labels[0] === PROOF_LABEL) return undefined;

  return host;
}

/** The record a workspace writes to prove a domain. */
export function proofRecord(workspace: string, domain: string): { name: string; value: string } {
  const digest = createHash('sha256').update(`fruitback-domain\n${workspace}\n${domain}`).digest('hex').slice(0, 40);

  return { name: `${PROOF_LABEL}.${domain}`, value: `${PROOF_PREFIX}${digest}` };
}

/** Every `TXT` record of a name, each one as the pieces the DNS cut it in. It rejects as `node:dns` does. */
export type TxtResolver = (name: string) => Promise<string[][]>;

/**
 * What the DNS said of a proof.
 *
 * - `found`: the record is there.
 * - `missing`: the DNS answered, and the record is not there.
 * - `unknown`: the DNS did not answer. This says nothing of the record.
 */
export type ProofAnswer = 'found' | 'missing' | 'unknown';

/** What `node:dns` says when a name does not exist, or holds no record of the kind asked. */
const NOT_THERE = new Set(['ENOTFOUND', 'ENODATA']);

/** Asks the DNS for the proof of a domain by a workspace. It never rejects. */
export async function checkProof(
  resolve: TxtResolver,
  workspace: string,
  domain: string,
  timeoutMs: number = RESOLVE_TIMEOUT_MS,
): Promise<ProofAnswer> {
  const { name, value } = proofRecord(workspace, domain);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolve(name),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the DNS did not answer in time')), timeoutMs);
      }),
    ]);
    if (!Array.isArray(records)) return 'unknown';

    // A record longer than 255 bytes arrives in pieces. Nothing is trimmed and no case is folded: the
    // value is the one the console showed, or it is not the proof.
    return records.some((pieces) => Array.isArray(pieces) && pieces.join('') === value) ? 'found' : 'missing';
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;

    return typeof code === 'string' && NOT_THERE.has(code) ? 'missing' : 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** What a workspace holds of a domain: see `Domain` in `accounts.ts`. */
export type ProofInstants = { verifiedAt?: number; lostAt?: number };

/**
 * Where a proof stands.
 *
 * - `pending`: the DNS never showed the record.
 * - `proven`: it showed it, and nothing said it went since.
 * - `lost`: the DNS answered without it, or nothing confirmed it for `PROOF_GRACE_MS`.
 */
export type ProofState = 'pending' | 'proven' | 'lost';

export function proofState(proof: ProofInstants, now: number): ProofState {
  if (proof.verifiedAt === undefined) return 'pending';
  if (proof.lostAt !== undefined) return 'lost';

  return now - proof.verifiedAt > PROOF_GRACE_MS ? 'lost' : 'proven';
}

/**
 * The pattern of the previews of a proven domain, as the extension writes a wildcard.
 *
 * `https` only: a page served in clear can be written by anybody on the network, and a session lent
 * to it is lent to them.
 */
export function previewPattern(domain: string): string {
  return `https://*.${domain}`;
}

/** How many domains one pass asks. The next pass takes the rest. */
export const RECHECK_BATCH = 20;

/**
 * One pass over the proven domains that were not asked for `RECHECK_MS`: ask the DNS, write what it
 * said. A proof that the DNS answered without is lost from this moment, and the log says so with the
 * domain and the workspace, which are not secrets. One at a time: the DNS of a person is not a load
 * to spread.
 */
export async function recheckDomains(
  accounts: Pick<AccountStore, 'domainsToCheck' | 'noteDomainCheck'>,
  resolve: TxtResolver,
  now: number,
  limit: number = RECHECK_BATCH,
): Promise<void> {
  for (const domain of await accounts.domainsToCheck(now - RECHECK_MS, limit)) {
    const answer = await checkProof(resolve, domain.workspaceId, domain.domain);
    await accounts.noteDomainCheck(domain.id, answer, now);
    if (answer === 'missing' && domain.lostAt === undefined) {
      console.warn(
        `[fruitback] the domain ${domain.domain} of the workspace ${domain.workspaceId} lost its proof: its previews are not covered any more`,
      );
    }
  }
}

/** The resolver of the system, loaded at the first question: a worker with no domain never loads it. */
export const systemResolver: TxtResolver = async (name) => (await import('node:dns/promises')).resolveTxt(name);
