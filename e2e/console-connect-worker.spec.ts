import { type BrowserContext, type Page, expect } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * « Connect this browser » (FRU-240) from end to end: the real extension asks from its service
 * worker, as its popup will (FRU-251), the console page of this pull request answers, and a worker
 * of the Cloud on PGlite (FRU-238) decides. No stub decides an answer.
 *
 * The sample data is of nobody: `acme.dev`, invented names.
 */

type Answer = { status: number | 'cors'; body: Record<string, unknown> };

/** A call from the service worker of the extension: its origin, its CORS, no cookie of a page. */
async function fromExtension(
  worker: import('@playwright/test').Worker,
  url: string,
  body?: unknown,
  token?: string,
): Promise<Answer> {
  return worker.evaluate(
    async ({ url, body, token }) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token !== undefined) headers.Authorization = `Bearer ${token}`;
      try {
        const answer = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await answer.text();

        return { status: answer.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> };
      } catch {
        return { status: 'cors' as const, body: {} as Record<string, unknown> };
      }
    },
    { url, body, token },
  );
}

/** Signs in to the console by a link, in its own context: the workspace of the domain is made. */
async function signedIn(context: BrowserContext, worker: Worker, email: string): Promise<Page> {
  const page = await context.newPage();
  const before = (await worker.sent()).length;
  await page.goto(`${CONSOLE}/setup`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(async () => (await worker.sent()).length).toBe(before + 1);
  await page.goto(await linkIn(worker));
  await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();

  return page;
}

/** What the extension asks with: the request of the address, the claim it keeps, the word of its popup. */
type Asked = { request: string; claim: string; word: string };

async function ask(extension: import('@playwright/test').Worker, api: string): Promise<Asked> {
  const asked = await fromExtension(extension, `${api}/session/connect`, { browser: 'Chrome on macOS' });
  expect(asked.status).toBe(201);

  return asked.body as unknown as Asked;
}

/**
 * The claim of the extension, at the pace the worker asks, until it is answered: the status it ends
 * on. 202 is « nobody answered yet », and 429 `slow-down` is a claim made sooner than the interval.
 */
async function claimed(extension: import('@playwright/test').Worker, api: string, claim: string): Promise<Answer> {
  let last: Answer = { status: 0, body: {} };
  await expect
    .poll(
      async () => {
        last = await fromExtension(extension, `${api}/session/connect/claim`, { claim });

        return last.status === 202 || (last.status === 429 && last.body.error === 'slow-down');
      },
      { intervals: [5_500], timeout: 30_000 },
    )
    .toBe(false);

  return last;
}

test.describe('Connect this browser, from the extension to its session (FRU-240, FRU-238)', () => {
  let worker: Worker | undefined;

  test.afterEach(async ({ extension }) => finished(extension.context, worker));

  test('the page shows the word of the popup, and « Connect » gives the extension the sites of the account', async ({
    extension,
  }) => {
    worker = await cloudWorker();
    const api = worker.origin;
    await served(extension.context, worker);
    const page = await signedIn(extension.context, worker, 'ana@acme.dev');
    // A second workspace of the same account: the session reads the sites of both.
    const second = await page.evaluate(async (origin) => {
      const made = await fetch(`${origin}/console/workspaces`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Northwind' }),
      });

      return ((await made.json()) as { id: string }).id;
    }, WORKER_ORIGIN);
    const me = await page.evaluate(async (origin) => {
      const read = await fetch(`${origin}/console/me`, { credentials: 'include' });

      return (await read.json()) as { workspaces: { id: string; name: string }[] };
    }, WORKER_ORIGIN);
    for (const [index, workspace] of me.workspaces.entries()) {
      await page.evaluate(
        async ({ origin, id, url }) => {
          await fetch(`${origin}/console/workspaces/${id}/sites`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, visibility: 'members' }),
          });
        },
        { origin: WORKER_ORIGIN, id: workspace.id, url: `https://staging-${index}.acme.dev` },
      );
    }
    expect(me.workspaces.map((each) => each.id)).toContain(second);

    const { request, claim, word } = await ask(extension.worker, api);
    await page.goto(`${CONSOLE}/connect/${request}`);
    await expect(page.getByRole('heading', { name: 'Connect this browser' })).toBeVisible();
    // The word of the page is the word of the popup.
    await expect(page.locator('.kit-verify__word')).toHaveText(word);
    await expect(page.locator('main dl > div').first()).toHaveText('Accountana@acme.dev');
    await expect(page.locator('main dl > div').nth(2)).toContainText('Northwind');

    // Opening the page answers nothing: the extension still waits.
    expect((await fromExtension(extension.worker, `${api}/session/connect/claim`, { claim })).status).toBe(202);

    await page.getByRole('button', { name: 'Connect Chrome', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chrome is connected' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Northwind');

    const session = await claimed(extension.worker, api, claim);
    expect(session.status).toBe(200);
    const sites = await fromExtension(
      extension.worker,
      `${api}/session/sites`,
      undefined,
      String(session.body.accessToken),
    );
    expect(sites.status).toBe(200);
    const origins = (sites.body.sites as { origin: string }[]).map((each) => each.origin).sort();
    expect(origins).toEqual(['https://staging-0.acme.dev', 'https://staging-1.acme.dev']);

    // Read again, the answered request says « connected » to the account that answered it.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Chrome is connected' })).toBeVisible();
  });

  test('« Not now » refuses: the extension gets no session, and the page says so', async ({ extension }) => {
    worker = await cloudWorker();
    const api = worker.origin;
    await served(extension.context, worker);
    const page = await signedIn(extension.context, worker, 'ana@acme.dev');
    const { request, claim } = await ask(extension.worker, api);
    await page.goto(`${CONSOLE}/connect/${request}`);
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'This browser is not connected' })).toBeVisible();

    const refused = await claimed(extension.worker, api, claim);
    expect(refused).toMatchObject({ status: 410, body: { error: 'connect-refused' } });
  });

  test('two tabs on one request: one answer, and the other tab reads it', async ({ extension }) => {
    worker = await cloudWorker();
    const api = worker.origin;
    await served(extension.context, worker);
    const page = await signedIn(extension.context, worker, 'ana@acme.dev');
    const other = await extension.context.newPage();
    const { request, claim } = await ask(extension.worker, api);
    await page.goto(`${CONSOLE}/connect/${request}`);
    await other.goto(`${CONSOLE}/connect/${request}`);
    await expect(other.getByRole('button', { name: 'Connect Chrome', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Connect Chrome', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chrome is connected' })).toBeVisible();
    // The other tab still shows the question; its press meets an answered request, and reads it.
    await other.getByRole('button', { name: 'Connect Chrome', exact: true }).click();
    await expect(other.getByRole('heading', { name: 'Chrome is connected' })).toBeVisible();

    expect((await claimed(extension.worker, api, claim)).status).toBe(200);
  });

  test('another account learns nothing of a request it did not answer', async ({ extension, browser }) => {
    // Two sign-ins by a link, in two browsers.
    test.setTimeout(60_000);
    worker = await cloudWorker();
    const api = worker.origin;
    await served(extension.context, worker);
    const page = await signedIn(extension.context, worker, 'ana@acme.dev');
    const { request } = await ask(extension.worker, api);
    await page.goto(`${CONSOLE}/connect/${request}`);
    await page.getByRole('button', { name: 'Connect Chrome', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chrome is connected' })).toBeVisible();

    // Tom, in another browser, opens the same address.
    const tomContext = await browser.newContext();
    await served(tomContext, worker);
    const tom = await signedIn(tomContext, worker, 'tom@client.fr');
    await tom.goto(`${CONSOLE}/connect/${request}`);
    await expect(tom.getByRole('heading', { name: 'This request no longer works' })).toBeVisible();
    await expect(tom.locator('main')).not.toContainText('Chrome on macOS');
    await expect(tom.locator('main')).not.toContainText('ana@acme.dev');
    await finished(tomContext, undefined);
    await tomContext.close();
  });

  test('nobody signed in: the link of the mail leads back to the question, and answers nothing', async ({
    extension,
  }) => {
    worker = await cloudWorker();
    const api = worker.origin;
    await served(extension.context, worker);
    const { request, claim } = await ask(extension.worker, api);
    const page = await extension.context.newPage();
    await page.goto(`${CONSOLE}/connect/${request}`);
    await expect(page.getByRole('heading', { name: 'Sign in to connect this browser' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

    // The link opens in another tab: this one goes back to the question.
    const mail = await extension.context.newPage();
    await mail.goto(await linkIn(worker));
    await expect(page.getByRole('heading', { name: 'Connect this browser' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect Chrome', exact: true })).toBeVisible();
    // A sign-in is no answer.
    expect((await fromExtension(extension.worker, `${api}/session/connect/claim`, { claim })).status).toBe(202);
  });
});
