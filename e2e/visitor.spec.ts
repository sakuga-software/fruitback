import { type Request, expect, test } from '@playwright/test';
import { CONSOLE } from './cloud-worker.ts';
import { WORKER_ORIGIN, openPlayground, pinFor, plantPin, waitForPins } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * A visitor with no account leaves a note, in a browser, on a worker that has accounts (FRU-224).
 *
 * Each worker of the suite keeps its sites in a database (`dev-worker.fixture.ts`): the one on 8788
 * has the site `playground`, which everyone reads, and the one on 8789 has it for its members only.
 * The page of this spec has no extension, no session and no cookie, as the page of a visitor. What
 * a browser adds to `visitor.test.ts` of the worker is CORS: a page of another origin must not read
 * the answer, and `curl` cannot show that.
 */

const feedback = (request: Request): boolean => new URL(request.url()).pathname === '/feedback';

test('a visitor plants a pin and finds it again, and no request carried a credential', async ({ page }) => {
  const sent: Request[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(WORKER_ORIGIN) && feedback(request)) sent.push(request);
  });

  await openPlayground(page, 'visitor');
  const button = page.locator('[data-testid="card-latte"] .add');
  await plantPin(page, button, 'Une note de quelqu’un qui n’a pas de compte');
  await page.reload();
  await waitForPins(page, 1);
  await expect(pinFor(page, 'Une note de quelqu’un')).toBeVisible();

  // The write, and a read before and after it: the control of the loop below.
  expect(sent.map((request) => request.method())).toEqual(expect.arrayContaining(['POST', 'GET']));
  for (const request of sent) {
    const headers = await request.allHeaders();
    expect(headers.authorization, `${request.method()} ${request.url()}`).toBeUndefined();
    expect(headers.cookie, `${request.method()} ${request.url()}`).toBeUndefined();
    expect(headers.origin ?? new URL(page.url()).origin).toBe(new URL(page.url()).origin);
  }
  expect(await page.context().cookies(WORKER_ORIGIN)).toEqual([]);
});

test('a page of another origin reads no note of the site, and plants none', async ({ page, baseURL }) => {
  await openPlayground(page, 'visitor-elsewhere');
  await plantPin(page, page.locator('#checkout-cta'), 'Une note que seul ce site lit');
  const address = new URL(page.url());
  address.hash = '';
  const read = `${WORKER_ORIGIN}/feedback?url=${encodeURIComponent(address.toString())}&client=playground`;

  // The control: the page of the site reads its note with the same request.
  const own = await page.evaluate(async (url) => {
    const response = await fetch(url);

    return { status: response.status, notes: ((await response.json()) as { issues: unknown[] }).issues.length };
  }, read);
  expect(own).toEqual({ status: 200, notes: 1 });

  // The console of the suite is a page of another origin, in the same browser.
  expect(new URL(CONSOLE).origin).not.toBe(new URL(baseURL ?? '').origin);
  const elsewhere = await page.context().newPage();
  await elsewhere.goto(`${CONSOLE}/sign-in`);
  const refused = await elsewhere.evaluate(
    async ({ url, worker }) => {
      const attempt = async (input: string, init?: RequestInit): Promise<string> => {
        try {
          const response = await fetch(input, init);

          return `answered ${response.status}: ${await response.text()}`;
        } catch (error) {
          // What a browser gives a page whose origin the worker did not allow: no status, no body.
          return `failed: ${error instanceof TypeError ? 'TypeError' : String(error)}`;
        }
      };

      return {
        read: await attempt(url),
        write: await attempt(`${worker}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: { id: 'playground' } }),
        }),
      };
    },
    { url: read, worker: WORKER_ORIGIN },
  );
  expect(refused).toEqual({ read: 'failed: TypeError', write: 'failed: TypeError' });

  // What the worker answered, which the page could not read: the same request, sent from here with
  // the `Origin` of that page. Without this, a worker that was down would pass the lines above.
  const answered = await fetch(read, { headers: { Origin: new URL(CONSOLE).origin } });
  expect(answered.status).toBe(403);
  expect(answered.headers.get('access-control-allow-origin')).toBeNull();
  // And nothing of that page was kept.
  const after = await (await fetch(read, { headers: { Origin: new URL(baseURL ?? '').origin } })).json();
  expect((after as { issues: unknown[] }).issues).toHaveLength(1);
});

test('on a site that its members read, a visitor reads no note', async ({ page }) => {
  await openPlayground(page, 'visitor-members');
  const address = new URL(page.url());
  address.hash = '';

  const answers = await page.evaluate(
    async ({ url, workers }) =>
      Promise.all(
        workers.map(async (worker) => {
          const response = await fetch(`${worker}/feedback?url=${encodeURIComponent(url)}&client=playground`);

          return response.status;
        }),
      ),
    { url: address.toString(), workers: [AUTHENTICATED_WORKER_ORIGIN, WORKER_ORIGIN] },
  );

  // The same page, the same site id, two workers: only the visibility of the site differs.
  expect(answers).toEqual([401, 200]);
});
