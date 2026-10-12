import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The address of a site, typed in the console (FRU-167): on the Sites screen and at step 3 of the
 * set-up. A host with no scheme is read as `https://`, and what is not an address gets the sentence
 * of the console instead of the bubble of the browser.
 *
 * The worker is answered by stubs, which keep what the console sent.
 */
const CONSOLE = 'http://localhost:5178';
const SENTENCE = 'Paste the full address of the site, starting with https://.';

/** Answers the console, and returns the addresses it asked the worker to add. */
async function stubWorker(page: Page): Promise<string[]> {
  const sent: string[] = [];
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/console/session/refresh') return json({ accessToken: 'token' });
    if (pathname === '/console/me') return json(me);
    if (pathname === '/console/workspaces/w1/sites') {
      if (request.method() === 'GET') return json({ sites: [] });
      const { url } = request.postDataJSON() as { url: string };
      sent.push(url);

      return json({ id: `s${sent.length}`, origin: new URL(url).origin, visibility: 'members' }, 201);
    }

    return route.fulfill({ status: 204 });
  });

  return sent;
}

const screens = [
  { name: 'the Sites screen', path: '/w/w1/sites', submit: 'Add the site' },
  { name: 'step 3 of the set-up', path: '/setup?step=site', submit: 'Continue' },
] as const;

for (const screen of screens) {
  test(`on ${screen.name}, a host with no scheme is added as https`, async ({ page }) => {
    const sent = await stubWorker(page);
    await page.goto(`${CONSOLE}${screen.path}`);
    const field = page.getByRole('textbox', { name: 'Site address' });

    // Not a field of type url, which the browser judges, but still the keyboard of an address on a phone.
    await expect(field).toHaveAttribute('type', 'text');
    await expect(field).toHaveAttribute('inputmode', 'url');
    await field.fill('staging.acme.dev');
    await page.getByRole('button', { name: screen.submit, exact: true }).click();
    await expect.poll(() => sent).toEqual(['https://staging.acme.dev']);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test(`on ${screen.name}, what is not an address gets the sentence of the console`, async ({ page }) => {
    const sent = await stubWorker(page);
    await page.goto(`${CONSOLE}${screen.path}`);
    const field = page.getByRole('textbox', { name: 'Site address' });

    await field.fill('pas une adresse');
    await page.getByRole('button', { name: screen.submit, exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(SENTENCE);
    // The browser judged nothing, so it showed no bubble, and the console asked the worker nothing.
    expect(await field.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
    expect(sent).toEqual([]);
    // What was typed is still there.
    await expect(field).toHaveValue('pas une adresse');

    // An address with its scheme goes as it was typed, and the sentence goes away.
    await field.fill('http://localhost:5177');
    await page.getByRole('button', { name: screen.submit, exact: true }).click();
    await expect.poll(() => sent).toEqual(['http://localhost:5177']);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
