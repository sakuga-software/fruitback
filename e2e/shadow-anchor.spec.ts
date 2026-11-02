import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * A note on an element inside a web component (FRU-580), on the widget as `init` assembles it.
 *
 * No selector reaches into a shadow root from the document. So the anchor names the hosts, one
 * selector for each level, and the widget follows them when it resolves the note. What only a
 * browser shows: real custom elements, react-grab pointing through their open shadow roots, and the
 * pin drawn on the element after a reload.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

/**
 * Two `<acme-promo>` with an open shadow root, each holding an `<acme-price>` with one of its own:
 * two levels, and two instances, so the hosts have to be told apart. Put at the top of `<body>`,
 * which React leaves alone when it hydrates.
 */
function defineComponents(): void {
  const define = (name: string, html: string) => {
    if (customElements.get(name) !== undefined) return;
    customElements.define(
      name,
      class extends HTMLElement {
        connectedCallback(): void {
          if (this.shadowRoot !== null) return;
          this.attachShadow({ mode: 'open' }).innerHTML = html;
        }
      },
    );
  };
  define(
    'acme-price',
    '<style>button{font:600 16px system-ui;padding:10px 18px;border-radius:8px;border:0;background:#1c1917;color:#fff}</style>' +
      '<button class="buy" type="button">Acheter</button>',
  );
  define(
    'acme-promo',
    '<style>:host{display:block;padding:16px;margin:12px;border:1px dashed #a8a29e;border-radius:12px}</style>' +
      '<p style="margin:0 0 8px;font:14px system-ui">Offre du moment</p><acme-price></acme-price>',
  );
  const section = document.createElement('section');
  section.id = 'promos';
  section.style.cssText = 'display:flex;gap:12px;padding:12px 48px';
  section.innerHTML = '<acme-promo></acme-promo><acme-promo></acme-promo>';
  document.body.prepend(section);
}

async function mount(page: Page, address: string): Promise<void> {
  await page.goto(address);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.evaluate(defineComponents);
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

type StoredAnchor = { hosts?: string[]; selector: string };

async function storedAnchors(page: Page): Promise<StoredAnchor[]> {
  return page.evaluate(async (origin) => {
    const canonical = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    const response = await fetch(`${origin}/feedback?url=${encodeURIComponent(canonical)}&client=playground`);
    const { issues } = (await response.json()) as { issues: { note: { anchor: StoredAnchor } }[] };

    return issues.map((issue) => issue.note.anchor);
  }, WORKER_ORIGIN);
}

test('a note on an element in a web component pins on that element after a reload', async ({ page }) => {
  const address = `/?widget=off&case=${caseOf('shadow-anchor')}`;
  await mount(page, address);
  // Playwright's CSS goes through open shadow roots: this is the button of the second price.
  const target = page.locator('#promos acme-promo').nth(1).locator('button.buy');

  await page.locator('[data-fruitback-host-launch]').click();
  await target.click();
  await page.locator('[data-fruitback-composer] textarea').fill('Le prix de la deuxième offre');
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });

  // What the worker stored: two hosts, and a selector that the document alone does not match.
  const [anchor] = await storedAnchors(page);
  expect(anchor?.hosts).toHaveLength(2);
  expect(await page.evaluate((selector) => document.querySelectorAll(selector).length, anchor?.selector ?? '')).toBe(0);

  await mount(page, page.url());
  const pin = page.locator('[data-fruitback-pin]');
  await expect(pin).toHaveCount(1);
  await expect(pin).toHaveAttribute('data-fruitback-strategy', 'selector');
  await expect(pin).toHaveAttribute('data-fruitback-confident', 'true');

  // The frame of the pin stands 5 px off its element on every side (`overlay.ts`), and not on the
  // first instance of the component.
  await expect
    .poll(async () => {
      const [pinBox, box] = await Promise.all([pin.boundingBox(), target.boundingBox()]);
      if (pinBox === null || box === null) return null;

      return Math.max(Math.abs(pinBox.x - (box.x - 5)), Math.abs(pinBox.y - (box.y - 5)));
    })
    .toBeLessThanOrEqual(1);
});
