import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';

/**
 * The safeguards of a page that anybody writes on (FRU-704), as a visitor with no account meets them:
 * the line of the card « Safeguards » set on the worker, then the widget in a browser.
 *
 * The widget as `init` assembles it, on the site `guards` of the dev worker (`POST /__dev/guards`): a
 * site of its own, so the other specs, which all send to `playground` from the same address, are
 * never counted. What the console sends for each line is held by `console-site-access.spec.ts`, and
 * what the worker does with each value by its own tests (`visitor-notes-limit.test.ts`).
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const SITE = 'guards';

async function guards(body: Record<string, unknown>): Promise<void> {
  const answer = await fetch(`${WORKER_ORIGIN}/__dev/guards`, { method: 'POST', body: JSON.stringify(body) });
  expect(answer.status, await answer.clone().text()).toBe(200);
}

async function mount(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, clientId }) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId,
      }),
    { endpoint: WORKER_ORIGIN, clientId: SITE },
  );
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
}

/** A note on the card of the latte, written and sent as a visitor does. */
async function write(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  // The site goes back to « No limit » and holds nothing, so a spec run after this one starts clean.
  await guards({ visitorNotesPerHour: 0, holdVisitorNotes: false, keepNoteVersions: true, botCheck: false });
});

test('a visitor leaves the notes of the hour, then the widget asks them to wait, with their text kept (FRU-704)', async ({
  page,
}) => {
  // The smallest limit the console offers.
  await guards({ visitorNotesPerHour: 5 });
  await mount(page, `/?widget=off&case=${caseOf('visitor-limit')}`);
  for (let index = 1; index <= 5; index += 1) {
    await write(page, `Note ${index} d’un visiteur`);
    await expect(page.locator('[data-fruitback-pin]')).toHaveCount(index);
  }

  const refused = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/feedback' && response.request().method() === 'POST',
  );
  await write(page, 'Une sixième note dans l’heure');
  const answer = await refused;
  expect(answer.status()).toBe(429);
  expect(await answer.json()).toEqual({ error: 'visitor-limit', perHour: 5 });

  await expect(
    page.getByText(
      'You sent as many notes as this site takes in an hour. Your text is still here. Send it again later.',
    ),
  ).toBeVisible();
  await expect(page.getByPlaceholder('What should change?')).toHaveValue('Une sixième note dans l’heure');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(5);

  // The site says « No limit » now: the same text goes, from the same composer.
  await guards({ visitorNotesPerHour: 0 });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(6);
});

test('a note of a visitor waits for a member on a site that holds them, and the widget says so (FRU-704)', async ({
  page,
}) => {
  await guards({ visitorNotesPerHour: 0, holdVisitorNotes: true });
  await mount(page, `/?widget=off&case=${caseOf('visitor-held')}`);
  const sent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/feedback' && response.request().method() === 'POST',
  );

  await write(page, 'Une note qu’un membre relit d’abord');

  const answer = await sent;
  expect(answer.status()).toBe(202);
  expect(await answer.json()).toMatchObject({ held: true });
  await expect(page.getByText('Sent for review')).toBeVisible();
  await expect(
    page.getByText('The team of this site reviews notes before they go on. Its pin shows here once approved.'),
  ).toBeVisible();
  // In no tracker yet: no pin on the page, after a reload too.
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  await mount(page, `/?widget=off&case=${caseOf('visitor-held')}`);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  await guards({ holdVisitorNotes: false });
});

/** The thread of the one pin of the page. */
async function openThread(page: Page) {
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.locator('[data-fruitback-pin]').getByRole('button').first().click();

  return page.getByRole('dialog', { name: /Note 1/ });
}

test('a visitor who edits their note on a site that keeps every version is told the team keeps the text of before (FRU-704)', async ({
  page,
}) => {
  const KEPT = 'The team of this site keeps the text of before in the history of the note.';
  await guards({ visitorNotesPerHour: 0, holdVisitorNotes: false, keepNoteVersions: true });
  const path = `/?widget=off&case=${caseOf('visitor-versions')}`;
  await mount(page, path);
  await write(page, 'Une note qu’on modifie ensuite');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  await mount(page, path);
  const thread = await openThread(page);
  await thread.getByRole('button', { name: 'More actions on your note' }).click();
  await thread.getByRole('menuitem', { name: 'Edit the text' }).click();
  await expect(thread.getByText(KEPT)).toBeVisible();
  await thread.getByRole('textbox', { name: 'Your note' }).fill('Une note modifiée, gardée pour l’équipe');
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/text'));
  await thread.getByRole('button', { name: 'Save' }).click();
  expect((await saved).status()).toBe(200);
  await expect(thread.getByText('Saved')).toBeVisible();

  // The site keeps no version now: the same form says nothing of it.
  await guards({ keepNoteVersions: false });
  await mount(page, path);
  const again = await openThread(page);
  await again.getByRole('button', { name: 'More actions on your note' }).click();
  await again.getByRole('menuitem', { name: 'Edit the text' }).click();
  await expect(again.getByRole('textbox', { name: 'Your note' })).toBeVisible();
  await expect(again.getByText(KEPT)).toHaveCount(0);
  await guards({ keepNoteVersions: true });
});

/**
 * A fake of Cloudflare's `api.js` (FRU-704): no call leaves this machine. It draws a box with a button
 * in the slot the widget gives, and a press gives the dummy token of the keys of test of Cloudflare,
 * which the dev worker takes with its secret of test (`verifyTestTurnstile`).
 */
const FAKE_TURNSTILE = `
window.turnstile = {
  render(slot, options) {
    const box = document.createElement('div');
    box.setAttribute('data-fake-turnstile', options.sitekey);
    box.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px;border:1px solid #d4d4d8;border-radius:4px;font:13px system-ui;background:#fafafa;color:#18181b';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Verify you are human';
    button.addEventListener('click', () => options.callback('XXXX.DUMMY.TOKEN.XXXX'));
    box.append(button, document.createTextNode('Fake Turnstile (test)'));
    slot.append(box);
    return 'fake-1';
  },
  remove() {},
};
`;
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

test('a visitor passes the bot check in the composer before their first note, and their next note asks nothing (FRU-704)', async ({
  page,
}) => {
  await guards({ visitorNotesPerHour: 0, holdVisitorNotes: false, botCheck: true });
  const loaded: string[] = [];
  await page.route('https://challenges.cloudflare.com/**', (route) => {
    loaded.push(route.request().url());

    return route.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE });
  });
  const posts: { status: number; token: string | null }[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/feedback' || response.request().method() !== 'POST') return;
    posts.push({ status: response.status(), token: response.request().headers()['x-fruitback-turnstile'] ?? null });
  });
  await mount(page, `/?widget=off&case=${caseOf('visitor-bot-check')}`);
  // Nothing of Cloudflare at the mount.
  expect(loaded).toEqual([]);

  await write(page, 'Une première note, après la vérification');

  const composer = page.locator('[data-fruitback-composer]');
  await expect(composer.locator('[data-fruitback-challenge-text]')).toHaveText(
    'This site checks that a person sends this note. Your note goes once the check passes.',
  );
  await expect(composer.locator('[data-fruitback-challenge]')).toBeVisible();
  await expect(composer.locator('[data-fake-turnstile="1x00000000000000000000AA"]')).toBeVisible();
  await expect(page.getByPlaceholder('What should change?')).toHaveValue('Une première note, après la vérification');
  await composer.getByRole('button', { name: 'Verify you are human' }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  expect(loaded).toEqual([TURNSTILE_URL]);
  expect(posts).toEqual([
    { status: 403, token: null },
    { status: 201, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  ]);

  // The next note of this browser goes at once: the worker keeps that it passed.
  await write(page, 'Une deuxième note, sans vérification');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);
  expect(posts.at(-1)).toEqual({ status: 201, token: null });
  await guards({ botCheck: false });
});

test('a check that does not load says so, and keeps the text of the visitor (FRU-704)', async ({ page }) => {
  await guards({ visitorNotesPerHour: 0, holdVisitorNotes: false, botCheck: true });
  // A page that blocks challenges.cloudflare.com, as a strict CSP or an extension does.
  await page.route('https://challenges.cloudflare.com/**', (route) => route.abort('blockedbyclient'));
  await mount(page, `/?widget=off&case=${caseOf('visitor-bot-check-blocked')}`);

  await write(page, 'Une note que la vérification bloque');

  await expect(
    page.getByText(
      'The check that a person sends this note did not load. Your text is still here. Try again, or tell the site’s team.',
    ),
  ).toBeVisible();
  await expect(page.getByPlaceholder('What should change?')).toHaveValue('Une note que la vérification bloque');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  await guards({ botCheck: false });
});
