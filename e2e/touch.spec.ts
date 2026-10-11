import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The widget on a touch screen (FRU-157), as `init` assembles it, at 390 px.
 *
 * Three things a DOM emulator cannot see: the label of the launch button on a device that has no
 * Escape key, the size of every control, and the computed size of the fields, under which iOS
 * Safari zooms the page.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** WCAG 2.5.8 (AA). */
const MINIMUM = 24;
/** Apple's and Google's guides, for the controls the ticket names. */
const COMFORTABLE = 44;

async function mount(page: Page, testCase: string, locale = 'en-US'): Promise<void> {
  await page.goto(`/?widget=off&case=${testCase}-${test.info().retry}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ([endpoint, language]) =>
      (globalThis as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: language,
      }),
    [WORKER_ORIGIN, locale],
  );
}

type Box = { name: string; width: number; height: number };

/**
 * Every visible control of the widget, and its rectangle. A box or a radio inside a label is
 * measured by its label, because a tap on the label toggles it.
 */
function controls(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')?.shadowRoot;
    if (!root) throw new Error('the widget is not mounted');
    const selector = 'button, a[href], input, textarea, select, [role="button"], [tabindex]:not([tabindex="-1"])';

    return [...root.querySelectorAll<HTMLElement>(selector)]
      .filter((element) => element.checkVisibility({ visibilityProperty: true }))
      .map((element) => {
        const target = element.matches('input') ? (element.closest('label') ?? element) : element;
        const rect = target.getBoundingClientRect();
        const name =
          element.getAttribute('aria-label') ?? (target.textContent?.trim() || element.className || element.tagName);

        return { name: `${element.tagName.toLowerCase()} "${name}"`, width: rect.width, height: rect.height };
      })
      .filter((box) => box.width > 0 && box.height > 0);
  });
}

function tooSmall(boxes: Box[]): string[] {
  return boxes
    .filter((box) => box.width < MINIMUM - 0.5 || box.height < MINIMUM - 0.5)
    .map((box) => `${box.name}: ${Math.round(box.width)} × ${Math.round(box.height)}`);
}

async function expectAtLeast(page: Page, name: string | RegExp, size: number): Promise<void> {
  const box = await page
    .getByRole('button', { name, exact: typeof name === 'string' })
    .first()
    .boundingBox();
  expect(box, `${String(name)} is not on screen`).not.toBeNull();
  expect.soft(Math.round(box?.width ?? 0), `${String(name)}: width`).toBeGreaterThanOrEqual(size);
  expect.soft(Math.round(box?.height ?? 0), `${String(name)}: height`).toBeGreaterThanOrEqual(size);
}

const fontSize = (page: Page, placeholder: string) =>
  page.getByPlaceholder(placeholder).evaluate((field) => getComputedStyle(field).fontSize);

test.describe('on a touch screen at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the launch button says what a tap does, in English and in French', async ({ page }) => {
    await mount(page, 'touch-label');
    const launch = page.getByRole('button', { name: 'Leave feedback' });
    await launch.tap();
    await expect(launch).toHaveText('Cancel');
    await launch.tap();
    await expect(launch).toHaveText('Leave feedback');

    await mount(page, 'touch-label-fr', 'fr-FR');
    const lancer = page.getByRole('button', { name: 'Laisser un feedback' });
    await lancer.tap();
    await expect(lancer).toHaveText('Annuler');
    await expect(lancer).not.toHaveText(/Esc|Échap/);
  });

  test('no control is under 24 × 24 px, and the fields are at 16 px', async ({ page }) => {
    await mount(page, 'touch-targets');
    const seen: Box[] = [];
    const measure = async () => seen.push(...(await controls(page)));

    // The control: a planted button of 10 px must be found, or an empty list proves nothing.
    await page.evaluate(() => {
      const planted = document.createElement('button');
      planted.id = 'planted';
      planted.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 10px; height: 10px;';
      document.querySelector('[data-fruitback-host]')?.shadowRoot?.append(planted);
    });
    expect(tooSmall(await controls(page))).toEqual(['button "planted": 10 × 10']);
    await page.evaluate(() =>
      document.querySelector('[data-fruitback-host]')?.shadowRoot?.getElementById('planted')?.remove(),
    );

    // The dock.
    await measure();
    await expectAtLeast(page, 'Leave feedback', COMFORTABLE);
    await expectAtLeast(page, 'Show every note of this page', COMFORTABLE);
    await expectAtLeast(page, 'Open Fruitback settings', COMFORTABLE);

    // The composer, with the name open.
    await page.getByRole('button', { name: 'Leave feedback' }).tap();
    await page.locator('[data-testid="card-espresso"] .add').tap();
    await page.getByRole('button', { name: 'Add my name (optional)' }).tap();
    await measure();
    expect(await fontSize(page, 'What is wrong here?')).toBe('16px');
    expect(await fontSize(page, 'Your name')).toBe('16px');
    await page.getByPlaceholder('What is wrong here?').fill('A note from a phone');
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: 'Leave a note' })).toBeHidden({ timeout: 5_000 });

    // The thread of the pin.
    await page
      .getByRole('button', { name: /A note from a phone/ })
      .first()
      .tap();
    const thread = page.getByRole('dialog', { name: /^Feedback / });
    await expect(thread).toBeVisible();
    await measure();
    await expectAtLeast(page, 'Close', COMFORTABLE);
    await page.getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(thread).toHaveCount(0);

    // The list.
    await page.getByRole('button', { name: 'Show every note of this page' }).tap();
    await expect(page.getByRole('dialog', { name: 'Every note of this page' })).toBeVisible();
    await measure();
    await expectAtLeast(page, 'Close the list', COMFORTABLE);
    await page.getByRole('button', { name: 'Close the list' }).tap();

    // The settings.
    await page.getByRole('button', { name: 'Open Fruitback settings' }).tap();
    await expect(page.getByRole('dialog', { name: 'Fruitback settings' })).toBeVisible();
    await measure();

    expect(seen.length).toBeGreaterThan(12);
    expect(tooSmall(seen)).toEqual([]);
  });
});

test('with a mouse and a keyboard, the launch button still says Escape', async ({ page }) => {
  await mount(page, 'touch-desktop');
  const launch = page.getByRole('button', { name: 'Leave feedback' });
  await launch.click();
  await expect(launch).toHaveText('Esc to cancel');
});
