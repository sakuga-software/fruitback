import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { closeSessionConnections } from './session-sqlite.ts';
import { type RequestContext, handleRequest } from './app.ts';
import { MailError, type MailMessage, type Mailer, createTemMailer, signInMessage } from './mail.ts';
import { EMAIL_LINKS_PER_WINDOW, readSessionCookie } from './console-routes.ts';
import { verifyIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const CONSOLE = 'https://app.fruitback.test';
const directories: string[] = [];

afterEach(() => {
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-console-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: CONSOLE,
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
    FRUITBACK_CONSOLE_URL: CONSOLE,
    ...overrides,
  };
}

/** A mailer that keeps what it was asked to send, or fails when told to. */
function inbox(fail = false): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];

  return {
    sent,
    async send(message) {
      if (fail) throw new MailError('refused: 401');
      sent.push(message);
    },
  };
}

let ip = 0;
function call(
  env: WorkerEnv,
  path: string,
  options: { body?: unknown; origin?: string | null; cookie?: string; method?: string },
  context: Partial<RequestContext> = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers.Origin = options.origin ?? CONSOLE;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  ip += 1;

  return handleRequest(
    new Request(`https://api.fruitback.test${path}`, {
      method: options.method ?? 'POST',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    env,
    // A fresh Kv unless a case shares one: the limit per address is what the process Kv would carry over.
    { clientIp: `203.0.113.${ip % 250}`, kv: createMemoryKv(), ...context },
  );
}

/** The code at the end of the link the last message carried. */
function codeIn(mail: MailMessage | undefined): string {
  const match = /\/sign-in#([A-Za-z0-9_-]+)/.exec(mail?.text ?? '');
  assert.ok(match, `no link in ${mail?.text}`);

  return match[1] as string;
}

function cookieOf(response: Response): string {
  const header = response.headers.get('Set-Cookie') ?? '';

  return header.split(';')[0] as string;
}

describe('signing in by a link (FRU-98)', () => {
  it('sends a link to the console, with the code after the #, and answers 202', async () => {
    const env = envWith();
    const mail = inbox();
    const response = await call(env, '/auth/email', { body: { email: ' Alice@Acme.dev ' } }, { mailer: mail });

    assert.equal(response.status, 202);
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0]?.to, 'alice@acme.dev');
    assert.match(mail.sent[0]?.text ?? '', new RegExp(`^${CONSOLE}/sign-in#[A-Za-z0-9_-]{43}$`, 'm'));
  });

  it('opens a session for the account the link proves, once', async () => {
    const env = envWith();
    const mail = inbox();
    await call(env, '/auth/email', { body: { email: 'alice@acme.dev' } }, { mailer: mail });
    const code = codeIn(mail.sent[0]);

    const opened = await call(env, '/auth/email/redeem', { body: { code } });
    assert.equal(opened.status, 200);
    const body = (await opened.json()) as { accessToken: string; account: { id: string; email: string } };
    assert.equal(body.account.email, 'alice@acme.dev');

    const verified = await verifyIdentityToken(body.accessToken, SECRET);
    assert.ok(verified.ok);
    assert.equal(verified.reporter.id, body.account.id);
    assert.equal(verified.workspace, undefined, 'a console session names no workspace');

    const cookie = opened.headers.get('Set-Cookie') ?? '';
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/console/session']) {
      assert.ok(cookie.includes(attribute), `the cookie must be ${attribute}: ${cookie}`);
    }

    assert.equal((await call(env, '/auth/email/redeem', { body: { code } })).status, 401, 'a link works once');
    const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
    assert.equal((await accounts.account(body.account.id))?.email, 'alice@acme.dev');
  });

  it('refuses a link after its fifteen minutes', async () => {
    const env = envWith();
    const mail = inbox();
    await call(env, '/auth/email', { body: { email: 'alice@acme.dev' } }, { mailer: mail });
    const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
    const { digest } = await import('./session.ts');

    assert.equal(
      await accounts.spendEmailLink(await digest(codeIn(mail.sent[0])), Date.now() + 16 * 60 * 1000),
      undefined,
    );
  });

  it('refuses an address that is not one, and sends nothing', async () => {
    const mail = inbox();
    const response = await call(envWith(), '/auth/email', { body: { email: 'alice' } }, { mailer: mail });

    assert.equal(response.status, 400);
    assert.equal(mail.sent.length, 0);
  });

  it('sends a few links to one address, then refuses', async () => {
    const env = envWith();
    const mail = inbox();
    const kv = createMemoryKv();
    for (let index = 0; index < EMAIL_LINKS_PER_WINDOW; index += 1) {
      assert.equal(
        (await call(env, '/auth/email', { body: { email: 'alice@acme.dev' } }, { mailer: mail, kv })).status,
        202,
      );
    }

    assert.equal(
      (await call(env, '/auth/email', { body: { email: 'alice@acme.dev' } }, { mailer: mail, kv })).status,
      429,
    );
    assert.equal(mail.sent.length, EMAIL_LINKS_PER_WINDOW);
    assert.equal(
      (await call(env, '/auth/email', { body: { email: 'bob@acme.dev' } }, { mailer: mail, kv })).status,
      202,
    );
  });

  it('says the mail is down rather than that it was sent', async () => {
    const response = await call(
      envWith(),
      '/auth/email',
      { body: { email: 'alice@acme.dev' } },
      { mailer: inbox(true) },
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'mail-unavailable' });
  });

  it('does not exist on a worker that sends no e-mail', async () => {
    assert.equal((await call(envWith(), '/auth/email', { body: { email: 'alice@acme.dev' } })).status, 404);
  });
});

describe('the console session (FRU-98)', () => {
  async function signedIn(env: WorkerEnv): Promise<Response> {
    const mail = inbox();
    await call(env, '/auth/email', { body: { email: 'alice@acme.dev' } }, { mailer: mail });

    return call(env, '/auth/email/redeem', { body: { code: codeIn(mail.sent[0]) } });
  }

  it('refreshes from the cookie, and hands back a new one', async () => {
    const env = envWith();
    const first = cookieOf(await signedIn(env));

    const refreshed = await call(env, '/console/session/refresh', { cookie: first });
    assert.equal(refreshed.status, 200);
    assert.ok(((await refreshed.json()) as { accessToken: string }).accessToken.length > 0);
    const second = cookieOf(refreshed);
    assert.notEqual(second, first, 'every refresh rotates');
    assert.equal((await call(env, '/console/session/refresh', { cookie: second })).status, 200);
  });

  it('refuses a refresh with no cookie', async () => {
    assert.equal((await call(envWith(), '/console/session/refresh', {})).status, 401);
  });

  it('logs out on the worker, and the cookie no longer refreshes', async () => {
    const env = envWith();
    const cookie = cookieOf(await signedIn(env));

    const out = await call(env, '/console/session/logout', { cookie });
    assert.equal(out.status, 204);
    assert.match(out.headers.get('Set-Cookie') ?? '', /Max-Age=0/);
    assert.equal((await call(env, '/console/session/refresh', { cookie })).status, 401);
  });

  it('reads its cookie among others', () => {
    const request = new Request('https://api.test', { headers: { Cookie: 'a=1; fruitback_console=tok.en; b=2' } });

    assert.equal(readSessionCookie(request), 'tok.en');
    assert.equal(readSessionCookie(new Request('https://api.test')), undefined);
  });
});

describe('who the console routes answer', () => {
  it('answers the console with credentials, and refuses every other origin', async () => {
    const env = envWith();

    const fromConsole = await call(env, '/console/session/refresh', { origin: CONSOLE, method: 'OPTIONS' });
    assert.equal(fromConsole.status, 204);
    assert.equal(fromConsole.headers.get('Access-Control-Allow-Credentials'), 'true');
    assert.equal(fromConsole.headers.get('Access-Control-Allow-Origin'), CONSOLE);

    assert.equal((await call(env, '/console/session/refresh', { origin: 'https://evil.test' })).status, 403);
    assert.equal(
      (await call(env, '/auth/email/redeem', { origin: 'https://evil.test', body: { code: 'x' } })).status,
      403,
    );
  });

  it('does not exist on a worker with no accounts', async () => {
    const response = await call(
      envWith({ FRUITBACK_ACCOUNTS_PATH: undefined, FRUITBACK_CONSOLE_URL: undefined, ALLOWED_ORIGINS: '*' }),
      '/auth/email/redeem',
      { body: { code: 'x' } },
    );

    assert.equal(response.status, 404);
  });
});

describe('the configuration of a worker with accounts (FRU-98)', () => {
  it('needs the console address, over https or on localhost', () => {
    const none = readConfig(envWith({ FRUITBACK_CONSOLE_URL: undefined }));
    assert.ok(none.ok === false && none.missing.some((name) => name.startsWith('FRUITBACK_CONSOLE_URL')));

    const plain = readConfig(envWith({ FRUITBACK_CONSOLE_URL: 'http://app.fruitback.test' }));
    assert.ok(plain.ok === false && plain.missing.some((name) => name.startsWith('FRUITBACK_CONSOLE_URL')));

    const local = readConfig(envWith({ FRUITBACK_CONSOLE_URL: 'http://localhost:5178/' }));
    assert.ok(local.ok);
    assert.equal(local.config.consoleUrl, 'http://localhost:5178');
  });

  it('takes both mail settings or neither', () => {
    const half = readConfig(envWith({ FRUITBACK_MAIL_FROM: 'hello@mail.fruitback.com' }));
    assert.ok(half.ok === false && half.missing.some((name) => name.includes('FRUITBACK_SCALEWAY_TEM')));

    const malformed = readConfig(
      envWith({ FRUITBACK_MAIL_FROM: 'hello@mail.fruitback.com', FRUITBACK_SCALEWAY_TEM: 'nocolon' }),
    );
    assert.equal(malformed.ok, false);

    const both = readConfig(
      envWith({ FRUITBACK_MAIL_FROM: 'hello@mail.fruitback.com', FRUITBACK_SCALEWAY_TEM: 'proj:secret' }),
    );
    assert.ok(both.ok);
    assert.deepEqual(both.config.mail, { projectId: 'proj', secretKey: 'secret', from: 'hello@mail.fruitback.com' });
  });
});

describe('the Scaleway mailer', () => {
  it('posts one message to the API of its region, with the key in a header and the project in the body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = createTemMailer(
      { projectId: 'proj', secretKey: 'secret', from: 'hello@mail.fruitback.com' },
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init });

        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    );

    await mailer.send(signInMessage('alice@acme.dev', 'https://app.test/sign-in#abc', 15));

    assert.equal(calls[0]?.url, 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails');
    assert.equal((calls[0]?.init.headers as Record<string, string>)['X-Auth-Token'], 'secret');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body.project_id, 'proj');
    assert.deepEqual(body.to, [{ email: 'alice@acme.dev' }]);
    assert.deepEqual(body.from, { email: 'hello@mail.fruitback.com', name: 'Fruitback' });
  });

  it('throws a MailError on a refusal and on a provider that does not answer', async () => {
    const refusing = createTemMailer(
      { projectId: 'p', secretKey: 's', from: 'a@b.c' },
      (async () => new Response('{}', { status: 401 })) as typeof fetch,
    );
    await assert.rejects(refusing.send(signInMessage('a@b.c', 'https://x', 15)), MailError);

    const silent = createTemMailer({ projectId: 'p', secretKey: 's', from: 'a@b.c' }, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await assert.rejects(silent.send(signInMessage('a@b.c', 'https://x', 15)), MailError);
  });

  it('writes the link as text in the HTML, never as markup', () => {
    const message = signInMessage('a@b.c', 'https://app.test/sign-in#"><script>', 15);

    assert.equal(message.html.includes('<script>'), false);
  });
});
