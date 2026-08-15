import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The worker's dev port, mirrored from `playwright.config.ts` — this suite starts both servers, so
 * it knows the topology. The app itself takes the origin from `VITE_FRUITBACK_WORKER` and has no
 * business exposing a global just so a test can find it.
 */
export const WORKER_ORIGIN = 'http://localhost:8788';

/**
 * The three moves every spec makes: open a page of one's own, plant a pin, and check a pin sits on
 * an element.
 *
 * The harness these drive is the playground's, not the product's — the real capture UI is SKG-492/493
 * and the real re-anchoring is SKG-500. What the specs actually assert through it is the pipeline
 * underneath: `captureSeed`, `POST /feedback`, `GET /feedback`.
 */

/**
 * Each spec captures on its own URL. The seed's page identity is the canonical URL, so a query
 * parameter is all it takes to keep one spec's pins out of another's — the worker's in-memory store
 * lives for the whole run.
 */
export async function openPlayground(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?case=${testCase}`);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await expect(status(page)).toHaveText(/pin|^0/, { timeout: 15_000 });
}

/** Capture mode, a click on `target`, a note, send — and wait for the pin to come back. */
export async function plantPin(page: Page, target: Locator, note: string): Promise<void> {
  const before = await page.locator('[data-fb-pin]').count();

  // The launch button now lives in the widget's Shadow root and carries an emoji; Playwright's
  // selectors pierce open shadow roots, so only the name had to become a pattern.
  await page.getByRole('button', { name: /Laisser un feedback/ }).click();
  await target.click();
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill(note);
  await page.getByRole('button', { name: 'Planter' }).click();

  // The harness only writes this once the re-read has finished drawing, so it is the happens-before
  // the geometry assertions need. Counting pins alone races: the old ones are still on the page
  // while the new set is being fetched.
  await expect(status(page)).toHaveText(/^planté ·/);
  await expect(page.locator('[data-fb-pin]')).toHaveCount(before + 1);
}

/**
 * Wait until the pins on the page have been drawn again — after a redeploy, a deletion, a reload.
 * Same reason as above: without it, an assertion measures the pins from before the DOM moved.
 */
export async function waitForPins(page: Page, count: number): Promise<void> {
  await expect(status(page)).toHaveText(new RegExp(`^${count} pins?$`));
  await expect(page.locator('[data-fb-pin]')).toHaveCount(count);
}

/** Pins are found through their badge, which is the only part of the overlay that carries the note. */
export function pinFor(page: Page, note: string): Locator {
  return page.locator('[data-fb-pin]').filter({ has: page.getByRole('button', { name: new RegExp(escapeForRegExp(note.slice(0, 20))) }) });
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function badgeFor(page: Page, note: string): Locator {
  return pinFor(page, note).getByRole('button');
}

export function status(page: Page): Locator {
  return page.locator('[data-fb-dev="status"]');
}

/**
 * The assertion that matters: the pin is drawn over the element, not merely present.
 *
 * Polled, because the overlay re-measures on the next animation frame — a resize or a reflow moves
 * the element first and the pin a frame later, and a single measurement would catch the gap. One
 * pixel of tolerance: sub-pixel rounding is expected, being on the neighbouring card is not.
 */
export async function expectPinOn(pin: Locator, element: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const [pinBox, elementBox] = await Promise.all([pin.boundingBox(), element.boundingBox()]);
        if (pinBox === null || elementBox === null) return null;

        return Math.max(
          Math.abs(pinBox.x - elementBox.x),
          Math.abs(pinBox.y - elementBox.y),
          Math.abs(pinBox.width - elementBox.width),
          Math.abs(pinBox.height - elementBox.height),
        );
      },
      { message: 'the pin never settled on its element' },
    )
    .toBeLessThanOrEqual(1);
}

/**
 * The seeds the worker actually stored for this page, straight from the read path.
 *
 * The URL is rebuilt from `window.location` rather than canonicalized: every spec captures on a
 * plain `/?case=…`, which `canonicalizePageUrl` already leaves untouched. A spec that ever needs a
 * fragment or a tracking parameter has to canonicalize here, or it will look up a key nothing was
 * stored under.
 */
export async function storedSeeds(page: Page): Promise<{ note: string; source?: Record<string, unknown> }[]> {
  return page.evaluate(async (origin) => {
    const canonical = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    const response = await fetch(`${origin}/feedback?url=${encodeURIComponent(canonical)}&client=playground`);
    const { issues } = (await response.json()) as { issues: { seed: { note: string; source?: Record<string, unknown> } }[] };

    return issues.map((issue) => issue.seed);
  }, WORKER_ORIGIN);
}
