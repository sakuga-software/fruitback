import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * A web component that draws after the widget placed its pins (FRU-582).
 *
 * A document observer does not see into a shadow root, and the upgrade of a custom element defined
 * late makes no mutation record. What only a browser shows: a real `customElements.define` after
 * `init`, a shadow root drawn later still, and the pin that goes from orphan to sure on the button
 * of the component, with no reload and nothing resized.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

/**
 * A `<late-card>` and a button of the page, side by side, at the top of `<body>`, which React leaves
 * alone when it hydrates. The host keeps its box while it is empty, so `#plain` does not slide into
 * the box of the button and get found there by position (measured: it did, with no size).
 */
function insertSection(): void {
  const section = document.createElement('section');
  section.id = 'late-section';
  section.style.cssText = 'display:flex;align-items:center;gap:24px;height:96px;padding:0 48px';
  section.innerHTML =
    '<late-card id="late" style="display:block;width:180px;height:44px"></late-card>' +
    '<button id="plain" type="button" style="font:600 16px system-ui;padding:10px 18px">Sans composant</button>';
  document.body.prepend(section);
}

/** Defines `<late-card>`: an open shadow root attached at the upgrade, drawn `delay` ms later. */
function defineLateCard(delay: number): void {
  customElements.define(
    'late-card',
    class extends HTMLElement {
      connectedCallback(): void {
        if (this.shadowRoot !== null) return;
        const root = this.attachShadow({ mode: 'open' });
        const draw = () => {
          root.innerHTML =
            '<style>button{font:600 16px system-ui;padding:10px 18px;border-radius:8px;border:0;background:#1c1917;color:#fff}</style>' +
            '<button class="buy" type="button">Acheter tard</button>';
        };
        if (delay === 0) draw();
        else setTimeout(draw, delay);
      }
    },
  );
}

async function mountWidget(page: Page): Promise<void> {
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
}

async function open(page: Page, address: string): Promise<void> {
  await page.goto(address);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.evaluate(insertSection);
}

async function note(page: Page, target: ReturnType<Page['locator']>, text: string): Promise<void> {
  await page.locator('[data-fruitback-host-launch]').click();
  await target.click();
  await page.locator('[data-fruitback-composer] textarea').fill(text);
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
}

type Stored = { id: string; anchor: { hosts?: string[] } };

async function storedNotes(page: Page): Promise<Stored[]> {
  return page.evaluate(async (origin) => {
    const canonical = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    const response = await fetch(`${origin}/feedback?url=${encodeURIComponent(canonical)}&client=playground`);
    const { issues } = (await response.json()) as { issues: { note: Stored }[] };

    return issues.map((issue) => issue.note);
  }, WORKER_ORIGIN);
}

test('a pin in a web component defined after the widget mounts goes from orphan to sure', async ({ page }) => {
  const address = `/?widget=off&case=${caseOf('shadow-late')}`;
  const inComponent = page.locator('#late button.buy');
  const plain = page.locator('#plain');

  // Written while the component is drawn: one note inside it, and the control on the page.
  await open(page, address);
  await page.evaluate(defineLateCard, 0);
  await mountWidget(page);
  await note(page, inComponent, 'Le bouton du composant tardif');
  await note(page, plain, 'Le bouton de la page');

  const notes = await storedNotes(page);
  const late = notes.find((stored) => stored.anchor.hosts !== undefined);
  const control = notes.find((stored) => stored.anchor.hosts === undefined);
  expect(late?.anchor.hosts).toEqual(['#late']);
  expect(control).toBeDefined();

  // Read again with the component not defined: the widget mounts first.
  await open(page, page.url());
  await mountWidget(page);
  const latePin = page.locator(`[data-fruitback-pin="${late?.id}"]`);
  const controlPin = page.locator(`[data-fruitback-pin="${control?.id}"]`);
  await expect(latePin).toHaveAttribute('data-fruitback-strategy', 'orphan');
  await expect(controlPin).toHaveAttribute('data-fruitback-strategy', 'selector');
  await expect(controlPin).toHaveAttribute('data-fruitback-confident', 'true');

  // Defined now, drawn 400 ms after its upgrade. Nothing in the document changes, nothing resizes.
  await page.evaluate(defineLateCard, 400);
  await expect(latePin).toHaveAttribute('data-fruitback-strategy', 'selector', { timeout: 5_000 });
  await expect(latePin).toHaveAttribute('data-fruitback-confident', 'true');
  await expect(controlPin).toHaveAttribute('data-fruitback-strategy', 'selector');

  // The frame of the pin stands 5 px off its element on every side (`overlay.ts`).
  await expect
    .poll(async () => {
      const [pinBox, box] = await Promise.all([latePin.boundingBox(), inComponent.boundingBox()]);
      if (pinBox === null || box === null) return null;

      return Math.max(Math.abs(pinBox.x - (box.x - 5)), Math.abs(pinBox.y - (box.y - 5)));
    })
    .toBeLessThanOrEqual(1);
});
