import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';

/**
 * A note typed in the widget never sets off a shortcut of the page (FRU-726). On the console, « C »
 * opens « New task »: each « c » of a note opened it, and the note lost its « c ».
 *
 * The page here has a letter shortcut at the four places a site listens: the document and the
 * window, in each phase. Each one tests `event.target`, as most sites and libraries do, and the
 * target of a key typed in the Shadow root is the host element. Each one cancels the key, so a « c »
 * that reaches one is missing from the note. One more, on the window in the capture phase but set
 * before the widget, is the case no widget can cover: it is measured, not hidden.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';
const NOTE = 'Cette carte cache le prix, ce qui coince';

type Shortcuts = { heard: string[] };

/** The shortcuts of the page, on « c » and « / », that stay out of the fields of the page. */
function listen(where: string): void {
  const box = globalThis as unknown as { shortcuts?: Shortcuts };
  box.shortcuts ??= { heard: [] };
  const shortcuts = box.shortcuts;
  const take = (name: string) => (event: Event) => {
    const key = event as KeyboardEvent;
    if (key.key !== 'c' && key.key !== '/') return;
    const target = event.target as Element | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    shortcuts.heard.push(`${name} ${key.key}`);
  };
  if (where === 'early') {
    window.addEventListener('keydown', take('window capture, before the widget'), true);

    return;
  }
  document.addEventListener('keydown', take('document'));
  document.addEventListener('keydown', take('document capture'), true);
  window.addEventListener('keydown', take('window'));
  window.addEventListener('keydown', take('window capture'), true);
}

const heard = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { shortcuts: Shortcuts }).shortcuts.heard.splice(0));

async function mount(page: Page, testCase: string, { early = false } = {}): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  if (early) await page.evaluate(listen, 'early');
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
  await page.evaluate(listen, 'late');
}

const field = (page: Page) => page.getByPlaceholder('What should change?');
const composer = (page: Page) => page.getByRole('dialog', { name: 'New note' });

async function openComposer(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await expect(field(page)).toBeFocused();
}

test('a note typed in the widget keeps its « c » and its « / », and the page hears none of them', async ({ page }) => {
  await mount(page, 'host-shortcuts');
  await openComposer(page);

  await field(page).pressSequentially(`${NOTE} / fin`);

  await expect(field(page)).toHaveValue(`${NOTE} / fin`);
  expect(await heard(page)).toEqual([]);

  // The control: with the focus out of the widget, the page keeps its shortcuts, at all four places.
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeHidden();
  await page.locator('h1').click();
  await page.keyboard.press('c');
  expect((await heard(page)).sort()).toEqual(['document c', 'document capture c', 'window c', 'window capture c']);
});

test('the keys of the widget still work: Escape, Cmd or Ctrl and Enter, a paste, an IME', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:5177' });
  await mount(page, 'host-shortcuts-keys');
  await openComposer(page);

  // A paste from the keyboard.
  await page.evaluate(() => navigator.clipboard.writeText('collé : c'));
  await page.keyboard.press('ControlOrMeta+V');
  await expect(field(page)).toHaveValue('collé : c');

  // An IME composes a word, and the field takes it whole.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: 'かきく' });
  await expect(field(page)).toHaveValue('collé : cかきく');

  // Escape closes the composer and keeps the text (FRU-311).
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeHidden();
  await openComposer(page);
  await expect(field(page)).toHaveValue('collé : cかきく');

  // Cmd or Ctrl and Enter sends.
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(composer(page)).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  expect(await heard(page)).toEqual([]);
});

test('a shortcut on the window in the capture phase, set before the widget, still hears the key', async ({ page }) => {
  // The limit of `key-guard.ts`, measured: nothing runs before the first listener of the window.
  await mount(page, 'host-shortcuts-early', { early: true });
  await openComposer(page);

  await field(page).pressSequentially('c');

  expect(await heard(page)).toEqual(['window capture, before the widget c']);
});
