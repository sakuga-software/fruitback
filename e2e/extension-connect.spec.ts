import { type Page, expect } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { PLAYGROUND_ORIGIN, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The extension asks, the console approves (FRU-238), in a real Chromium with the real extension
 * loaded, against a worker of the Cloud on PGlite: the half of the worker, measured where `curl`
 * cannot measure it. The browser enforces CORS, sends the `Origin` of the extension from its service
 * worker, and sends the cookie of the console to a page of the same site.
 *
 * The extension does not speak this way yet (FRU-251 draws « Sign in to Fruitback »), and the console
 * has no screen for it yet (FRU-240): so the service worker of the extension makes the calls of the
 * extension, and the console page makes the calls of its screen, each with `fetch`, as their code
 * will. The spec of the whole way, from the popup to a note, is theirs.
 */

type Answer = { status: number | 'cors'; body: Record<string, unknown> };

/** A call from the service worker of the extension: its origin, its CORS, no cookie of a page. */
async function fromExtension(
  worker: import('@playwright/test').Worker,
  url: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<Answer> {
  return worker.evaluate(
    async ({ url, method, body, token }) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token !== undefined) headers.Authorization = `Bearer ${token}`;
      try {
        const answer = await fetch(url, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await answer.text();

        return { status: answer.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> };
      } catch {
        // The browser refused the answer, or the preflight: CORS.
        return { status: 'cors' as const, body: {} as Record<string, unknown> };
      }
    },
    { url, method: init.method, body: init.body, token: init.token },
  );
}

/** A call from a page, with its cookies: the status, or `cors` when the browser hides the answer. */
async function fromPage(
  page: Page,
  url: string,
  init: { method?: string; body?: unknown; credentials?: 'include' | 'omit' } = {},
) {
  return page.evaluate(
    async ({ url, method, body, credentials }) => {
      try {
        const answer = await fetch(url, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          credentials,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await answer.text();

        return {
          status: answer.status,
          body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
        };
      } catch {
        return { status: 'cors' as const, body: {} as Record<string, unknown> };
      }
    },
    { url, method: init.method, body: init.body, credentials: init.credentials ?? 'include' },
  );
}

/** Signs in to the console by a link: the workspace « Acme » is made. Its id. */
async function signedIn(page: Page, worker: Worker, email: string): Promise<string> {
  await page.goto(`${CONSOLE}/setup`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(async () => (await worker.sent()).length).toBe(1);
  await page.goto(await linkIn(worker));
  await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
  const me = await fromPage(page, `${WORKER_ORIGIN}/console/me`);
  const workspaces = me.body.workspaces as { id: string }[];

  return workspaces[0]?.id as string;
}

test.describe('the extension asks, the console approves, in a browser (FRU-238)', () => {
  let worker: Worker | undefined;

  test.afterEach(async ({ extension }) => finished(extension.context, worker));

  test('connects the extension to the account that approves, and only from the console', async ({ extension }) => {
    worker = await cloudWorker();
    const api = worker.origin;
    await served(extension.context, worker);
    const consolePage = await extension.context.newPage();
    const workspace = await signedIn(consolePage, worker, 'ana@acme.dev');
    const site = await fromPage(consolePage, `${WORKER_ORIGIN}/console/workspaces/${workspace}/sites`, {
      body: { url: PLAYGROUND_ORIGIN, visibility: 'members' },
    });
    expect(site.status).toBe(201);

    // A page of a site cannot start a request: the browser sends its origin, and the worker refuses it.
    const page = await extension.context.newPage();
    await page.goto(`${PLAYGROUND_ORIGIN}/?widget=off`);
    expect((await fromPage(page, `${api}/session/connect`, { body: {}, credentials: 'omit' })).status).toBe(403);

    // The extension asks, from its service worker: a preflight, then the request.
    const asked = await fromExtension(extension.worker, `${api}/session/connect`, {
      body: { browser: 'Chrome on macOS' },
    });
    expect(asked.status).toBe(201);
    const { request, claim, word, verificationUri } = asked.body as Record<string, string>;
    expect(verificationUri).toBe(`${CONSOLE}/connect/${request}`);
    expect((await fromExtension(extension.worker, `${api}/session/connect/claim`, { body: { claim } })).status).toBe(
      202,
    );

    // The console reads the request with its cookie, and shows the word of the popup.
    const shown = await fromPage(consolePage, `${WORKER_ORIGIN}/console/connect/${request}`);
    expect(shown.status).toBe(200);
    expect(shown.body.word).toBe(word);
    const account = (shown.body.account as { id: string }).id;

    // A page of the same site as the worker sends the cookie of the console too: its origin refuses it.
    const forged = await fromPage(page, `${WORKER_ORIGIN}/console/connect/${request}/approve`, {
      body: { word, account },
    });
    expect(forged.status).not.toBe(200);
    expect((await fromPage(consolePage, `${WORKER_ORIGIN}/console/connect/${request}`)).body.state).toBe('pending');
    // The extension cannot approve itself: it holds no cookie of the console.
    const itself = await fromExtension(extension.worker, `${api}/console/connect/${request}/approve`, {
      body: { word, account },
    });
    expect(itself.status).toBe('cors');
    expect((await fromPage(consolePage, `${WORKER_ORIGIN}/console/connect/${request}`)).body.state).toBe('pending');

    const approved = await fromPage(consolePage, `${WORKER_ORIGIN}/console/connect/${request}/approve`, {
      body: { word, account },
    });
    expect(approved.status).toBe(200);

    // The extension claims at its pace, and gets the session once.
    let session: Answer | undefined;
    await expect
      .poll(
        async () => {
          session = await fromExtension(extension.worker, `${api}/session/connect/claim`, { body: { claim } });

          return session.status;
        },
        { intervals: [5_500], timeout: 20_000 },
      )
      .toBe(200);
    const { accessToken, refreshToken } = (session?.body ?? {}) as Record<string, string>;
    // The same claim again, once the interval went by: spent.
    await page.waitForTimeout(5_500);
    const replay = await fromExtension(extension.worker, `${api}/session/connect/claim`, { body: { claim } });
    expect(replay.status).toBe(410);

    // The session reads the sites of the account, and a note on the site of its workspace is signed.
    const sites = await fromExtension(extension.worker, `${api}/session/sites`, { token: accessToken });
    expect(sites.status).toBe(200);
    expect(sites.body.account).toBe(true);
    const [listed] = sites.body.sites as { id: string; origin: string }[];
    expect(listed?.origin).toBe(PLAYGROUND_ORIGIN);
    const written = {
      kind: 'fruitback.note',
      v: 3,
      id: 'sd_ana_first',
      createdAt: new Date().toISOString(),
      text: 'The button is too small on a phone.',
      page: { url: `${PLAYGROUND_ORIGIN}/pricing`, path: '/pricing' },
      viewport: { width: 1440, height: 900 },
      anchor: { selector: 'main > button', tag: 'button', bounds: { xPct: 40, yPct: 60, wPct: 12, hPct: 4 } },
    };
    const note = await fromExtension(extension.worker, `${api}/feedback`, {
      body: { ...written, client: { id: listed?.id } },
      token: accessToken,
    });
    expect(note.status).toBe(201);
    const read = await fromExtension(
      extension.worker,
      `${api}/feedback?url=${encodeURIComponent(`${PLAYGROUND_ORIGIN}/pricing`)}&client=${listed?.id}`,
      { token: accessToken },
    );
    expect(read.status).toBe(200);
    const [issue] = read.body.issues as { note: { reporter?: { id?: string; verified?: boolean } } }[];
    expect(issue?.note.reporter).toMatchObject({ id: account, verified: true });
    // The control: without the token, the site of the members reads nothing.
    expect(
      (
        await fromExtension(
          extension.worker,
          `${api}/feedback?url=${encodeURIComponent(`${PLAYGROUND_ORIGIN}/pricing`)}&client=${listed?.id}`,
        )
      ).status,
    ).toBe(401);

    // My account lists the browser, and ends it: the refresh is refused after.
    const browsers = await fromPage(consolePage, `${WORKER_ORIGIN}/console/me/browsers`);
    const [connected] = browsers.body.browsers as { id: string; browser: string }[];
    expect(connected?.browser).toBe('Chrome on macOS');
    expect((await fromExtension(extension.worker, `${api}/session/refresh`, { body: { refreshToken } })).status).toBe(
      200,
    );
    const ended = await fromPage(consolePage, `${WORKER_ORIGIN}/console/me/browsers/${connected?.id}`, {
      method: 'DELETE',
    });
    expect(ended.status).toBe(204);
    const after = await fromExtension(extension.worker, `${api}/session/refresh`, { body: { refreshToken } });
    expect(after.status).toBe(401);
  });
});
