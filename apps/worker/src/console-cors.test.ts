import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONSOLE_URL, DATABASES, PUBLIC_URL, databasesOfACase } from './auth.fixture.ts';
import { workerOf } from './auth-worker.fixture.ts';

/**
 * Who may read the routes of the console from a browser (FRU-214): `consoleCors`, through
 * `handleRequest`, with the cookie of a session.
 *
 * WARNING: this check is the only one that keeps a **read**. `callerOf` asks for the `Origin` of
 * the console on a change only, and a page of the same site as the worker sends the cookie
 * (`demo.fruitback.com` is one, whatever `SameSite` says). What keeps such a page from reading the
 * account, the sites and the members of whoever visits it is that the worker answers it `403`,
 * with no `Access-Control-Allow-Origin`. The file that held this went with the sign-in of before
 * (FRU-150), and nothing failed when the refusal was taken out.
 */

const { opening } = databasesOfACase();

/** The headers a browser reads before it hands an answer to a script of another origin. */
function cors(answer: Response): Record<string, string | null> {
  return {
    origin: answer.headers.get('Access-Control-Allow-Origin'),
    credentials: answer.headers.get('Access-Control-Allow-Credentials'),
  };
}

const NONE = { origin: null, credentials: null };

/** Origins that are not the console, each with why somebody would try it. */
const OTHERS: Record<string, string> = {
  'another site': 'https://evil.example',
  // The same site as the worker: the browser sends it the cookie.
  'a page of the same site': 'https://demo.fruitback.test',
  'the worker itself': new URL(PUBLIC_URL).origin,
  // A sandboxed frame, a `data:` page, a redirect across origins.
  'the origin « null »': 'null',
  'the console over http': CONSOLE_URL.replace('https://', 'http://'),
  'the console on another port': `${CONSOLE_URL}:8443`,
  'a host that starts with the console': `${CONSOLE_URL}.evil.example`,
  'a host that ends with the console': CONSOLE_URL.replace('https://', 'https://evil-'),
  'the console with a path': `${CONSOLE_URL}/`,
};

for (const { label, open, skip } of DATABASES) {
  describe(`the routes of the console answer the console, and no other origin, on ${label} (FRU-214)`, { skip }, () => {
    /** A worker, somebody signed in with a workspace and a site, and every route that reads something. */
    async function signedIn() {
      const worker = await workerOf(await opening(open));
      const cookie = await worker.signIn('alice@acme.dev');
      const headers = { Cookie: cookie };
      const made = await worker.call('/console/workspaces', { body: { name: 'Acme' }, headers });
      const { id } = (await made.json()) as { id: string };
      const added = await worker.call(`/console/workspaces/${id}/sites`, {
        body: { url: 'https://staging.acme.dev' },
        headers,
      });
      assert.equal(added.status, 201);
      const reads = [
        '/console/me',
        `/console/workspaces/${id}/sites`,
        '/console/sessions',
        `/console/auth/organization/list-members?organizationId=${id}`,
        '/auth/providers',
      ];

      return { worker, headers, id, reads };
    }

    it('answers the console with credentials, on every route that reads', async () => {
      const { worker, headers, reads } = await signedIn();

      for (const path of reads) {
        const answer = await worker.call(path, { headers, origin: CONSOLE_URL });
        assert.equal(answer.status, 200, path);
        assert.deepEqual(cors(answer), { origin: CONSOLE_URL, credentials: 'true' }, path);
        // The answer is of one origin: a cache must not hand it to another.
        assert.match(answer.headers.get('Vary') ?? '', /Origin/, path);
      }
    });

    for (const [name, origin] of Object.entries(OTHERS)) {
      it(`refuses ${name}, with the cookie of a session, on every route that reads`, async () => {
        const { worker, headers, reads } = await signedIn();

        for (const path of reads) {
          const answer = await worker.call(path, { headers, origin });
          assert.equal(answer.status, 403, path);
          assert.deepEqual(cors(answer), NONE, path);
          const body = await answer.text();
          assert.deepEqual(JSON.parse(body), { error: 'origin-not-allowed' }, path);
          // Nothing of the person is in an answer that a script could read by another way.
          assert.doesNotMatch(body, /alice|Acme|staging/, path);
        }
        // The preflight of a change is refused the same way: no header that allows it.
        const preflight = await worker.call('/console/workspaces', {
          method: 'OPTIONS',
          origin,
          headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
        });
        assert.equal(preflight.status, 403);
        assert.deepEqual(cors(preflight), NONE);
        assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), null);
      });
    }

    it('names no origin for a request that has none: a navigation, not a script of another page', async () => {
      const { worker, headers } = await signedIn();

      // No `Origin`: the browser applies no CORS, and no page of another origin reads the answer.
      const answer = await worker.call('/console/me', { headers, origin: null });
      assert.equal(answer.status, 200);
      assert.deepEqual(cors(answer), NONE);
    });

    it('allows the console a preflight for JSON, and no header that carries a token', async () => {
      const { worker } = await signedIn();

      const preflight = await worker.call('/console/workspaces', {
        method: 'OPTIONS',
        origin: CONSOLE_URL,
        headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      });
      assert.equal(preflight.status, 204);
      assert.deepEqual(cors(preflight), { origin: CONSOLE_URL, credentials: 'true' });
      assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, POST, DELETE, OPTIONS');
      // FRU-150: the console sends the cookie and no token. A browser refuses a call of the console
      // that carries `Authorization`, which is how a console that held a token again would be seen.
      assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
      assert.match(preflight.headers.get('Vary') ?? '', /Origin/);
      // No wildcard anywhere: a browser refuses `*` with credentials, and a worker must not rely on that.
      for (const [, value] of preflight.headers) assert.notEqual(value.trim(), '*');
    });
  });
}
