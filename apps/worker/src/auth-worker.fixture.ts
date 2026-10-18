import assert from 'node:assert/strict';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import { type Auth, authOptions, startAuth } from './auth.ts';
import { AUTH_CONFIG, AUTH_SECRET, CONSOLE_URL, PUBLIC_URL, make } from './auth.fixture.ts';
import type { WorkerEnv } from './env.ts';
import { type Kv, createMemoryKv } from './kv.ts';
import { createPostgresKv } from './kv-postgres.ts';
import type { MailMessage, Mailer } from './mail.ts';
import type { PgDatabase } from './postgres.ts';
import { createPostgresConnectStore, createPostgresSessionStore } from './session-postgres.ts';

/**
 * A worker with better-auth on, as the tests of its routes call it (FRU-147, FRU-149): every case goes
 * through `handleRequest`, as a browser would.
 */

export const IDENTITY_SECRET = 'an-identity-secret-of-exactly-enough-x';
export const SESSION_COOKIE = '__Secure-fruitback.session_token';
export const GITHUB = { clientId: 'the-second-app-of-github', clientSecret: 'a-secret-of-github-0123456789' };
export const GOOGLE = { clientId: 'the-client-of-google', clientSecret: 'a-secret-of-google-0123456789' };

export function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: CONSOLE_URL,
    FRUITBACK_IDENTITY_SECRET: IDENTITY_SECRET,
    // Port 1 of this machine: nothing listens there. Each case hands over its stores and its instance.
    FRUITBACK_DATABASE_URL: 'postgres://fruitback:not-a-password@127.0.0.1:1/fruitback',
    FRUITBACK_CONSOLE_URL: CONSOLE_URL,
    FRUITBACK_PUBLIC_URL: PUBLIC_URL,
    FRUITBACK_AUTH_SECRET: AUTH_SECRET,
    ...overrides,
  };
}

/** A mailer that keeps what it was asked to send. */
export function inbox(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];

  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

export type Call = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `null`: no `Origin` header. */
  origin?: string | null;
  ip?: string;
};

/** A worker with better-auth on, on the database of a case, and every request it was given. */
export async function workerOf(
  database: PgDatabase,
  more: {
    trackIp?: boolean;
    env?: Partial<WorkerEnv>;
    /** Another `handleRequest`: the one of a changed `app.ts`, for a planted violation. */
    handle?: typeof handleRequest;
    /** Where the limiter of better-auth counts. The `Kv` of the database by default, as in a worker. */
    limits?: Pick<Kv, 'incr'>;
  } = {},
) {
  await make(database);
  const accounts = createPostgresAccountStore(database);
  const sessions = createPostgresSessionStore(database);
  const connectStore = createPostgresConnectStore(database);
  const options = await authOptions(
    { ...AUTH_CONFIG, github: GITHUB, google: GOOGLE, trackIp: more.trackIp === true },
    await database.pool(),
    sessions,
    more.limits ?? createPostgresKv(database),
  );
  const auth: Auth = await startAuth(options);
  const mail = inbox();
  const kv: Kv = createMemoryKv();
  const env = envWith({ ...(more.trackIp === true ? { FRUITBACK_AUTH_TRACK_IP: '1' } : {}), ...more.env });
  const received: string[] = [];
  let ip = 0;

  const call = (path: string, init: Call = {}): Promise<Response> => {
    ip += 1;
    const url = path.startsWith('http') ? path : `${PUBLIC_URL}${path}`;
    received.push(url);
    const origin = init.origin === undefined ? CONSOLE_URL : init.origin;
    const headers: Record<string, string> = {
      ...(origin === null ? {} : { Origin: origin }),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    };

    return (more.handle ?? handleRequest)(
      new Request(url, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      env,
      {
        clientIp: init.ip ?? `198.51.100.${ip % 250}`,
        accounts,
        sessionStore: sessions,
        connectStore,
        mailer: mail,
        kv,
        auth,
      },
    );
  };

  /** The token of the last link that was sent, read after the `#` of the link, as the console reads it. */
  const lastToken = (): string => {
    const text = mail.sent.at(-1)?.text ?? '';
    const link = /https:\/\/\S+/.exec(text)?.[0] ?? '';
    assert.ok(link.startsWith(`${CONSOLE_URL}/sign-in#`), `the link is not after a # of the console: ${link}`);

    return link.slice(link.indexOf('#') + 1);
  };

  /** A link asked for and spent: the cookie of the session, as the browser sends it back. */
  const signIn = async (email: string): Promise<string> => {
    assert.equal((await call('/console/auth/email', { body: { email } })).status, 202);
    const answer = await call('/console/auth/email/redeem', { body: { token: lastToken() } });
    assert.equal(answer.status, 200, await answer.clone().text());

    return cookieOf(answer);
  };

  return { database, auth, accounts, sessions, connectStore, mail, kv, env, received, call, lastToken, signIn };
}

export function cookieOf(answer: Response): string {
  return answer.headers
    .getSetCookie()
    .filter((each) => each.startsWith(`${SESSION_COOKIE}=`))
    .map((each) => each.split(';')[0])
    .join('; ');
}
