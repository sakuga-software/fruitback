import { type Page, expect, test } from '@playwright/test';
import { caseOf, WORKER_ORIGIN } from './pin.ts';

/**
 * A page whose root says `font-size: 62.5%` (FRU-680): the widget keeps every size it has on a page
 * at 100 %.
 *
 * In a Shadow root, `1rem` is the font size of the `<html>` of the page, so a size in rem shrinks
 * with it: 16 px became 10 px in Chromium. The sheets of the widget write px, and the Tailwind sheet
 * holds no rem (`tailwind-sheet.test.ts`). This spec measures the result: the dock, the composer,
 * the menu of the capture and the area, each part at 62.5 % against the same part at 100 %.
 *
 * The widget is mounted from the IIFE, with a capture of the host and `canAttach`, as in
 * `attachments.spec.ts`, so the menu of the capture and the area exist.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page): Promise<void> {
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    (globalThis as unknown as { Fruitback: { init(options: unknown): unknown } }).Fruitback.init({
      endpoint,
      clientId: 'playground',
      locale: 'en',
      label: 'Leave a note',
      captureVisible: async () => ({ name: 'page.png', type: 'image/png', size: 4, base64: 'iVBORw==' }),
      transport: async (request: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
        const answer = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        const body = await answer.text();
        if (request.method === 'GET' && answer.ok) {
          return { ok: true, status: 200, body: JSON.stringify({ ...JSON.parse(body), canAttach: true }) };
        }

        return { ok: answer.ok, status: answer.status, body };
      },
    });
  }, WORKER_ORIGIN);
}

/** The parts that are measured, by a selector of the Shadow root. */
const PARTS = [
  '.fruitback-dock',
  '[data-fruitback-host-launch]',
  '.fruitback-composer',
  '.fruitback-composer textarea',
  '[data-fruitback-area] .fruitback-area-bar',
  '.fruitback-area-help',
  '.fruitback-area-take',
  '.fruitback-area-cancel',
  '[data-fruitback-area-size]',
  '[data-fruitback-area-box]',
] as const;

type Measure = Record<string, string>;

/** The box and the type of each part that is on the page now. */
async function measure(page: Page, selectors: readonly string[]): Promise<Record<string, Measure>> {
  return page.evaluate((selectors) => {
    const root = document.querySelector('[data-fruitback-host]')?.shadowRoot;
    const out: Record<string, Record<string, string>> = {};
    for (const selector of selectors) {
      const element = root?.querySelector(selector);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      out[selector] = {
        width: box.width.toFixed(2),
        height: box.height.toFixed(2),
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        padding: style.padding,
        borderWidth: style.borderWidth,
        borderRadius: style.borderRadius,
        gap: style.gap,
        boxShadow: style.boxShadow,
        outline: `${style.outlineStyle} ${style.outlineWidth}`,
      };
    }

    return out;
  }, selectors);
}

/** The widget on a page whose root has this font size, open to the composer, then to the area. */
async function partsAt(page: Page, rootFontSize: string): Promise<Record<string, Measure>> {
  await page.goto(`/?case=${caseOf(`root-font-${rootFontSize}`)}&widget=off`);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = size;
  }, rootFontSize);
  // The control: the page itself follows its root, so a size in rem would follow it too.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
    rootFontSize === '62.5%' ? '10px' : '16px',
  );
  await mount(page);

  const resting = await measure(page, PARTS);
  await page.getByRole('button', { name: 'Leave a note' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  const composer = page.getByRole('dialog', { name: 'New note', exact: true });
  await expect(composer).toBeVisible();
  const writing = await measure(page, PARTS);

  await composer.getByRole('button', { name: 'Take a screenshot' }).click();
  await composer.getByRole('menuitem', { name: 'Capture an area' }).click();
  const area = page.getByRole('dialog', { name: 'Choose an area of the page' });
  await expect(area).toBeVisible();
  // The size of the area is written once the rectangle moves.
  await page.keyboard.press('ArrowRight');
  const choosing = await measure(page, PARTS);
  await page.keyboard.press('Escape');
  await expect(area).toBeHidden();

  return { ...prefixed('resting', resting), ...prefixed('writing', writing), ...prefixed('choosing', choosing) };
}

function prefixed(step: string, parts: Record<string, Measure>): Record<string, Measure> {
  return Object.fromEntries(Object.entries(parts).map(([selector, value]) => [`${step} ${selector}`, value]));
}

test('on a page whose root is at 62.5 %, the dock, the composer and the area keep the sizes they have at 100 %', async ({
  page,
}) => {
  const normal = await partsAt(page, '100%');
  const small = await partsAt(page, '62.5%');

  // A guard over an empty set passes: every part was on the page at its step.
  expect(Object.keys(normal)).toEqual(
    expect.arrayContaining([
      'resting .fruitback-dock',
      'writing .fruitback-composer',
      'choosing [data-fruitback-area] .fruitback-area-bar',
      'choosing .fruitback-area-take',
      'choosing [data-fruitback-area-size]',
    ]),
  );
  expect(small).toEqual(normal);
  // The bar of the area at 100 %: 13 px, as the mock-up writes it.
  expect(normal['choosing [data-fruitback-area] .fruitback-area-bar']?.fontSize).toBe('13px');
});
