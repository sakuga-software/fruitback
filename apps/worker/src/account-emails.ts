import { randomBytes } from 'node:crypto';
import { mailboxOf, normalizeEmail } from './accounts.ts';
import { type Auth, SESSION_FRESH_SECONDS } from './auth.ts';
import { type AuthRouteContext, mutationAllowed, onePersonAtATime, sessionOfCookie } from './auth-routes.ts';
import { MailError, primaryChangedMessage, verifyAddressMessage } from './mail.ts';

/**
 * The addresses of an account beside its primary one (FRU-450, step 2 of FRU-415). The decisions of
 * Mathieu, 2026-10-25:
 *
 * - **An address is proved, or it is not there.** A provider proves the one it gives as verified, at
 *   a link or at each sign-in (`noteProviderAddress` of the store). A person adds one by hand: Fruitback
 *   sends a link of verification there, which works once for `VERIFY_ADDRESS_HOURS`, in the browser
 *   where that account is signed in. An address that waits is in the table `verification`, under a
 *   digest of its token, and belongs to nobody.
 * - **An address is of one account**, as its primary address or as another one: an address of another
 *   account is refused, and the refusal does not say whose it is.
 * - **A sign-in link sent to another address opens the account** (`sendLink` of `auth-routes.ts`), and
 *   so does an invitation sent there (`auth-organization.ts`).
 * - **The primary address is the one of the notes and of the messages** (`user.email`). The person
 *   chooses it among their addresses, with a session of the last day, and both addresses get an alert.
 * - **A provider that is unlinked takes its address away**, unless Fruitback proved it too. When it
 *   alone proves the primary address, the unlink is refused until another one is primary.
 *
 * The routes: `GET /console/me/emails` lists, `POST /console/me/emails` sends the link of an address,
 * `POST /console/me/emails/verify` spends it, `POST /console/me/emails/primary` chooses the primary
 * one, `DELETE /console/me/emails/<address>` takes one away. Each takes the cookie of the console and,
 * for a change, its `Origin`.
 */

export const EMAILS_PATH = '/console/me/emails';
const VERIFY_PATH = '/console/me/emails/verify';
const PRIMARY_PATH = '/console/me/emails/primary';
const ONE_EMAIL = /^\/console\/me\/emails\/([^/]{3,762})$/;

/** How long the link of verification of an address works. */
export const VERIFY_ADDRESS_HOURS = 24;
/** How many addresses one account asks to verify in an hour, and how many links one mailbox gets in that hour. */
export const ADDRESSES_PER_HOUR = 5;
export const VERIFY_LINKS_PER_MAILBOX = 3;
const HOUR_MS = 60 * 60 * 1000;

/** A token of a link of verification: 32 random bytes, in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The key of an address that waits, in the table `verification` (digested by `auth-at-rest.ts`). */
function waitingKey(token: string): string {
  return `fruitback-email:${token}`;
}

/** What this file reads and writes through the internal adapter of better-auth. */
type VerificationAdapter = {
  createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  consumeVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  deleteVerificationByIdentifier(identifier: string): Promise<void>;
};

type AccountAdapter = {
  findMany(input: { model: 'account'; where: { field: string; value: string }[] }): Promise<{ providerId: string }[]>;
};

/**
 * The addresses of the account, with no provider that is no longer linked. An unlink whose last
 * write failed left its provider on an address (raised in review of #613): it goes here, at the next
 * read, and the address goes with it when nothing else proves it.
 */
async function addressesOf(context: AuthRouteContext, auth: Auth, account: string, now: number) {
  const rows = await context.accounts.addresses(account);
  const listed = new Set(rows.flatMap((row) => row.providers));
  if (listed.size === 0) return rows;
  const adapter = (await auth.$context).adapter as unknown as AccountAdapter;
  const linked = new Set(
    (await adapter.findMany({ model: 'account', where: [{ field: 'userId', value: account }] })).map(
      (row) => row.providerId,
    ),
  );
  const gone = [...listed].filter((provider) => !linked.has(provider));
  if (gone.length === 0) return rows;
  for (const provider of gone) await context.accounts.noteProviderAddress(account, provider, undefined, now);

  return context.accounts.addresses(account);
}

type SessionAdapter = {
  findMany(input: { model: 'session'; where: { field: string; value: string }[] }): Promise<{ createdAt: Date }[]>;
};

/** Whether this path is one of this file. */
export function isEmailRoute(pathname: string): boolean {
  return pathname === EMAILS_PATH || ONE_EMAIL.test(pathname);
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await request.text());

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** An address that waits: the account that asked, and the address. */
function readWaiting(row: { value: string; expiresAt: Date } | null, now: number) {
  if (row === null || new Date(row.expiresAt).getTime() <= now) return undefined;
  try {
    const parsed = JSON.parse(row.value) as { account?: unknown; email?: unknown };

    return typeof parsed.account === 'string' && typeof parsed.email === 'string'
      ? { account: parsed.account, email: parsed.email }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The page of the console where a person reads and changes their addresses. */
function accountPage(context: AuthRouteContext, workspace: unknown): string {
  const origin = new URL(context.consoleUrl).origin;

  return typeof workspace === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(workspace)
    ? `${origin}/w/${workspace}/account`
    : `${origin}/`;
}

/** The answer for a path of `isEmailRoute`. */
export async function handleEmailRoutes(
  request: Request,
  pathname: string,
  context: AuthRouteContext,
  headers: Record<string, string>,
  now: () => number = Date.now,
): Promise<Response> {
  const auth = await context.auth;
  const mine = await sessionOfCookie(auth, request);
  if (mine === undefined) return json(401, { error: 'identity-required' }, headers);
  if (!mutationAllowed(request, context.consoleUrl)) return json(403, { error: 'origin-not-allowed' }, headers);
  const account = await context.accounts.account(mine.userId);
  if (account === undefined) return json(401, { error: 'identity-required' }, headers);

  if (pathname === EMAILS_PATH && request.method === 'GET') {
    const rows = await addressesOf(context, auth, account.id, now());
    const primary = rows.find((row) => row.email === account.email);
    const others = rows.filter((row) => row.email !== account.email);

    return json(
      200,
      {
        // Whether this worker sends the link that adds an address.
        canAdd: context.mailer !== undefined,
        emails: [
          { email: account.email, primary: true, providers: primary?.providers ?? [], verified: true },
          ...others.map((row) => ({
            email: row.email,
            primary: false,
            providers: row.providers,
            verified: row.verified,
          })),
        ],
      },
      headers,
    );
  }

  if (pathname === EMAILS_PATH && request.method === 'POST') {
    const body = await readBody(request);
    const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : undefined;
    if (email === undefined) return json(400, { error: 'invalid-email' }, headers);
    const mailer = context.mailer;
    if (mailer === undefined) return json(404, { error: 'not-found' }, headers);
    const owner = await context.accounts.ownerOfAddress(email);
    if (owner === account.id) return json(409, { error: 'already-yours' }, headers);
    // Whose it is, nobody is told.
    if (owner !== undefined) return json(409, { error: 'email-taken' }, headers);

    // Counted before the link is made: a refusal above spends nothing.
    const asked = await context.kv.incr(`fruitback:address-adds:${account.id}`, HOUR_MS);
    if (asked > ADDRESSES_PER_HOUR) return json(429, { error: 'too-many-addresses' }, headers);
    const sent = await context.kv.incr(`fruitback:address-mail:${mailboxOf(email)}`, HOUR_MS);
    if (sent > VERIFY_LINKS_PER_MAILBOX) return json(429, { error: 'too-many-addresses' }, headers);

    const token = randomBytes(32).toString('base64url');
    const adapter = (await auth.$context).internalAdapter as unknown as VerificationAdapter;
    await adapter.createVerificationValue({
      identifier: waitingKey(token),
      value: JSON.stringify({ account: account.id, email }),
      expiresAt: new Date(now() + VERIFY_ADDRESS_HOURS * HOUR_MS),
    });
    const link = `${new URL(context.consoleUrl).origin}/verify-email#${token}`;
    try {
      await mailer.send(
        verifyAddressMessage(email, { account: account.email, link, hours: VERIFY_ADDRESS_HOURS }, account.locale),
      );
    } catch (error) {
      // No link left behind for a message that did not leave. The counts stay spent, as for a
      // sign-in link: a provider that refuses is not asked again and again.
      await adapter.deleteVerificationByIdentifier(waitingKey(token)).catch(() => undefined);
      if (!(error instanceof MailError)) throw error;
      console.error(`[fruitback] ${error.message}`);

      return json(502, { error: 'mail-unavailable' }, headers);
    }

    return json(202, { sent: true, email }, headers);
  }

  if (pathname === VERIFY_PATH) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const body = await readBody(request);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!TOKEN.test(token)) return json(400, { error: 'invalid-code' }, headers);
    const adapter = (await auth.$context).internalAdapter as unknown as VerificationAdapter;
    const spent = () => json(404, { error: 'link-spent-or-expired' }, headers);

    return onePersonAtATime(account.id, async () => {
      // Read first: the link of another account, opened here, is left for that account.
      const waiting = readWaiting(await adapter.findVerificationValue(waitingKey(token)), now());
      if (waiting === undefined || waiting.account !== account.id) return spent();
      const consumed = readWaiting(await adapter.consumeVerificationValue(waitingKey(token)), now());
      if (consumed === undefined || consumed.account !== account.id) return spent();
      const added = await context.accounts.verifyAddress(account.id, consumed.email, now());
      if (added === 'taken') return json(409, { error: 'email-taken' }, headers);

      return json(200, { email: consumed.email }, headers);
    });
  }

  if (pathname === PRIMARY_PATH) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const body = await readBody(request);
    const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : undefined;
    if (email === undefined) return json(400, { error: 'invalid-email' }, headers);
    // A session of the last day, as for an unlink: a cookie copied a week ago does not move the account.
    const sessionAdapter = (await auth.$context).adapter as unknown as SessionAdapter;
    const [session] = await sessionAdapter.findMany({
      model: 'session',
      where: [{ field: 'id', value: mine.sessionId }],
    });
    if (session === undefined || now() - new Date(session.createdAt).getTime() > SESSION_FRESH_SECONDS * 1000) {
      return json(403, { error: 'sign-in-again' }, headers);
    }

    return onePersonAtATime(account.id, async () => {
      const changed = await context.accounts.makePrimary(account.id, email, now());
      if (changed === undefined) return json(404, { error: 'not-found' }, headers);
      if (changed.before === email) return json(200, { email }, headers);
      // The extensions sign the new address from their next access token.
      await context.sessions?.readdressSessionsOf(account.id, email, now());
      await alertOfPrimary(context, { before: changed.before, after: email, locale: account.locale }, body?.workspace);

      return json(200, { email }, headers);
    });
  }

  const one = ONE_EMAIL.exec(pathname);
  if (one !== null && request.method === 'DELETE') {
    let typed: string;
    try {
      typed = decodeURIComponent(one[1] ?? '');
    } catch {
      return json(400, { error: 'invalid-email' }, headers);
    }
    const email = normalizeEmail(typed);
    if (email === undefined) return json(400, { error: 'invalid-email' }, headers);

    return onePersonAtATime(account.id, async () => {
      await addressesOf(context, auth, account.id, now());
      const removed = await context.accounts.removeAddress(account.id, email);
      if (removed === 'not-found') return json(404, { error: 'not-found' }, headers);
      if (removed === 'primary') return json(409, { error: 'primary-address' }, headers);
      if (removed === 'provider') return json(409, { error: 'provider-address' }, headers);

      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...headers } });
    });
  }

  return json(405, { error: 'method-not-allowed' }, headers);
}

/**
 * The alert of a new primary address, to the address of before and to the new one, in the language of
 * the account. A worker with no mailer sends none; a failure to send is logged, and the change stays.
 */
async function alertOfPrimary(
  context: AuthRouteContext,
  change: { before: string; after: string; locale: string | undefined },
  workspace: unknown,
): Promise<void> {
  const mailer = context.mailer;
  if (mailer === undefined) return;
  const link = accountPage(context, workspace);
  for (const to of [change.before, change.after]) {
    try {
      await mailer.send(primaryChangedMessage(to, { before: change.before, after: change.after, link }, change.locale));
    } catch (error) {
      console.error(`[fruitback] the alert of a new primary address was not sent: ${String(error)}`);
    }
  }
}
